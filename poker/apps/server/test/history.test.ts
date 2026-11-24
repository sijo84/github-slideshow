import { randomBytes, randomUUID } from 'node:crypto';
import type { Card, HandEvent, HandRecord, SeatIndex } from '@poker/engine';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { RedactedHand } from '../src/routes/history.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type User = { id: string; displayName: string };

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;

let host: User; // hosts game 1, never plays
let a: User; // seat 0, folds in hand 1
let b: User; // seat 1
let c: User; // seat 2, hosts game 2
let d: User;
let stranger: User;

let game1: string;
let game2: string;
let hand1: string;
let hand2: string;
let hand3: string;

// Cards: rank = card >> 2, suit = card & 3.
const A_CARDS: Card[] = [48, 49]; // Ac Ad
const B_CARDS: Card[] = [44, 45]; // Kc Kd
const C_CARDS: Card[] = [40, 41]; // Qc Qd
const BOARD: Card[] = [0, 5, 10, 15, 20];
const D_CARDS: Card[] = [36, 37];

const T0 = new Date('2026-11-01T12:00:00.000Z').getTime();
const seeds = new Map<string, { serverSeed: string; saltKey: string; commitment: string; clientSeeds: string[] }>();

function hex(n: number): string {
  return randomBytes(n).toString('hex');
}

