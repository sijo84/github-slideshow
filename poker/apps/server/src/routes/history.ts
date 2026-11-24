import type { Card, HandEvent, HandRecord, SeatIndex } from '@poker/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { redact } from '../realtime/tableManager.js';
import { avatarUrlFor } from '../storage/avatars.js';

/*
 * Hand history and the end-of-game fairness reveal (F1). All routes need a session (401 otherwise);
 * every error body is { error: string }; non-uuid ids and bad query values are 400.
 *
 * GET /api/hands?gameId=<uuid>&limit=<1..100, default 50>&before=<ISO timestamp>
 *   → { hands: HandSummary[] }
 *   Hands I played (I have a hand_players row) or of games I host, newest first (started_at desc).
 *   `before` is a cursor: only hands with started_at strictly earlier. `gameId` filters to one game.
 *   HandSummary = {
 *     id: string, gameId: string, gameName: string, handNumber: number,
 *     startedAt: string (ISO), endedAt: string (ISO),
 *     potTotal: number,                 // sum of every potAwarded amount
 *     myNet: number | null,             // null when I did not play the hand (host only)
 *     winners: { seat: number, name: string, handName: string | null }[],   // from potAwarded, one per seat
 *     board: Card[],                    // dealt board cards (public)
 *   }
 *
 * GET /api/hands/:id → { hand: RedactedHand }      403 unless I played it or host the game; 404 unknown
 *   RedactedHand = {
 *     handId, gameId, handNumber, startedAt, endedAt, board: Card[], playerIds: Record<seat, userId>,
 *     events: HandEvent[],      // redacted like live play: other seats' dealHole have cards: []; showCards kept
 *     hole: Record<seat, Card[]>,   // ONLY my own seat ({} when I did not play) — never other seats, not even for the host
 *     mySeat: number | null,
 *     players: { seat: number, userId: string, name: string, avatarUrl: string }[],   // by seat
 *   }
 *
 * GET /api/games/:id/fairness   (host, invited users, or anyone who played in the game; others 403; unknown 404)
 *   409 { error: 'Seeds are revealed when the game ends' } unless the game status is 'finished'.
 *   → { hands: { handId, handNumber, commitment: string, serverSeed: string, saltKey: string,
 *                clientSeeds: string[] }[] }   ordered by handNumber
 */

export interface HandSummary {
  id: string;
  gameId: string;
  gameName: string;
  handNumber: number;
  startedAt: string;
  endedAt: string;
  potTotal: number;
  myNet: number | null;
  winners: { seat: SeatIndex; name: string; handName: string | null }[];
  board: Card[];
}

export interface RedactedHand {
  handId: string;
  gameId: string;
  handNumber: number;
  startedAt: string;
  endedAt: string;
  board: Card[];
  playerIds: Record<SeatIndex, string>;
  events: HandEvent[];
  hole: Record<SeatIndex, Card[]>;
  mySeat: SeatIndex | null;
  players: { seat: SeatIndex; userId: string; name: string; avatarUrl: string }[];
}

export interface FairnessHand {
  handId: string;
  handNumber: number;
  commitment: string;
  serverSeed: string;
  saltKey: string;
  clientSeeds: string[];
}

const listQuery = z.object({
  gameId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});
const idParams = z.object({ id: z.uuid() });

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function userId(req: FastifyRequest): string {
  if (!req.user) throw httpError(401, 'Not signed in');
  return req.user.id;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface UserRow {
  id: string;
  display_name: string;
  avatar_path: string | null;
}

async function usersById(pool: Pool, ids: string[]): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await pool.query<UserRow>('select id, display_name, avatar_path from users where id = any($1::uuid[])', [unique]);
  return new Map(rows.map((r) => [r.id, r]));
}

function seatEntries(playerIds: Record<SeatIndex, string>): [SeatIndex, string][] {
  return Object.entries(playerIds)
    .map(([seat, id]): [SeatIndex, string] => [Number(seat), id])
    .sort((a, b) => a[0] - b[0]);
}

function summarise(record: HandRecord, names: Map<string, UserRow>): { potTotal: number; winners: HandSummary['winners'] } {
  let potTotal = 0;
  const winners: HandSummary['winners'] = [];
  const seen = new Set<SeatIndex>();
  for (const e of record.events) {
    if (e.type !== 'potAwarded') continue;
    for (const amount of e.amounts) potTotal += amount;
    for (const seat of e.seats) {
      if (seen.has(seat)) continue;
      seen.add(seat);
      const uid = record.playerIds[seat];
      const name = uid !== undefined ? (names.get(uid)?.display_name ?? '') : '';
      winners.push({ seat, name, handName: e.handName ?? null });
    }
  }
  return { potTotal, winners };
}

