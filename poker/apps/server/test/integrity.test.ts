import { randomBytes, randomUUID } from 'node:crypto';
import type { ActionKind, Card, Chips, HandEvent, HandRecord, SeatIndex } from '@poker/engine';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type User = { id: string; email: string; displayName: string };
type Headers = { cookie: string; origin: string };

interface FlagJson {
  kind: string;
  players: { id: string; displayName: string }[];
  score: number;
  evidenceHandIds: string[];
  summary: string;
  stored: boolean;
}

// ---------------------------------------------------------------------------------------------
// Hand-record builder (copied from packages/engine/test/collusion.test.ts)

const BB = 100;
const STAKES = { smallBlind: 50, bigBlind: BB, ante: 0, anteKind: 'none' as const };
const SETTINGS = { kind: 'cash', levels: [{ level: 1, smallBlind: 50, bigBlind: BB, ante: 0, anteKind: 'none', durationMinutes: 0 }] };

// rank 0 = deuce .. 12 = ace; suit 0 c, 1 d, 2 h, 3 s
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
function c(s: string): Card {
  return RANKS.indexOf(s[0]!) * 4 + SUITS.indexOf(s[1]!);
}
function cards(s: string): Card[] {
  return s.split(' ').map(c);
}

const ACES = cards('As Ah');
const TRASH = cards('7c 2d');
const BOARD = cards('Kd 9s 4h 3c Jd');

interface SeatSpec { id: string; stack?: Chips; hole: Card[] }

class HandBuilder {
  private readonly events: HandEvent[] = [];
  private readonly stacks: Chips[];
  private readonly contrib = new Map<SeatIndex, Chips>();
  private pot = 0;
  private boardDealt = 0;

  constructor(private readonly handId: string, private readonly handNumber: number, private readonly seats: SeatSpec[], private readonly board: Card[] = BOARD) {
    this.stacks = seats.map((s) => s.stack ?? 10_000);
    this.events.push({
      type: 'handStarted', handId, handNumber, buttonSeat: 0, stakes: STAKES,
      seats: seats.map((s, i) => ({ seat: i, playerId: s.id, stack: this.stacks[i]! })),
      commitment: '', cardCommitments: [],
    });
  }

  private put(seat: SeatIndex, to: Chips): void {
    const prev = this.contrib.get(seat) ?? 0;
    this.stacks[seat]! -= to - prev;
    this.pot += to - prev;
    this.contrib.set(seat, to);
  }

  blinds(sb: SeatIndex, bb: SeatIndex): this {
    this.put(sb, STAKES.smallBlind);
    this.events.push({ type: 'postBlind', seat: sb, blind: 'small', amount: STAKES.smallBlind });
    this.put(bb, BB);
    this.events.push({ type: 'postBlind', seat: bb, blind: 'big', amount: BB });
    this.seats.forEach((s, i) => this.events.push({ type: 'dealHole', seat: i, cards: s.hole }));
    return this;
  }

  act(seat: SeatIndex, kind: ActionKind, amount = 0): this {
    let total = this.contrib.get(seat) ?? 0;
    if (kind === 'call') total = Math.max(...this.contrib.values(), 0);
    if (kind === 'bet' || kind === 'raise' || kind === 'allIn') total = amount;
    if (kind !== 'fold' && kind !== 'check') this.put(seat, total);
    this.events.push({ type: 'action', seat, kind, amount: total, stackAfter: this.stacks[seat]! });
    return this;
  }

  street(street: 'flop' | 'turn' | 'river'): this {
    const n = street === 'flop' ? 3 : 1;
    const dealt = this.board.slice(this.boardDealt, this.boardDealt + n);
    this.boardDealt += n;
    this.contrib.clear();
    this.events.push({ type: 'street', street, cards: dealt });
    return this;
  }