function stakes(): { smallBlind: number; bigBlind: number; ante: number; anteKind: 'none' } {
  return { smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none' };
}

/** Three-way hand: A (button) folds, B and C check it down, B shows kings and wins against C's queens. */
function threeWayRecord(handId: string, gameId: string, handNumber: number, startedAt: Date): HandRecord {
  const s = seeds.get(handId)!;
  const events: HandEvent[] = [
    {
      type: 'handStarted', handId, handNumber, buttonSeat: 0, stakes: stakes(),
      seats: [{ seat: 0, playerId: a.id, stack: 1000 }, { seat: 1, playerId: b.id, stack: 1000 }, { seat: 2, playerId: c.id, stack: 1000 }],
      commitment: s.commitment, cardCommitments: Array.from({ length: 52 }, (_, i) => `commit-${i}`),
    },
    { type: 'postBlind', seat: 1, blind: 'small', amount: 5 },
    { type: 'postBlind', seat: 2, blind: 'big', amount: 10 },
    { type: 'dealHole', seat: 0, cards: [...A_CARDS] },
    { type: 'dealHole', seat: 1, cards: [...B_CARDS] },
    { type: 'dealHole', seat: 2, cards: [...C_CARDS] },
    { type: 'action', seat: 0, kind: 'fold', amount: 0, stackAfter: 1000 },
    { type: 'action', seat: 1, kind: 'call', amount: 10, stackAfter: 990 },
    { type: 'action', seat: 2, kind: 'check', amount: 10, stackAfter: 990 },
    { type: 'street', street: 'flop', cards: BOARD.slice(0, 3) },
    { type: 'action', seat: 1, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'action', seat: 2, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'street', street: 'turn', cards: BOARD.slice(3, 4) },
    { type: 'action', seat: 1, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'action', seat: 2, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'street', street: 'river', cards: BOARD.slice(4, 5) },
    { type: 'action', seat: 1, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'action', seat: 2, kind: 'check', amount: 0, stackAfter: 990 },
    { type: 'potsFormed', pots: [{ amount: 20, eligible: [1, 2] }] },
    { type: 'showCards', seat: 1, cards: [...B_CARDS], handName: 'Pair of Kings' },
    { type: 'showCards', seat: 2, cards: [...C_CARDS], handName: 'Pair of Queens' },
    { type: 'potAwarded', potIndex: 0, seats: [1], amounts: [20], handName: 'Pair of Kings' },
    {
      type: 'handEnded',
      stacks: [{ seat: 0, stack: 1000 }, { seat: 1, stack: 1010 }, { seat: 2, stack: 990 }],
      clientSeeds: s.clientSeeds, nextCommitment: hex(32),
    },
  ];
  return {
    handId, gameId, handNumber,
    startedAt: startedAt.toISOString(), endedAt: new Date(startedAt.getTime() + 30_000).toISOString(),
    events,
    hole: { 0: [...A_CARDS], 1: [...B_CARDS], 2: [...C_CARDS] },
    playerIds: { 0: a.id, 1: b.id, 2: c.id },
    board: [...BOARD],
  };
}

/** Heads-up hand: the small blind folds preflop, the big blind wins 15 without showing. */
function headsUpRecord(
  handId: string, gameId: string, handNumber: number, startedAt: Date,
  sb: { seat: SeatIndex; user: User; cards: Card[] }, bb: { seat: SeatIndex; user: User; cards: Card[] },
): HandRecord {
  const s = seeds.get(handId)!;
  const events: HandEvent[] = [
    {
      type: 'handStarted', handId, handNumber, buttonSeat: sb.seat, stakes: stakes(),
      seats: [{ seat: sb.seat, playerId: sb.user.id, stack: 1000 }, { seat: bb.seat, playerId: bb.user.id, stack: 1000 }],
      commitment: s.commitment, cardCommitments: Array.from({ length: 52 }, (_, i) => `commit-${i}`),
    },
    { type: 'postBlind', seat: sb.seat, blind: 'small', amount: 5 },
    { type: 'postBlind', seat: bb.seat, blind: 'big', amount: 10 },
    { type: 'dealHole', seat: sb.seat, cards: [...sb.cards] },
    { type: 'dealHole', seat: bb.seat, cards: [...bb.cards] },
    { type: 'action', seat: sb.seat, kind: 'fold', amount: 0, stackAfter: 995 },
    { type: 'uncalledReturned', seat: bb.seat, amount: 5 },
    { type: 'potAwarded', potIndex: 0, seats: [bb.seat], amounts: [10] },
    { type: 'potAwarded', potIndex: 1, seats: [bb.seat], amounts: [5] },
    {
      type: 'handEnded', stacks: [{ seat: sb.seat, stack: 995 }, { seat: bb.seat, stack: 1005 }],
      clientSeeds: s.clientSeeds, nextCommitment: hex(32),
    },
  ];
  return {
    handId, gameId, handNumber,
    startedAt: startedAt.toISOString(), endedAt: new Date(startedAt.getTime() + 10_000).toISOString(),
    events,
    hole: { [sb.seat]: [...sb.cards], [bb.seat]: [...bb.cards] },
    playerIds: { [sb.seat]: sb.user.id, [bb.seat]: bb.user.id },
    board: [],
  };
}

async function insertGame(hostId: string, name: string, status: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, $2, '{}'::jsonb, now(), $3) returning id`,
    [hostId, name, status],
  );
  return rows[0]!.id;
}

async function insertHand(record: HandRecord, nets: { userId: string; seat: SeatIndex; net: number }[]): Promise<void> {
  const s = seeds.get(record.handId)!;
  await pool.query(
    'insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, $4, $5, $6)',
    [record.handId, record.gameId, record.handNumber, JSON.stringify(record), record.startedAt, record.endedAt],
  );
  for (const n of nets) {
    await pool.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, $3, $4)', [record.handId, n.userId, n.seat, n.net]);
  }
  await pool.query('insert into hand_seeds (hand_id, server_seed, salt_key) values ($1, $2, $3)', [record.handId, s.serverSeed, s.saltKey]);
}

function newSeeds(handId: string): void {
  seeds.set(handId, { serverSeed: hex(32), saltKey: hex(32), commitment: hex(32), clientSeeds: [hex(16), hex(16)].sort() });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are inspected structurally
type Json = any;

async function get(user: User | null, url: string): Promise<{ statusCode: number; body: string; json: () => Json }> {
  const headers = user ? await authed(app, user) : {};
  const res = await app.inject({ method: 'GET', url, headers });
  return { statusCode: res.statusCode, body: res.body, json: (): Json => res.json() };
}

/** Every card value a client could read from a redacted hand: hole, board, and any `cards` array anywhere. */
function visibleCards(hand: unknown): Card[] {
  const out: Card[] = [];
  const walk = (v: unknown, key: string | null, underHole: boolean): void => {
    if (Array.isArray(v)) {
      if ((key === 'cards' || key === 'board' || underHole) && v.every((x) => typeof x === 'number')) {
        out.push(...(v as number[]));
        return;
      }
      v.forEach((x) => walk(x, null, false));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, key === 'hole');
    }
  };
  walk(hand, null, false);
  return out;
}

function dealHoleCards(hand: RedactedHand, seat: SeatIndex): Card[] {
  return hand.events.filter((e) => e.type === 'dealHole' && e.seat === seat).flatMap((e) => (e.type === 'dealHole' ? e.cards : []));
}

function shownCards(hand: RedactedHand, seat: SeatIndex): Card[] {
  return hand.events.filter((e) => e.type === 'showCards' && e.seat === seat).flatMap((e) => (e.type === 'showCards' ? e.cards : []));
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
  await app.ready();

  host = await makeUser(pool, 'Host');
  a = await makeUser(pool, 'Alice');
  b = await makeUser(pool, 'Bob');
  c = await makeUser(pool, 'Cleo');
  d = await makeUser(pool, 'Dan');
  stranger = await makeUser(pool, 'Stranger');

  game1 = await insertGame(host.id, 'Friday game', 'running');
  game2 = await insertGame(c.id, 'Cleo game', 'finished');
  for (const u of [a, b, c]) await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [game1, u.id]);
  await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [game2, d.id]);

  hand1 = randomUUID();
  hand2 = randomUUID();
  hand3 = randomUUID();
  for (const h of [hand1, hand2, hand3]) newSeeds(h);

  await insertHand(threeWayRecord(hand1, game1, 1, new Date(T0)), [
    { userId: a.id, seat: 0, net: 0 },
    { userId: b.id, seat: 1, net: 10 },
    { userId: c.id, seat: 2, net: -10 },
  ]);
  await insertHand(
    headsUpRecord(hand2, game1, 2, new Date(T0 + 60_000), { seat: 1, user: b, cards: B_CARDS }, { seat: 0, user: a, cards: A_CARDS }),
    [
      { userId: a.id, seat: 0, net: 5 },
      { userId: b.id, seat: 1, net: -5 },
    ],
  );
  await insertHand(
    headsUpRecord(hand3, game2, 1, new Date(T0 + 120_000), { seat: 3, user: c, cards: C_CARDS }, { seat: 4, user: d, cards: D_CARDS }),
    [
      { userId: c.id, seat: 3, net: -5 },
      { userId: d.id, seat: 4, net: 5 },
    ],
  );
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

describe('GET /api/hands/:id (redaction)', () => {
  it('player B fetching a hand where A folded gets no A cards', async () => {
    const res = await get(b, `/api/hands/${hand1}`);
    expect(res.statusCode).toBe(200);
    const hand = res.json().hand as RedactedHand;
    expect(hand.mySeat).toBe(1);

    // A's hole cards appear nowhere a client could read cards from.
    const visible = visibleCards(hand);
    for (const card of A_CARDS) expect(visible).not.toContain(card);
    expect(Object.keys(hand.hole)).toEqual(['1']);
    expect(hand.hole[1]).toEqual(B_CARDS);
    expect(dealHoleCards(hand, 0)).toEqual([]);
    expect(shownCards(hand, 0)).toEqual([]);

    // B sees their own deal and C's shown cards; C's dealHole stays redacted.
    expect(dealHoleCards(hand, 1)).toEqual(B_CARDS);
    expect(dealHoleCards(hand, 2)).toEqual([]);
    expect(shownCards(hand, 2)).toEqual(C_CARDS);

    expect(hand.board).toEqual(BOARD);
    expect(hand.handId).toBe(hand1);
    expect(hand.gameId).toBe(game1);
    expect(hand.handNumber).toBe(1);
    expect(hand.startedAt).toBe(new Date(T0).toISOString());
    expect(hand.playerIds).toEqual({ 0: a.id, 1: b.id, 2: c.id });
    expect(hand.players.map((p) => [p.seat, p.userId, p.name])).toEqual([
      [0, a.id, 'Alice'],
      [1, b.id, 'Bob'],
      [2, c.id, 'Cleo'],
    ]);
    expect(hand.players[0]!.avatarUrl).toBe(`/api/users/${a.id}/avatar.svg`);
    // The full record's hole map is never returned.
    expect(res.body).not.toContain('"hole":{"0"');
  });

  it('A, who folded, sees their own cards; B and C only through showCards', async () => {
    const hand = (await get(a, `/api/hands/${hand1}`)).json().hand as RedactedHand;
    expect(hand.mySeat).toBe(0);
    expect(hand.hole).toEqual({ 0: A_CARDS });
    expect(dealHoleCards(hand, 0)).toEqual(A_CARDS);
    expect(dealHoleCards(hand, 1)).toEqual([]);
    expect(dealHoleCards(hand, 2)).toEqual([]);
    expect(shownCards(hand, 1)).toEqual(B_CARDS);
    expect(shownCards(hand, 2)).toEqual(C_CARDS);
  });

  it('A unshown hand stays hidden from the opponent (heads-up fold)', async () => {
    // Hand 2: B (small blind) folds; A never shows. B must not see A's cards and vice versa.
    const forB = (await get(b, `/api/hands/${hand2}`)).json().hand as RedactedHand;
    for (const card of A_CARDS) expect(visibleCards(forB)).not.toContain(card);
    const forA = (await get(a, `/api/hands/${hand2}`)).json().hand as RedactedHand;
    for (const card of B_CARDS) expect(visibleCards(forA)).not.toContain(card);
  });

  it('the host who did not play sees no dealHole cards and an empty hole', async () => {
    const hand = (await get(host, `/api/hands/${hand1}`)).json().hand as RedactedHand;
    expect(hand.mySeat).toBeNull();
    expect(hand.hole).toEqual({});
    const deals = hand.events.filter((e) => e.type === 'dealHole');
    expect(deals).toHaveLength(3);
    for (const e of deals) expect(e.type === 'dealHole' && e.cards).toEqual([]);
    for (const card of A_CARDS) expect(visibleCards(hand)).not.toContain(card);
    expect(shownCards(hand, 1)).toEqual(B_CARDS);
  });

  it('never contains the server seed or salt key, nor cardProof events', async () => {
    const s = seeds.get(hand1)!;
    for (const viewer of [a, b, c, host]) {
      const res = await get(viewer, `/api/hands/${hand1}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(s.serverSeed);
      expect(res.body).not.toContain(s.saltKey);
      expect(res.body).not.toContain('cardProof');
    }
  });

  it('drops a stray cardProof event from the stored record', async () => {
    const id = randomUUID();
    newSeeds(id);
    const record = threeWayRecord(id, game1, 99, new Date(T0 - 3_600_000));
    record.events.splice(4, 0, { type: 'cardProof', position: 0, card: A_CARDS[0]!, salt: 'leaky-salt' });
    await insertHand(record, [{ userId: b.id, seat: 1, net: 0 }]);
    try {
      const res = await get(b, `/api/hands/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('cardProof');
      expect(res.body).not.toContain('leaky-salt');
      for (const card of A_CARDS) expect(visibleCards(res.json().hand)).not.toContain(card);
    } finally {
      await pool.query('delete from hands where id = $1', [id]);
    }
  });

  it('403 for a stranger and for an invited non-player, 404 unknown, 400 non-uuid, 401 unauthenticated', async () => {
    expect((await get(stranger, `/api/hands/${hand1}`)).statusCode).toBe(403);
    expect((await get(d, `/api/hands/${hand1}`)).statusCode).toBe(403);
    // C hosts game 2 but did not play hand 1 of game 1; D did not play hand 1.
    const notFound = await get(b, `/api/hands/${randomUUID()}`);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: expect.any(String) });
    const bad = await get(b, '/api/hands/not-a-uuid');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: expect.any(String) });
    expect((await get(null, `/api/hands/${hand1}`)).statusCode).toBe(401);
  });
});

describe('GET /api/hands (list)', () => {
  it('lists only my hands, newest first, with myNet, potTotal, winners and board', async () => {
    const res = await get(b, '/api/hands');
    expect(res.statusCode).toBe(200);
    const hands = res.json().hands as {
      id: string; gameId: string; gameName: string; handNumber: number; potTotal: number; myNet: number | null;
      winners: { seat: number; name: string; handName: string | null }[]; board: Card[]; startedAt: string; endedAt: string;
    }[];
    expect(hands.map((h) => h.id)).toEqual([hand2, hand1]);
    const [h2, h1] = hands;
    expect(h1).toMatchObject({
      gameId: game1, gameName: 'Friday game', handNumber: 1, potTotal: 20, myNet: 10, board: BOARD,
      winners: [{ seat: 1, name: 'Bob', handName: 'Pair of Kings' }],
      startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 30_000).toISOString(),
    });
    expect(h2).toMatchObject({ handNumber: 2, potTotal: 15, myNet: -5, board: [], winners: [{ seat: 0, name: 'Alice', handName: null }] });
    // The summary carries no hole cards.
    expect(res.body).not.toContain('"hole"');
  });

  it('includes hands of games I host, with myNet null when I did not play', async () => {
    const hands = (await get(host, '/api/hands')).json().hands as { id: string; myNet: number | null }[];
    expect(hands.map((h) => h.id)).toEqual([hand2, hand1]);
    expect(hands.every((h) => h.myNet === null)).toBe(true);

    const cHands = (await get(c, '/api/hands')).json().hands as { id: string; myNet: number | null }[];
    expect(cHands.map((h) => [h.id, h.myNet])).toEqual([
      [hand3, -5],
      [hand1, -10],
    ]);
    expect((await get(stranger, '/api/hands')).json().hands).toEqual([]);
  });

  it('filters by gameId, honours limit and the before cursor', async () => {
    const byGame = (await get(c, `/api/hands?gameId=${game2}`)).json().hands as { id: string }[];
    expect(byGame.map((h) => h.id)).toEqual([hand3]);
    const otherGame = (await get(b, `/api/hands?gameId=${game2}`)).json().hands as { id: string }[];
    expect(otherGame).toEqual([]);

    const limited = (await get(b, '/api/hands?limit=1')).json().hands as { id: string; startedAt: string }[];
    expect(limited.map((h) => h.id)).toEqual([hand2]);
    const next = (await get(b, `/api/hands?limit=1&before=${encodeURIComponent(limited[0]!.startedAt)}`)).json().hands as { id: string }[];
    expect(next.map((h) => h.id)).toEqual([hand1]);
    const none = (await get(b, `/api/hands?before=${encodeURIComponent(new Date(T0).toISOString())}`)).json().hands;
    expect(none).toEqual([]);
  });

  it('rejects bad query values with 400 and requires a session', async () => {
    for (const q of ['gameId=nope', 'limit=0', 'limit=101', 'limit=abc', 'before=yesterday']) {
      const res = await get(b, `/api/hands?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
    expect((await get(null, '/api/hands')).statusCode).toBe(401);
  });
});

