import { analyse, sharedNetwork, type HandRecord, type IntegrityFlag } from '@poker/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';

/*
 * Integrity flags for the game host. These are hints for a human to review: the app never
 * bans, blocks or otherwise acts against anyone because of them.
 *
 * Flag = {
 *   kind: 'chipDumping' | 'softPlay' | 'sharedIp' | 'sharedDevice',
 *   players: [{ id: string, displayName: string }, { id: string, displayName: string }],
 *   score: number,               // higher = more suspicious
 *   evidenceHandIds: string[],   // hand ids (empty for sharedIp / sharedDevice)
 *   summary: string,             // user ids replaced by display names
 *   stored: boolean,             // true = an integrity_flags row; false = computed live, not stored yet
 * }
 *
 * GET  /api/games/:id/integrity      → { flags: Flag[] }
 *        the stored flags of the game plus live sharedIp / sharedDevice flags over the latest session
 *        of every participant (host, invited users, anyone who played a hand), sorted by score desc.
 * POST /api/games/:id/integrity/run  → { flags: Flag[] }   (same shape as GET)
 *        re-runs the hand analysis over all stored hands of the game and upserts the flags first.
 *
 * Errors: 401 not signed in, 400 bad id, 404 { error: 'Game not found' },
 *         403 { error: 'Only the host can see integrity flags' } for anyone but the host.
 */

export interface FlagPlayer { id: string; displayName: string }

export interface Flag {
  kind: IntegrityFlag['kind'];
  players: [FlagPlayer, FlagPlayer];
  score: number;
  evidenceHandIds: string[];
  summary: string;
  stored: boolean;
}

interface FlagRow { kind: IntegrityFlag['kind']; players: string[]; score: number; evidence: string[]; summary: string }

const paramsSchema = z.object({ id: z.uuid() });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bigBlindSchema = z.number().int().positive();

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function userId(req: FastifyRequest): string {
  if (!req.user) throw httpError(401, 'Not signed in');
  return req.user.id;
}

async function hostGame(pool: Pool, gameId: string, me: string): Promise<{ settings: unknown }> {
  const { rows } = await pool.query<{ host: string; settings: unknown }>('select host, settings from games where id = $1', [gameId]);
  const game = rows[0];
  if (!game) throw httpError(404, 'Game not found');
  if (game.host !== me) throw httpError(403, 'Only the host can see integrity flags');
  return { settings: game.settings };
}