  award(seat: SeatIndex): HandRecord {
    this.stacks[seat]! += this.pot;
    this.events.push({ type: 'potAwarded', potIndex: 0, seats: [seat], amounts: [this.pot] });
    this.events.push({
      type: 'handEnded', stacks: this.stacks.map((stack, i) => ({ seat: i, stack })), clientSeeds: [], nextCommitment: '',
    });
    const hole: Record<SeatIndex, Card[]> = {};
    const playerIds: Record<SeatIndex, string> = {};
    this.seats.forEach((s, i) => { hole[i] = s.hole; playerIds[i] = s.id; });
    return {
      handId: this.handId, gameId: '', handNumber: this.handNumber, startedAt: '', endedAt: '',
      events: this.events, hole, playerIds, board: this.board.slice(0, this.boardDealt),
    };
  }
}

/** A (seat 0, aces) raises, B calls, B bets the turn and A folds the better hand. */
function strongFold(n: number, a: string, b: string): HandRecord {
  return new HandBuilder(randomUUID(), n, [{ id: a, hole: ACES }, { id: b, hole: TRASH }]).blinds(0, 1)
    .act(0, 'raise', 300).act(1, 'call')
    .street('flop').act(1, 'check').act(0, 'check')
    .street('turn').act(1, 'bet', 500).act(0, 'fold')
    .award(1);
}

/** Ordinary hands: a preflop steal and a value bet that gets folded by the weaker hand. */
function normalHand(n: number, a: string, b: string): HandRecord {
  if (n % 2 === 0) {
    return new HandBuilder(randomUUID(), n, [{ id: a, hole: TRASH }, { id: b, hole: ACES }]).blinds(0, 1)
      .act(0, 'raise', 300).act(1, 'fold')
      .award(0);
  }
  return new HandBuilder(randomUUID(), n, [{ id: a, hole: ACES }, { id: b, hole: TRASH }]).blinds(0, 1)
    .act(0, 'raise', 300).act(1, 'call')
    .street('flop').act(1, 'check').act(0, 'bet', 400).act(1, 'call')
    .street('turn').act(1, 'check').act(0, 'bet', 1200).act(1, 'fold')
    .award(0);
}

// ---------------------------------------------------------------------------------------------

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;
let host: User;
let invited: User;
let stranger: User;
let hHost: Headers;
let hInvited: Headers;
let hStranger: Headers;

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
  await app.ready();
  host = await makeUser(pool, 'Hannah Host');
  invited = await makeUser(pool, 'Ivan Invited');
  stranger = await makeUser(pool, 'Sam Stranger');
  hHost = await authed(app, host);
  hInvited = await authed(app, invited);
  hStranger = await authed(app, stranger);
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