export default async function (app: FastifyInstance): Promise<void> {
  const pool = app.deps.pool;

  app.get('/hands', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const q = listQuery.parse(req.query);
    const params: unknown[] = [me];
    let where = '(mp.user_id is not null or g.host = $1)';
    if (q.gameId !== undefined) {
      params.push(q.gameId);
      where += ` and h.game_id = $${params.length}`;
    }
    if (q.before !== undefined) {
      params.push(q.before);
      where += ` and h.started_at < $${params.length}::timestamptz`;
    }
    params.push(q.limit);
    const { rows } = await pool.query<{
      id: string;
      game_id: string;
      game_name: string;
      hand_number: number;
      record: HandRecord;
      started_at: Date;
      ended_at: Date;
      my_net: number | string | null;
    }>(
      `select h.id, h.game_id, g.name as game_name, h.hand_number, h.record, h.started_at, h.ended_at, mp.net as my_net
         from hands h
         join games g on g.id = h.game_id
         left join hand_players mp on mp.hand_id = h.id and mp.user_id = $1
        where ${where}
        order by h.started_at desc, h.id desc
        limit $${params.length}`,
      params,
    );
    const names = await usersById(
      pool,
      rows.flatMap((r) => Object.values(r.record.playerIds ?? {})),
    );
    const hands: HandSummary[] = rows.map((r) => {
      const { potTotal, winners } = summarise(r.record, names);
      return {
        id: r.id,
        gameId: r.game_id,
        gameName: r.game_name,
        handNumber: r.hand_number,
        startedAt: iso(r.started_at),
        endedAt: iso(r.ended_at),
        potTotal,
        myNet: r.my_net === null ? null : Number(r.my_net),
        winners,
        board: [...(r.record.board ?? [])],
      };
    });
    return { hands };
  });

  app.get('/hands/:id', { preHandler: requireUser }, async (req, reply) => {
    const me = userId(req);
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query<{
      game_id: string;
      hand_number: number;
      record: HandRecord;
      started_at: Date;
      ended_at: Date;
      host: string;
      my_seat: number | null;
    }>(
      `select h.game_id, h.hand_number, h.record, h.started_at, h.ended_at, g.host,
              (select p.seat from hand_players p where p.hand_id = h.id and p.user_id = $2) as my_seat
         from hands h join games g on g.id = h.game_id
        where h.id = $1`,
      [id, me],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'Hand not found' });
    const mySeat: SeatIndex | null = row.my_seat;
    if (mySeat === null && row.host !== me) return reply.code(403).send({ error: 'You did not play in this hand' });

    const record = row.record;
    const playerIds: Record<SeatIndex, string> = { ...(record.playerIds ?? {}) };
    const events = (record.events ?? [])
      .filter((e) => e.type !== 'cardProof')
      .map((e) => redact(e, mySeat));
    const hole: Record<SeatIndex, Card[]> = {};
    if (mySeat !== null) {
      const own = record.hole?.[mySeat];
      if (own !== undefined) hole[mySeat] = [...own];
    }
    const users = await usersById(pool, Object.values(playerIds));
    const players = seatEntries(playerIds).map(([seat, uid]) => {
      const u = users.get(uid);
      return {
        seat,
        userId: uid,
        name: u?.display_name ?? '',
        avatarUrl: avatarUrlFor({ id: uid, avatar_path: u?.avatar_path ?? null }),
      };
    });
    const hand: RedactedHand = {
      handId: id,
      gameId: row.game_id,
      handNumber: row.hand_number,
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      board: [...(record.board ?? [])],
      playerIds,
      events,
      hole,
      mySeat,
      players,
    };
    return { hand };
  });

  app.get('/games/:id/fairness', { preHandler: requireUser }, async (req, reply) => {
    const me = userId(req);
    const { id } = idParams.parse(req.params);
    const { rows } = await pool.query<{ status: string; allowed: boolean }>(
      `select g.status,
              (g.host = $2
               or exists (select 1 from game_invites i where i.game_id = g.id and i.user_id = $2)
               or exists (select 1 from hand_players p join hands h on h.id = p.hand_id where h.game_id = g.id and p.user_id = $2)
              ) as allowed
         from games g where g.id = $1`,
      [id, me],
    );
    const game = rows[0];
    if (!game) return reply.code(404).send({ error: 'Game not found' });
    if (!game.allowed) return reply.code(403).send({ error: "You don't have access to this game" });
    if (game.status !== 'finished') return reply.code(409).send({ error: 'Seeds are revealed when the game ends' });

    const seeds = await pool.query<{ id: string; hand_number: number; record: HandRecord; server_seed: string; salt_key: string }>(
      `select h.id, h.hand_number, h.record, s.server_seed, s.salt_key
         from hands h join hand_seeds s on s.hand_id = h.id
        where h.game_id = $1
        order by h.hand_number`,
      [id],
    );
    const hands: FairnessHand[] = seeds.rows.map((r) => {
      let commitment = '';
      let clientSeeds: string[] = [];
      for (const e of r.record.events ?? []) {
        if (e.type === 'handStarted') commitment = e.commitment;
        else if (e.type === 'handEnded') clientSeeds = [...e.clientSeeds];
      }
      return { handId: r.id, handNumber: r.hand_number, commitment, serverSeed: r.server_seed, saltKey: r.salt_key, clientSeeds };
    });
    return { hands };
  });
}