describe('GET /api/games/:id/fairness', () => {
  it('409 while the game is running, even for the host', async () => {
    for (const viewer of [host, a]) {
      const res = await get(viewer, `/api/games/${game1}/fairness`);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Seeds are revealed when the game ends' });
      expect(res.body).not.toContain(seeds.get(hand1)!.serverSeed);
    }
  });

  it('reveals seeds once the game is finished, ordered by hand number', async () => {
    await pool.query(`update games set status = 'finished' where id = $1`, [game1]);
    try {
      for (const viewer of [host, a, b]) {
        const res = await get(viewer, `/api/games/${game1}/fairness`);
        expect(res.statusCode).toBe(200);
        const s1 = seeds.get(hand1)!;
        const s2 = seeds.get(hand2)!;
        expect(res.json()).toEqual({
          hands: [
            { handId: hand1, handNumber: 1, commitment: s1.commitment, serverSeed: s1.serverSeed, saltKey: s1.saltKey, clientSeeds: s1.clientSeeds },
            { handId: hand2, handNumber: 2, commitment: s2.commitment, serverSeed: s2.serverSeed, saltKey: s2.saltKey, clientSeeds: s2.clientSeeds },
          ],
        });
      }
      // An invited user who played no hand may also verify.
      const invited = await get(d, `/api/games/${game2}/fairness`);
      expect(invited.statusCode).toBe(200);
      expect(invited.json().hands).toHaveLength(1);
    } finally {
      await pool.query(`update games set status = 'running' where id = $1`, [game1]);
    }
  });

  it('403 for a stranger, 404 unknown, 400 non-uuid, 401 unauthenticated', async () => {
    expect((await get(stranger, `/api/games/${game2}/fairness`)).statusCode).toBe(403);
    expect((await get(b, `/api/games/${game2}/fairness`)).statusCode).toBe(403);
    expect((await get(b, `/api/games/${randomUUID()}/fairness`)).statusCode).toBe(404);
    expect((await get(b, '/api/games/xyz/fairness')).statusCode).toBe(400);
    expect((await get(null, `/api/games/${game2}/fairness`)).statusCode).toBe(401);
  });
});