/** Same merge as the table manager: one flag per (kind, sorted players), higher score, joined summaries. */
function mergeFlags(flags: IntegrityFlag[]): IntegrityFlag[] {
  const byKey = new Map<string, IntegrityFlag>();
  for (const f of flags) {
    const players = [...f.players].sort() as [string, string];
    const key = `${f.kind}:${players.join(',')}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...f, players, evidenceHandIds: [...f.evidenceHandIds] });
      continue;
    }
    prev.score = Math.max(prev.score, f.score);
    if (!prev.summary.includes(f.summary)) prev.summary = `${prev.summary}; ${f.summary}`;
    prev.evidenceHandIds = [...new Set([...prev.evidenceHandIds, ...f.evidenceHandIds])];
  }
  return [...byKey.values()];
}

function flagKey(kind: string, players: readonly string[]): string {
  return `${kind}:${[...players].sort().join(',')}`;
}

function firstLevelBigBlind(settings: unknown): number | null {
  if (typeof settings !== 'object' || settings === null) return null;
  const levels = (settings as { levels?: unknown }).levels;
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const first: unknown = levels[0];
  if (typeof first !== 'object' || first === null) return null;
  const parsed = bigBlindSchema.safeParse((first as { bigBlind?: unknown }).bigBlind);
  return parsed.success ? parsed.data : null;
}

function recordBigBlind(record: HandRecord): number | null {
  for (const ev of record.events) {
    if (ev.type === 'handStarted') {
      const parsed = bigBlindSchema.safeParse(ev.stakes.bigBlind);
      return parsed.success ? parsed.data : null;
    }
  }
  return null;
}

async function runAnalysis(pool: Pool, gameId: string, settings: unknown): Promise<void> {
  const { rows } = await pool.query<{ record: HandRecord }>(
    'select record from hands where game_id = $1 order by hand_number',
    [gameId],
  );
  const records = rows.map((r) => r.record);
  if (records.length === 0) return;
  const latest = records[records.length - 1];
  const bigBlind = firstLevelBigBlind(settings) ?? (latest ? recordBigBlind(latest) : null);
  if (bigBlind === null) return;

  // Only flags over real users and real hands can be stored (players / evidence are uuid[]).
  const flags = mergeFlags(analyse(records, bigBlind)).filter((f) => f.players.every((p) => UUID_RE.test(p)));
  for (const f of flags) {
    await pool.query(
      `insert into integrity_flags (game_id, kind, players, score, evidence, summary)
       values ($1, $2, $3::uuid[], $4, $5::uuid[], $6)
       on conflict (game_id, kind, players) do update
         set score = greatest(integrity_flags.score, excluded.score), evidence = excluded.evidence, summary = excluded.summary`,
      [gameId, f.kind, f.players, f.score, f.evidenceHandIds.filter((h) => UUID_RE.test(h)), f.summary],
    );
  }
}

async function liveNetworkFlags(pool: Pool, gameId: string): Promise<IntegrityFlag[]> {
  const { rows } = await pool.query<{ user_id: string; ip: string; device_id: string }>(
    `with participants as (
       select host as user_id from games where id = $1
       union select user_id from game_invites where game_id = $1
       union select hp.user_id from hand_players hp join hands h on h.id = hp.hand_id where h.game_id = $1
     )
     select distinct on (s.user_id) s.user_id, s.ip, s.device_id
       from sessions s join participants p on p.user_id = s.user_id
      order by s.user_id, s.created_at desc, s.id`,
    [gameId],
  );
  return sharedNetwork(rows.map((r) => ({ playerId: r.user_id, ip: r.ip, deviceId: r.device_id })));
}

async function listFlags(pool: Pool, gameId: string): Promise<Flag[]> {
  const { rows } = await pool.query<FlagRow>(
    'select kind, players, score, evidence, summary from integrity_flags where game_id = $1',
    [gameId],
  );
  const stored = new Set(rows.map((r) => flagKey(r.kind, r.players)));
  const raw: { kind: IntegrityFlag['kind']; players: string[]; score: number; evidence: string[]; summary: string; stored: boolean }[] =
    rows.map((r) => ({ ...r, stored: true }));
  for (const f of await liveNetworkFlags(pool, gameId)) {
    if (stored.has(flagKey(f.kind, f.players))) continue;
    raw.push({ kind: f.kind, players: [...f.players], score: f.score, evidence: f.evidenceHandIds, summary: f.summary, stored: false });
  }

  const ids = [...new Set(raw.flatMap((f) => f.players))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const users = await pool.query<{ id: string; display_name: string }>(
      'select id, display_name from users where id = any($1::uuid[])',
      [ids],
    );
    for (const u of users.rows) names.set(u.id, u.display_name);
  }
  const nameOf = (id: string): string => names.get(id) ?? 'Unknown player';

  const flags: Flag[] = [];
  for (const f of raw) {
    const [a, b] = f.players;
    if (a === undefined || b === undefined) continue;
    let summary = f.summary;
    for (const id of f.players) summary = summary.split(id).join(nameOf(id));
    flags.push({
      kind: f.kind,
      players: [{ id: a, displayName: nameOf(a) }, { id: b, displayName: nameOf(b) }],
      score: f.score,
      evidenceHandIds: f.evidence,
      summary,
      stored: f.stored,
    });
  }
  return flags.sort((x, y) => y.score - x.score
    || x.kind.localeCompare(y.kind)
    || x.players[0].id.localeCompare(y.players[0].id)
    || x.players[1].id.localeCompare(y.players[1].id));
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/games/:id/integrity', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { id } = paramsSchema.parse(req.params);
    await hostGame(pool, id, me);
    return { flags: await listFlags(pool, id) };
  });

  app.post('/games/:id/integrity/run', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { id } = paramsSchema.parse(req.params);
    const { settings } = await hostGame(pool, id, me);
    await runAnalysis(pool, id, settings);
    return { flags: await listFlags(pool, id) };
  });
}
