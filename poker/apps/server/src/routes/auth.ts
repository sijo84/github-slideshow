/*
 * Auth and invite routes (all under /api).
 *
 * type User = { id: string; email: string; displayName: string; avatarUrl: string }
 *
 * POST /auth/register { email, password, displayName, inviteCode? }
 *   201 User (sets the `sid` cookie)
 *   400 { error } bad input · 403 { error: 'A valid invite code is required' } (invite mode)
 *   409 { error: 'That email is already registered' }
 * POST /auth/login { email, password }
 *   200 User (sets a new `sid` cookie; the request's old session, if any, is destroyed)
 *   401 { error: 'Invalid email or password' }
 * POST /auth/logout
 *   200 { ok: true } (clears the cookie; also when not signed in)
 * GET /auth/me (signed in)
 *   200 User · 401 { error: 'Not signed in' }
 * POST /invites (signed in)
 *   201 { code: string }
 * GET /invites (signed in)
 *   200 { invites: { code: string; used: boolean; createdAt: string }[] } newest first
 *
 * POST /auth/register and POST /auth/login are rate limited to config.authRateLimitMax requests per minute per IP
 * (429 { error }); the other routes fall under the global limit only.
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  deviceIdFrom,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
} from '../auth/session.js';
import { avatarUrlFor } from '../storage/avatars.js';
import { grant } from '../wallet/ledger.js';

const SIGNUP_CHIPS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .max(254, { error: 'Email is too long' })
  .regex(EMAIL_RE, { error: 'Enter a valid email address' });

const registerBody = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required' })
    .min(10, { error: 'Password must be at least 10 characters' })
    .max(200, { error: 'Password must be at most 200 characters' }),
  displayName: z
    .string({ error: 'Display name is required' })
    .trim()
    .min(2, { error: 'Display name must be 2 to 24 characters' })
    .max(24, { error: 'Display name must be 2 to 24 characters' }),
  inviteCode: z.string().max(200).optional(),
});

const loginBody = z.object({
  email: z.string({ error: 'Email is required' }).trim().toLowerCase().max(254, { error: 'Email is too long' }),
  password: z.string({ error: 'Password is required' }).max(200, { error: 'Password is too long' }),
});

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_path: string | null;
}

interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
}

function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name, avatarUrl: avatarUrlFor(row) };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function userId(req: FastifyRequest): string {
  if (!req.user) throw httpError(401, 'Not signed in');
  return req.user.id;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

const INVALID_LOGIN = 'Invalid email or password';

// Verified against when the email is unknown, so both failures take similar time.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });
  return dummyHash;
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool, config } = app.deps;
  const authLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: '1 minute' } };

  app.post('/auth/register', { config: authLimit }, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const inviteMode = config.registration === 'invite';
    if (inviteMode && !body.inviteCode) {
      return reply.code(403).send({ error: 'A valid invite code is required' });
    }
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });

    const client = await pool.connect();
    let user: UserRow;
    try {
      await client.query('begin');
      let inserted: UserRow | undefined;
      try {
        const res = await client.query<UserRow>(
          `insert into users (email, password_hash, display_name) values ($1, $2, $3)
           returning id, email, display_name, avatar_path`,
          [body.email, passwordHash, body.displayName],
        );
        inserted = res.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          await client.query('rollback');
          return reply.code(409).send({ error: 'That email is already registered' });
        }
        throw err;
      }
      if (!inserted) throw new Error('insert into users returned no row');
      if (inviteMode) {
        const used = await client.query('update invite_codes set used_by = $1 where code = $2 and used_by is null', [
          inserted.id,
          body.inviteCode,
        ]);
        if (used.rowCount !== 1) {
          await client.query('rollback');
          return reply.code(403).send({ error: 'A valid invite code is required' });
        }
      }
      await client.query('commit');
      user = inserted;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await grant(pool, user.id, SIGNUP_CHIPS, 'signup');
    const session = await createSession(pool, user.id, req.ip, deviceIdFrom(req));
    setSessionCookie(reply, config, session);
    return reply.code(201).send(toPublicUser(user));
  });

  app.post('/auth/login', { config: authLimit }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const { rows } = await pool.query<UserRow & { password_hash: string }>(
      'select id, email, display_name, avatar_path, password_hash from users where email = $1',
      [body.email],
    );
    const row = rows[0];
    let ok = false;
    if (row) {
      ok = await argon2.verify(row.password_hash, body.password).catch(() => false);
    } else {
      await argon2.verify(await getDummyHash(), body.password).catch(() => false);
    }
    if (!row || !ok) {
      return reply.code(401).send({ error: INVALID_LOGIN });
    }
    const old = req.cookies[SESSION_COOKIE];
    if (old) await destroySession(pool, old);
    const session = await createSession(pool, row.id, req.ip, deviceIdFrom(req));
    setSessionCookie(reply, config, session);
    return toPublicUser(row);
  });

  app.post('/auth/logout', async (req, reply) => {
    const value = req.cookies[SESSION_COOKIE];
    if (value) await destroySession(pool, value);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireUser }, async (req, reply) => {
    const { rows } = await pool.query<UserRow>('select id, email, display_name, avatar_path from users where id = $1', [
      userId(req),
    ]);
    const row = rows[0];
    if (!row) return reply.code(401).send({ error: 'Not signed in' });
    return toPublicUser(row);
  });

  app.post('/invites', { preHandler: requireUser }, async (req, reply) => {
    const code = randomBytes(16).toString('base64url');
    await pool.query('insert into invite_codes (code, created_by) values ($1, $2)', [code, userId(req)]);
    return reply.code(201).send({ code });
  });

  app.get('/invites', { preHandler: requireUser }, async (req) => {
    const { rows } = await pool.query<{ code: string; used: boolean; created_at: Date }>(
      `select code, used_by is not null as used, created_at from invite_codes
        where created_by = $1 order by created_at desc, code`,
      [userId(req)],
    );
    return { invites: rows.map((r) => ({ code: r.code, used: r.used, createdAt: r.created_at.toISOString() })) };
  });
}
