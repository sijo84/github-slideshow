import { randomUUID } from 'node:crypto';
import { computeStats, type ActionKind, type HandEvent, type HandRecord, type SeatIndex } from '@poker/engine';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type User = { id: string; email: string; displayName: string };

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;
let alice: User; // the subject
let bob: User; // accepted friend, played in g1
let carol: User; // accepted friend, hosts g2 but never played
let dave: User; // not a friend
let erin: User; // pending friendship with alice
let zed: User; // no hands at all

const aliceRecords: HandRecord[] = [];
let handSeq = 0;

const stakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' as const };
const sb = (seat: SeatIndex, amount = 1): HandEvent => ({ type: 'postBlind', seat, blind: 'small', amount });
const bb = (seat: SeatIndex, amount = 2): HandEvent => ({ type: 'postBlind', seat, blind: 'big', amount });
const act = (seat: SeatIndex, kind: ActionKind, amount = 0, stackAfter = 0): HandEvent => ({
  type: 'action',
  seat,
  kind,
  amount,
  stackAfter,
});
const flop: HandEvent = { type: 'street', street: 'flop', cards: [0, 1, 2] };
const turn: HandEvent = { type: 'street', street: 'turn', cards: [3] };
const river: HandEvent = { type: 'street', street: 'river', cards: [4] };
const show = (seat: SeatIndex): HandEvent => ({ type: 'showCards', seat, cards: [], handName: 'x' });
const award = (seats: SeatIndex[], amounts: number[]): HandEvent => ({ type: 'potAwarded', potIndex: 0, seats, amounts });

/** Builds a record (handStarted from `seats`, `body`, handEnded from `endStacks`) and stores it in hands + hand_players. */
async function insertHand(
  gameId: string,
  seats: [SeatIndex, string, number][],
  body: HandEvent[],
  endStacks: Record<SeatIndex, number>,
): Promise<HandRecord> {
  handSeq++;
  const handId = randomUUID();
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, handSeq)).toISOString();
  const playerIds: Record<SeatIndex, string> = {};
  const hole: Record<SeatIndex, number[]> = {};
  for (const [seat, id] of seats) {
    playerIds[seat] = id;
    hole[seat] = [40 + seat * 2, 41 + seat * 2];
  }
  const events: HandEvent[] = [
    {
      type: 'handStarted',
      handId,
      handNumber: handSeq,
      buttonSeat: seats[0]?.[0] ?? 0,
      stakes,
      seats: seats.map(([seat, playerId, stack]) => ({ seat, playerId, stack })),
      commitment: 'c',
      cardCommitments: [],
    },
    ...body,
    {
      type: 'handEnded',
      stacks: Object.entries(endStacks).map(([seat, stack]) => ({ seat: Number(seat), stack })),
      clientSeeds: [],
      nextCommitment: 'n',
    },
  ];
  const record: HandRecord = {
    handId,
    gameId,
    handNumber: handSeq,
    startedAt,
    endedAt: startedAt,
    events,
    hole,
    playerIds,
    board: [],
  };
  await pool.query(
    `insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, $4, $5, $5)`,
    [handId, gameId, handSeq, JSON.stringify(record), startedAt],
  );
  for (const [seat, userId, stack] of seats) {
    await pool.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, $3, $4)', [
      handId,
      userId,
      seat,
      (endStacks[seat] ?? stack) - stack,
    ]);
  }
  if (seats.some(([, id]) => id === alice.id)) aliceRecords.push(record);
  return record;
}

