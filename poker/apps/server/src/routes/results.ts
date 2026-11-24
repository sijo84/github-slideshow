/**
 * Game results.
 *
 * GET /api/games/:id/results  (signed in; the game's host or an invited player)
 *   200 { results: { userId: string, name: string, place: number, prize: number }[] }
 *     tournament: the stored final standings (tournament_results), ordered by place;
 *     cash game: one entry per player who played a hand, place by the sum of their hand
 *     nets (highest first, equal nets share a place), prize always 0.
 *     results is [] when there is nothing yet.
 *   400 bad id · 401 not signed in · 403 neither host nor invited · 404 unknown game
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ResultEntry } from '@poker/protocol';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';

const Params = z.object({ id: z.uuid() });

function userId(req: FastifyRequest): string {
  if (req.user === undefined) throw Object.assign(new Error('Not signed in'), { statusCode: 401 });
  return req.user.id;
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/games/:id/results', { preHandler: requireUser }, async (req, reply) => {
    const me = userId(req);
    const { id: gameId } = Params.parse(req.params);

    const game = await pool.query<{ host: string; kind: string | null }>(
      `select host, settings->>'kind' as kind from games where id = $1`,
      [gameId],
    );
    const row = game.rows[0];
    if (row === undefined) return reply.code(404).send({ error: 'Game not found' });
    if (row.host !== me) {
      const invited = await pool.query('select 1 from game_invites where game_id = $1 and user_id = $2', [gameId, me]);
      if (invited.rowCount === 0) return reply.code(403).send({ error: 'You are not invited to this game' });
    }

    if (row.kind === 'tournament') {
      const { rows } = await pool.query<{ user_id: string; display_name: string; place: number; prize: number }>(
        `select t.user_id, u.display_name, t.place, t.prize
           from tournament_results t join users u on u.id = t.user_id
          where t.game_id = $1 order by t.place, u.display_name, t.user_id`,
        [gameId],
      );
      const results: ResultEntry[] = rows.map((r) => ({ userId: r.user_id, name: r.display_name, place: r.place, prize: r.prize }));
      return { results };
    }

    const { rows } = await pool.query<{ user_id: string; display_name: string; net: number }>(
      `select p.user_id, u.display_name, sum(p.net)::bigint as net
         from hand_players p join hands h on h.id = p.hand_id join users u on u.id = p.user_id
        where h.game_id = $1 group by p.user_id, u.display_name
        order by net desc, u.display_name, p.user_id`,
      [gameId],
    );
    const results: ResultEntry[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.display_name,
      place: 1 + rows.filter((o) => o.net > r.net).length,
      prize: 0,
    }));
    return { results };
  });
}