async function makeGame(settings: unknown = SETTINGS, invites: User[] = []): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, 'Integrity test', $2, now(), 'running') returning id`,
    [host.id, JSON.stringify(settings)],
  );
  const id = rows[0]!.id;
  for (const u of invites) await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [id, u.id]);
  return id;
}

async function storeHand(gameId: string, record: HandRecord): Promise<void> {
  const rec = { ...record, gameId };
  await pool.query(
    'insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, $4, now(), now())',
    [rec.handId, gameId, rec.handNumber, JSON.stringify(rec)],
  );
  const started = rec.events.find((e) => e.type === 'handStarted');
  const ended = rec.events.find((e) => e.type === 'handEnded');
  if (started?.type !== 'handStarted' || ended?.type !== 'handEnded') throw new Error('bad record');
  for (const s of started.seats) {
    const end = ended.stacks.find((x) => x.seat === s.seat)?.stack ?? s.stack;
    await pool.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, $3, $4)', [rec.handId, s.playerId, s.seat, end - s.stack]);
  }
}

/** A session row created `offsetSec` seconds from now (later = newer). */
async function addSession(user: User, ip: string, deviceId: string, offsetSec: number): Promise<void> {
  await pool.query(
    `insert into sessions (id, user_id, ip, device_id, created_at, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5), now() + interval '1 day')`,
    [randomBytes(16).toString('hex'), user.id, ip, deviceId, offsetSec],
  );
}

function getFlags(headers: Headers | Record<string, never>, gameId: string) {
  return app.inject({ method: 'GET', url: `/api/games/${gameId}/integrity`, headers });
}
function run(headers: Headers | Record<string, never>, gameId: string) {
  return app.inject({ method: 'POST', url: `/api/games/${gameId}/integrity/run`, headers });
}

describe('integrity flags', () => {
  it('detects chip dumping on run, stores it once and lists it with display names', async () => {
    const a = await makeUser(pool, 'Alice Dumper');
    const b = await makeUser(pool, 'Bob Receiver');
    const gameId = await makeGame();
    const records = [strongFold(1, a.id, b.id), strongFold(2, a.id, b.id), strongFold(3, a.id, b.id)];
    for (const r of records) await storeHand(gameId, r);

    const before = await getFlags(hHost, gameId);
    expect(before.statusCode).toBe(200);
    expect(before.json().flags).toEqual([]);

    const res = await run(hHost, gameId);
    expect(res.statusCode).toBe(200);
    const flags = res.json().flags as FlagJson[];
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.kind).toBe('chipDumping');
    expect(f.stored).toBe(true);
    expect(f.score).toBeGreaterThanOrEqual(3);
    expect(new Set(f.evidenceHandIds)).toEqual(new Set(records.map((r) => r.handId)));
    const expectedPlayers = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1)).map((u) => ({ id: u.id, displayName: u.displayName }));
    expect(f.players).toEqual(expectedPlayers);
    expect(f.summary).toContain('Alice Dumper');
    expect(f.summary).toContain('Bob Receiver');
    expect(f.summary).not.toContain(a.id);
    expect(f.summary).not.toContain(b.id);

    const stored = await pool.query<{ kind: string; players: string[]; evidence: string[] }>(
      'select kind, players, evidence from integrity_flags where game_id = $1', [gameId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.kind).toBe('chipDumping');
    expect([...stored.rows[0]!.players].sort()).toEqual([a.id, b.id].sort());
    expect(new Set(stored.rows[0]!.evidence)).toEqual(new Set(records.map((r) => r.handId)));

    const again = await run(hHost, gameId);
    expect(again.statusCode).toBe(200);
    expect(again.json().flags).toHaveLength(1);
    const count = await pool.query('select 1 from integrity_flags where game_id = $1', [gameId]);
    expect(count.rowCount).toBe(1);

    const listed = await getFlags(hHost, gameId);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().flags).toEqual(flags);
  });

  it('falls back to the stakes of the latest hand when the settings have no levels', async () => {
    const a = await makeUser(pool, 'Ann Fallback');
    const b = await makeUser(pool, 'Ben Fallback');
    const gameId = await makeGame({});
    for (let n = 1; n <= 3; n++) await storeHand(gameId, strongFold(n, a.id, b.id));
    const res = await run(hHost, gameId);
    expect(res.statusCode).toBe(200);
    expect((res.json().flags as FlagJson[]).map((f) => f.kind)).toEqual(['chipDumping']);
  });

  it('normal play gives no flags', async () => {
    const a = await makeUser(pool, 'Nora Normal');
    const b = await makeUser(pool, 'Ned Normal');
    const gameId = await makeGame();
    for (let n = 1; n <= 8; n++) await storeHand(gameId, normalHand(n, a.id, b.id));
    const res = await run(hHost, gameId);
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toEqual([]);
    const count = await pool.query('select 1 from integrity_flags where game_id = $1', [gameId]);
    expect(count.rowCount).toBe(0);
  });

  it('lists live shared-network flags over the latest session of each participant', async () => {
    const ipA = await makeUser(pool, 'Ida SameIp');
    const ipB = await makeUser(pool, 'Ian SameIp');
    const moved = await makeUser(pool, 'Mo Moved');
    const loopA = await makeUser(pool, 'Lou Loopback');
    const loopB = await makeUser(pool, 'Lia Loopback');
    const devA = await makeUser(pool, 'Dee Device');
    const devB = await makeUser(pool, 'Dan Device');
    const unkA = await makeUser(pool, 'Una Unknown');
    const unkB = await makeUser(pool, 'Uli Unknown');
    const opponent = await makeUser(pool, 'Otto Opponent');
    const outsider = await makeUser(pool, 'Olga Outsider');

    // ipB takes part through a played hand, not an invitation.
    const gameId = await makeGame(SETTINGS, [ipA, moved, loopA, loopB, devA, devB, unkA, unkB]);
    await storeHand(gameId, normalHand(1, ipB.id, opponent.id));

    // Old sessions that would match but are superseded by newer ones.
    await addSession(ipA, '9.9.9.9', 'old-a', -3600);
    await addSession(moved, '203.0.113.7', 'moved-old', -3600);
    await addSession(ipA, '203.0.113.7', 'dev-ipa', 10);
    await addSession(ipB, '203.0.113.7', 'dev-ipb', 10);
    await addSession(moved, '198.51.100.9', 'moved-new', 10);
    await addSession(loopA, '127.0.0.1', 'dev-loop-a', 10);
    await addSession(loopB, '127.0.0.1', 'dev-loop-b', 10);
    await addSession(devA, '192.0.2.1', 'shared-device', 10);
    await addSession(devB, '192.0.2.2', 'shared-device', 10);
    await addSession(unkA, '192.0.2.3', 'unknown', 10);
    await addSession(unkB, '192.0.2.4', 'unknown', 10);
    // Not a participant: same IP as ipA, must not produce a flag.
    await addSession(outsider, '203.0.113.7', 'dev-out', 10);

    const res = await getFlags(hHost, gameId);
    expect(res.statusCode).toBe(200);
    const flags = res.json().flags as FlagJson[];
    const summary = flags.map((f) => ({ kind: f.kind, players: f.players.map((p) => p.id).sort(), stored: f.stored }));
    expect(summary).toHaveLength(2);
    expect(summary).toContainEqual({ kind: 'sharedIp', players: [ipA.id, ipB.id].sort(), stored: false });
    expect(summary).toContainEqual({ kind: 'sharedDevice', players: [devA.id, devB.id].sort(), stored: false });

    const ip = flags.find((f) => f.kind === 'sharedIp')!;
    expect(ip.evidenceHandIds).toEqual([]);
    expect(ip.summary).toContain('Ida SameIp');
    expect(ip.summary).toContain('Ian SameIp');
    expect(ip.players.map((p) => p.displayName).sort()).toEqual(['Ian SameIp', 'Ida SameIp']);

    // The run route replies the same shape and does not store live network flags.
    const ran = await run(hHost, gameId);
    expect(ran.statusCode).toBe(200);
    expect(ran.json().flags).toEqual(flags);
  });

  it('marks a live flag as stored when the same kind and players are already stored', async () => {
    const a = await makeUser(pool, 'Sara Stored');
    const b = await makeUser(pool, 'Seth Stored');
    const gameId = await makeGame(SETTINGS, [a, b]);
    await addSession(a, '203.0.113.50', 'sa', 10);
    await addSession(b, '203.0.113.50', 'sb', 10);
    await pool.query(
      `insert into integrity_flags (game_id, kind, players, score, evidence, summary) values ($1, 'sharedIp', $2::uuid[], 1, '{}', $3)`,
      [gameId, [a.id, b.id].sort(), `${a.id} and ${b.id} connected from the same IP address.`],
    );
    const res = await getFlags(hHost, gameId);
    const flags = res.json().flags as FlagJson[];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'sharedIp', stored: true, summary: expect.stringContaining('Sara Stored') });
  });

  it('only the host may see or run integrity checks', async () => {
    const gameId = await makeGame(SETTINGS, [invited]);
    for (const h of [hInvited, hStranger]) {
      const g = await getFlags(h, gameId);
      expect(g.statusCode).toBe(403);
      expect(g.json()).toEqual({ error: 'Only the host can see integrity flags' });
      const r = await run(h, gameId);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'Only the host can see integrity flags' });
    }
  });

  it('unknown game is 404, a bad id 400, no session 401', async () => {
    const missing = randomUUID();
    expect((await getFlags(hHost, missing)).statusCode).toBe(404);
    expect((await run(hHost, missing)).statusCode).toBe(404);
    expect((await getFlags(hHost, 'not-a-uuid')).statusCode).toBe(400);
    const gameId = await makeGame();
    const g = await getFlags({}, gameId);
    expect(g.statusCode).toBe(401);
    expect(g.json()).toEqual({ error: 'Not signed in' });
    const r = await app.inject({ method: 'POST', url: `/api/games/${gameId}/integrity/run`, headers: { origin: hHost.origin } });
    expect(r.statusCode).toBe(401);
  });
});