async function makeGame(host: User): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at) values ($1, 'Test game', '{}'::jsonb, now()) returning id`,
    [host.id],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('insert into games returned no row');
  return id;
}

async function befriend(a: User, b: User, status: 'pending' | 'accepted'): Promise<void> {
  await pool.query('insert into friendships (requester, addressee, status) values ($1, $2, $3)', [a.id, b.id, status]);
}

async function getStats(viewer: User | null, userId: string) {
  const headers = viewer ? await authed(app, viewer) : {};
  return app.inject({ method: 'GET', url: `/api/stats/${userId}`, headers });
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
  await app.ready();

  alice = await makeUser(pool, 'Alice');
  bob = await makeUser(pool, 'Bob');
  carol = await makeUser(pool, 'Carol');
  dave = await makeUser(pool, 'Dave');
  erin = await makeUser(pool, 'Erin');
  zed = await makeUser(pool, 'Zed');

  await befriend(alice, bob, 'accepted');
  await befriend(carol, alice, 'accepted');
  await befriend(erin, alice, 'pending');

  const g1 = await makeGame(alice); // alice + bob play
  const g2 = await makeGame(carol); // alice + dave play; carol hosts only
  const g3 = await makeGame(alice); // alice + dave play

  // g1 h1: alice raises preflop, bob folds the BB. Alice +2.
  await insertHand(g1, [[0, alice.id, 100], [1, bob.id, 100]], [sb(0), bb(1), act(0, 'raise', 6), act(1, 'fold'), award([0], [8])], {
    0: 102,
    1: 98,
  });
  // g1 h2: bob limps, alice checks the BB, folds to a flop bet. Alice -2.
  await insertHand(
    g1,
    [[0, bob.id, 100], [1, alice.id, 100]],
    [sb(0), bb(1), act(0, 'call', 2), act(1, 'check'), flop, act(0, 'bet', 4), act(1, 'fold'), award([0], [8])],
    { 0: 102, 1: 98 },
  );
  // g2 h3: alice limps, calls the flop, loses at showdown. Alice -6.
  await insertHand(
    g2,
    [[0, alice.id, 100], [1, dave.id, 100]],
    [sb(0), bb(1), act(0, 'call', 2), act(1, 'check'), flop, act(1, 'bet', 4), act(0, 'call', 4), turn, river, show(0), show(1), award([1], [12])],
    { 0: 94, 1: 106 },
  );
  // g2 h4: dave folds the SB, alice wins the walk. Alice +1.
  await insertHand(g2, [[0, dave.id, 100], [1, alice.id, 100]], [sb(0), bb(1), act(0, 'fold'), award([1], [3])], { 0: 99, 1: 101 });
  // g3 h5: alice raises, dave calls, alice c-bets, dave folds. Alice +6.
  await insertHand(
    g3,
    [[0, alice.id, 100], [1, dave.id, 100]],
    [sb(0), bb(1), act(0, 'raise', 6), act(1, 'call', 6), flop, act(1, 'check'), act(0, 'bet', 6), act(1, 'fold'), award([0], [18])],
    { 0: 106, 1: 94 },
  );

  await pool.query(
    `insert into tournament_results (game_id, user_id, place, prize) values
       ($1, $4, 1, 100), ($1, $5, 2, 0), ($2, $4, 3, 0), ($3, $4, 1, 50)`,
    [g1, g2, g3, alice.id, bob.id],
  );
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

describe('GET /api/stats/:userId', () => {
  it('self view covers all of my hands and tournaments', async () => {
    const res = await getStats(alice, alice.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('all');
    expect(body.user).toEqual({ id: alice.id, displayName: 'Alice', avatarUrl: `/api/users/${alice.id}/avatar.svg` });
    expect(aliceRecords).toHaveLength(5);
    expect(body.stats).toEqual(computeStats(aliceRecords, alice.id));
    expect(body.stats.hands).toBe(5);
    expect(body.stats.vpip).toBeCloseTo(0.6);
    expect(body.stats.pfr).toBeCloseTo(0.4);
    expect(body.stats.netChips).toBe(1);
    expect(body.tournamentsPlayed).toBe(3);
    expect(body.tournamentsWon).toBe(2);
  });

  it('never includes hole cards or raw records', async () => {
    const res = await getStats(alice, alice.id);
    expect(Object.keys(res.json()).sort()).toEqual(['scope', 'stats', 'tournamentsPlayed', 'tournamentsWon', 'user']);
    expect(res.body).not.toMatch(/hole|events|playerIds|handStarted/);
  });

  it('a friend who shared one game sees only that game', async () => {
    const res = await getStats(bob, alice.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('shared');
    expect(body.stats).toEqual(computeStats(aliceRecords.slice(0, 2), alice.id));
    expect(body.stats.hands).toBe(2);
    expect(body.stats.vpip).toBeCloseTo(0.5);
    expect(body.stats.pfr).toBeCloseTo(0.5);
    expect(body.stats.netChips).toBe(0);
    expect(body.tournamentsPlayed).toBe(1);
    expect(body.tournamentsWon).toBe(1);
  });

  it('a friend who hosts a game (without playing) sees its hands', async () => {
    const res = await getStats(carol, alice.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('shared');
    expect(body.stats).toEqual(computeStats(aliceRecords.slice(2, 4), alice.id));
    expect(body.stats.hands).toBe(2);
    expect(body.stats.vpip).toBeCloseTo(0.5);
    expect(body.stats.pfr).toBe(0);
    expect(body.stats.netChips).toBe(-5);
    expect(body.tournamentsPlayed).toBe(1);
    expect(body.tournamentsWon).toBe(0);
  });

  it('a non-friend gets 403, even with shared games', async () => {
    const res = await getStats(dave, alice.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'You can only see stats of your friends' });
  });

  it('a pending friendship gets 403', async () => {
    const res = await getStats(erin, alice.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'You can only see stats of your friends' });
  });

  it('unknown user → 404', async () => {
    const res = await getStats(alice, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(typeof res.json().error).toBe('string');
  });

  it('non-uuid → 400', async () => {
    const res = await getStats(alice, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('unauthenticated → 401', async () => {
    const res = await getStats(null, alice.id);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Not signed in' });
  });

  it('a user with no hands gets all zeros', async () => {
    const res = await getStats(zed, zed.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      scope: 'all',
      stats: { hands: 0, vpip: 0, pfr: 0, af: 0, wtsd: 0, wonAtShowdown: 0, netChips: 0 },
      tournamentsPlayed: 0,
      tournamentsWon: 0,
    });
  });
});
