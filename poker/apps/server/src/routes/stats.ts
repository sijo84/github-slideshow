/**
 * Stats routes (require a signed-in user; mounted under /api).
 *
 * type PlayerStats = { hands: number; vpip: number; pfr: number; af: number; wtsd: number;
 *                      wonAtShowdown: number; netChips: number }   (see packages/engine/src/stats.ts)
 *
 * GET /api/stats/:userId
 *   200 {
 *     user: { id: string; displayName: string; avatarUrl: string },
 *     stats: PlayerStats,
 *     tournamentsPlayed: number,
 *     tournamentsWon: number,        // tournament_results rows with place = 1
 *     scope: 'all' | 'shared'
 *   }
 *   scope 'all'    — the viewer is the user: every hand and tournament the user played.
 *   scope 'shared' — the viewer is an accepted friend: only the user's hands and tournament
 *                    results in games where the viewer also played at least one hand or which
 *                    the viewer hosts.
 *   400 { error }  :userId is not a UUID
 *   401 { error }  not signed in
 *   403 { error: 'You can only see stats of your friends' }  neither self nor an accepted friend
 *   404 { error: 'No user found' }
 *
 * Hole cards and raw hand records are never returned.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { computeStats, type HandRecord } from '@poker/engine';
import { z } from 'zod';
import { requireUser, type SessionUser } from '../auth/session.js';
import { avatarUrlFor } from '../storage/avatars.js';
import { areFriends } from './friends.js';

const Params = z.object({ userId: z.uuid() });

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

/**
 * SQL predicate on a games alias `g`: true when the game is in scope for viewer $2 looking at
 * user $1. $3 = true means the viewer is the user (everything is in scope).
 */
const GAME_IN_SCOPE = `(
  $3::boolean
  or g.host = $2
  or exists (select 1 from hands vh join hand_players vp on vp.hand_id = vh.id
              where vh.game_id = g.id and vp.user_id = $2)
)`;

export default async function (app: FastifyInstance): Promise<void> {
  const pool = app.deps.pool;

  app.get('/stats/:userId', { preHandler: requireUser }, async (req, reply) => {
    const viewer = currentUser(req).id;
    const { userId } = Params.parse(req.params);

    const found = await pool.query<{ id: string; display_name: string; avatar_path: string | null }>(
      'select id, display_name, avatar_path from users where id = $1',
      [userId],
    );
    const user = found.rows[0];
    if (!user) return reply.code(404).send({ error: 'No user found' });

    const self = viewer === userId;
    if (!self && !(await areFriends(pool, viewer, userId))) {
      return reply.code(403).send({ error: 'You can only see stats of your friends' });
    }

    const params = [userId, viewer, self];
    // Hole cards are dropped in SQL; computeStats needs only events and playerIds.
    const hands = await pool.query<{ record: HandRecord }>(
      `select h.record - 'hole' as record
         from hands h
         join hand_players hp on hp.hand_id = h.id and hp.user_id = $1
         join games g on g.id = h.game_id
        where ${GAME_IN_SCOPE}
        order by h.started_at, h.game_id, h.hand_number`,
      params,
    );
    const records = hands.rows.map((r) => ({ ...r.record, hole: {} }));
    const stats = computeStats(records, userId);

    const tournaments = await pool.query<{ played: number; won: number }>(
      `select count(*)::int as played, (count(*) filter (where tr.place = 1))::int as won
         from tournament_results tr
         join games g on g.id = tr.game_id
        where tr.user_id = $1 and ${GAME_IN_SCOPE}`,
      params,
    );
    const t = tournaments.rows[0] ?? { played: 0, won: 0 };

    return {
      user: { id: user.id, displayName: user.display_name, avatarUrl: avatarUrlFor(user) },
      stats,
      tournamentsPlayed: t.played,
      tournamentsWon: t.won,
      scope: self ? 'all' : 'shared',
    };
  });
}
