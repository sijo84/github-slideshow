/**
 * Wallet routes (play-money chips only; there is no purchase path).
 *
 * GET /api/wallet  (signed in)
 *   200 { balance: number, entries: { id: number, amount: number, reason: string, createdAt: string }[] }
 *   entries are the wallet's last 50 ledger entries, newest first (createdAt is ISO 8601);
 *   balance 0 and entries [] when the user has no wallet yet.
 *
 * POST /api/games/:id/grant  (signed in, game host only)  body { userId: uuid, amount: integer 1..1000000 }
 *   200 { balance: number }  the target's new wallet balance
 *   400 bad input, or the target is neither the host nor invited to the game
 *   401 not signed in · 403 not the host · 404 unknown game
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { grant, walletBalance } from '../wallet/ledger.js';

const GrantParams = z.object({ id: z.uuid() });
const GrantBody = z.object({
  userId: z.uuid(),
  amount: z.number().int().min(1).max(1_000_000),
});

function userId(req: FastifyRequest): string {
  if (req.user === undefined) throw Object.assign(new Error('Not signed in'), { statusCode: 401 });
  return req.user.id;
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/wallet', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { rows } = await pool.query<{ id: number; amount: number; reason: string; created_at: Date }>(
      `select e.id, e.amount, e.reason, e.created_at
         from ledger_accounts a join ledger_entries e on e.account_id = a.id
        where a.kind = 'wallet' and a.user_id = $1 and a.game_id is null
        order by e.created_at desc, e.id desc
        limit 50`,
      [me],
    );
    return {
      balance: await walletBalance(pool, me),
      entries: rows.map((r) => ({ id: r.id, amount: r.amount, reason: r.reason, createdAt: r.created_at.toISOString() })),
    };
  });

  app.post('/games/:id/grant', { preHandler: requireUser }, async (req, reply) => {
    const me = userId(req);
    const { id: gameId } = GrantParams.parse(req.params);
    const body = GrantBody.parse(req.body);

    const game = await pool.query<{ host: string }>('select host from games where id = $1', [gameId]);
    const host = game.rows[0]?.host;
    if (host === undefined) return reply.code(404).send({ error: 'Game not found' });
    if (host !== me) return reply.code(403).send({ error: 'Only the host can grant chips' });

    if (body.userId !== host) {
      const invited = await pool.query('select 1 from game_invites where game_id = $1 and user_id = $2', [gameId, body.userId]);
      if (invited.rowCount === 0) return reply.code(400).send({ error: 'That player is not in this game' });
    }

    await grant(pool, body.userId, body.amount, 'host grant');
    return { balance: await walletBalance(pool, body.userId) };
  });
}
