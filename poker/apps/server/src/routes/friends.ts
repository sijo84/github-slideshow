/**
 * Friends routes (all require a signed-in user; mounted under /api).
 *
 * type FriendUser = { id: string; displayName: string; avatarUrl: string }
 *
 * GET    /api/friends
 *   200 { friends: FriendUser[], incoming: FriendUser[], outgoing: FriendUser[] }
 *       friends: accepted friendships in either direction; incoming: pending requests to me;
 *       outgoing: pending requests I sent. Each list is sorted by display name.
 *
 * POST   /api/friends/requests   body { email: string } | { userId: string }  (exactly one)
 *   201 { status: 'pending' }     request created (the addressee gets a 'friendRequest' notification)
 *   200 { status: 'accepted' }    they had already sent me a request, so it is now accepted
 *   400 { error }                 bad body, or "You can't add yourself"
 *   404 { error: 'No user found' }
 *   409 { error }                 already friends, or my request to them is already pending
 *
 * POST   /api/friends/requests/:userId/accept
 *   200 { status: 'accepted' }    404 if :userId has no pending request to me
 *
 * POST   /api/friends/requests/:userId/decline
 *   200 { ok: true }              deletes the pending request from :userId to me; 404 if none
 *
 * DELETE /api/friends/:userId
 *   200 { ok: true }              removes an accepted friendship (either direction) or cancels my
 *                                 own pending request to :userId; 404 if nothing matched
 *
 * Any :userId that is not a UUID → 400. Not signed in → 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireUser, type SessionUser } from '../auth/session.js';
import { avatarUrlFor } from '../storage/avatars.js';

interface FriendUser {
  id: string;
  displayName: string;
  avatarUrl: string;
}

interface FriendRow {
  list: 'friends' | 'incoming' | 'outgoing';
  id: string;
  display_name: string;
  avatar_path: string | null;
}

const UserIdParams = z.object({ userId: z.uuid() });

const RequestBody = z.union([
  z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email()) }),
  z.strictObject({ userId: z.uuid() }),
]);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** True if `a` and `b` have an accepted friendship in either direction (status is 'pending' or 'accepted'). */
export async function areFriends(db: Pool | PoolClient, a: string, b: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from friendships
      where status <> 'pending'
        and ((requester = $1 and addressee = $2) or (requester = $2 and addressee = $1))
      limit 1`,
    [a, b],
  );
  return rows.length > 0;
}

export default async function (app: FastifyInstance): Promise<void> {
  const pool = app.deps.pool;

  app.get('/friends', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { rows } = await pool.query<FriendRow>(
      `select x.list, u.id, u.display_name, u.avatar_path
         from (
           select case when f.status <> 'pending' then 'friends'
                       when f.addressee = $1 then 'incoming'
                       else 'outgoing' end as list,
                  case when f.requester = $1 then f.addressee else f.requester end as other
             from friendships f
            where f.requester = $1 or f.addressee = $1
         ) x
         join users u on u.id = x.other
        order by lower(u.display_name), u.display_name, u.id`,
      [me],
    );
    const result: Record<FriendRow['list'], FriendUser[]> = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      result[row.list].push({ id: row.id, displayName: row.display_name, avatarUrl: avatarUrlFor(row) });
    }
    return result;
  });

  app.post('/friends/requests', { preHandler: requireUser }, async (req, reply) => {
    const user = currentUser(req);
    const body = RequestBody.parse(req.body);

    const found =
      'email' in body
        ? await pool.query<{ id: string }>('select id from users where lower(email) = $1', [body.email])
        : await pool.query<{ id: string }>('select id from users where id = $1', [body.userId]);
    const target = found.rows[0];
    if (!target) return reply.code(404).send({ error: 'No user found' });
    if (target.id === user.id) return reply.code(400).send({ error: "You can't add yourself" });

    const client = await pool.connect();
    try {
      await client.query('begin');
      // Serialise concurrent requests between the same pair (either direction), so two people
      // adding each other at once end up with one accepted row, not two pending rows.
      const [lo, hi] = user.id < target.id ? [user.id, target.id] : [target.id, user.id];
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`friend:${lo}:${hi}`]);

      const { rows } = await client.query<{ requester: string; status: string }>(
        `select requester, status from friendships
          where (requester = $1 and addressee = $2) or (requester = $2 and addressee = $1)`,
        [user.id, target.id],
      );
      if (rows.some((r) => r.status === 'accepted')) {
        await client.query('rollback');
        return reply.code(409).send({ error: 'You are already friends' });
      }
      if (rows.some((r) => r.requester === user.id)) {
        await client.query('rollback');
        return reply.code(409).send({ error: 'Friend request already sent' });
      }
      if (rows.some((r) => r.requester === target.id)) {
        await client.query(
          `update friendships set status = $3
            where requester = $1 and addressee = $2 and status = 'pending'`,
          [target.id, user.id, 'accepted'],
        );
        await client.query('commit');
        return reply.code(200).send({ status: 'accepted' });
      }

      await client.query(`insert into friendships (requester, addressee, status) values ($1, $2, 'pending')`, [
        user.id,
        target.id,
      ]);
      await client.query(
        `insert into notifications (user_id, kind, text, link) values ($1, 'friendRequest', $2, '/friends')`,
        [target.id, `${user.displayName} sent you a friend request`],
      );
      await client.query('commit');
      return reply.code(201).send({ status: 'pending' });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      if (isUniqueViolation(err)) return reply.code(409).send({ error: 'Friend request already sent' });
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/friends/requests/:userId/accept', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const { userId } = UserIdParams.parse(req.params);
    const res = await pool.query(
      `update friendships set status = 'accepted'
        where requester = $1 and addressee = $2 and status = 'pending'`,
      [userId, me],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: 'No pending request from this user' });
    return { status: 'accepted' };
  });

  app.post('/friends/requests/:userId/decline', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const { userId } = UserIdParams.parse(req.params);
    const res = await pool.query(
      `delete from friendships where requester = $1 and addressee = $2 and status = 'pending'`,
      [userId, me],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: 'No pending request from this user' });
    return { ok: true };
  });

  app.delete('/friends/:userId', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const { userId } = UserIdParams.parse(req.params);
    const res = await pool.query(
      `delete from friendships
        where (status <> 'pending'
               and ((requester = $1 and addressee = $2) or (requester = $2 and addressee = $1)))
           or (status = 'pending' and requester = $1 and addressee = $2)`,
      [me, userId],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: 'No friendship or request with this user' });
    return { ok: true };
  });
}
