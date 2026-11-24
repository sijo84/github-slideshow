import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { GameSettingsSchema, type GameSettings } from '@poker/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { prizes, TournamentController } from '../src/games/tournament.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';
import { balance, buyIn, ensureAccount, grant, InsufficientFundsError, transfer, walletBalance } from '../src/wallet/ledger.js';

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;

type User = Awaited<ReturnType<typeof makeUser>>;

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const STACK = 1500;

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return GameSettingsSchema.parse({
    kind: 'tournament',
    maxSeats: 9,
    levels: [
      { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, anteKind: 'none', durationMinutes: 10 },
      { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, anteKind: 'none', durationMinutes: 10 },
      { level: 3, smallBlind: 50, bigBlind: 100, ante: 0, anteKind: 'none', durationMinutes: 10 },
    ],
    minBuyIn: STACK,
    maxBuyIn: STACK,
    startingStack: STACK,
    rebuys: { allowed: true, untilLevel: 1 },
    payouts: [65, 35],
    seatApproval: false,
    showAllInEquity: true,
    ...overrides,
  });
}

async function makeGame(host: string, s: GameSettings | Record<string, unknown>): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, 'Test game', $2::jsonb, now(), 'running') returning id`,
    [host, JSON.stringify(s)],
  );
  const row = rows[0];
  if (!row) throw new Error('no game row');
  return row.id;
}

async function invite(gameId: string, userId: string): Promise<void> {
  await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [gameId, userId]);
}

/** A tournament with `names.length` entrants, each granted 10,000 and bought in. */
async function setup(
  names: string[],
  s: GameSettings = settings(),
  pausedMs: () => number = () => 0,
): Promise<{ gameId: string; users: User[]; ctl: TournamentController }> {
  const users: User[] = [];
  for (const n of names) users.push(await makeUser(pool, n));
  const host = users[0];
  if (!host) throw new Error('no users');
  const gameId = await makeGame(host.id, s);
  for (const u of users) {
    if (u !== host) await invite(gameId, u.id);
    await grant(pool, u.id, 10_000, 'test grant');
    await buyIn(pool, u.id, gameId, s.startingStack);
  }
  const ctl = new TournamentController({ pool, gameId, settings: s, startedAtMs: T0, pausedMs });
  return { gameId, users, ctl };
}

/** Simulates a hand's chip movement between two players' table accounts. */
async function move(gameId: string, from: string, to: string, amount: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const a = await ensureAccount(client, 'table', from, gameId);
    const b = await ensureAccount(client, 'table', to, gameId);
    await transfer(client, a, b, amount, 'test hand');
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function hand(...rows: [User, number, number][]): { userId: string; startStack: number; endStack: number }[] {
  return rows.map(([u, startStack, endStack]) => ({ userId: u.id, startStack, endStack }));
}

/** Returns [smaller id, larger id]. */
function byId(a: User, b: User): [User, User] {
  return a.id < b.id ? [a, b] : [b, a];
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
});

afterAll(async () => {
  await app.close();
  await db.cleanup();
});

describe('prizes', () => {
  it('65/35 with 3 players and a pool of 4500', () => {
    expect(prizes(4500, [65, 35], [['a'], ['b'], ['c']])).toEqual([
      { userId: 'a', place: 1, prize: 2925 },
      { userId: 'b', place: 2, prize: 1575 },
      { userId: 'c', place: 3, prize: 0 },
    ]);
  });

  it('gives the rounding remainder to first place', () => {
    // 650.65 → 650, 350.35 → 350; the 1 chip left goes to place 1.
    expect(prizes(1001, [65, 35], [['a'], ['b']]).map((p) => p.prize)).toEqual([651, 350]);
  });

  it('a tie for 2nd–3rd shares 30 + 20 equally, remainder one each in array order', () => {
    // 1010: 505 / 303 / 202; places 2–3 share 505 → 253 and 252.
    expect(prizes(1010, [50, 30, 20], [['a'], ['b', 'c']])).toEqual([
      { userId: 'a', place: 1, prize: 505 },
      { userId: 'b', place: 2, prize: 253 },
      { userId: 'c', place: 2, prize: 252 },
    ]);
    expect(prizes(1000, [50, 30, 20], [['a'], ['b', 'c'], ['d']]).map((p) => p.prize)).toEqual([500, 250, 250, 0]);
  });

  it('pays the whole pool even with fewer players than paid places', () => {
    expect(prizes(1000, [50, 30, 20], [['a'], ['b']]).map((p) => p.prize)).toEqual([700, 300]);
  });

  it('the total paid always equals the pool', () => {
    const payoutsArb = fc
      .array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 8 })
      .map((ws) => {
        // Integer percents that sum to exactly 100.
        const total = ws.reduce((a, b) => a + b, 0);
        const pcts = ws.map((w) => Math.max(1, Math.floor((w * 100) / total)));
        let diff = 100 - pcts.reduce((a, b) => a + b, 0);
        for (let i = 0; diff !== 0; i = (i + 1) % pcts.length) {
          const p = pcts[i] ?? 1;
          if (diff > 0) {
            pcts[i] = p + 1;
            diff--;
          } else if (p > 1) {
            pcts[i] = p - 1;
            diff++;
          }
        }
        return pcts;
      });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        payoutsArb,
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 9 }),
        (pool, payouts, sizes) => {
          expect(payouts.reduce((a, b) => a + b, 0)).toBe(100);
          let n = 0;
          const order = sizes.map((k) => Array.from({ length: k }, () => `p${n++}`));
          const out = prizes(pool, payouts, order);
          expect(out).toHaveLength(n);
          expect(out.reduce((a, p) => a + p.prize, 0)).toBe(pool);
          for (const p of out) expect(Number.isSafeInteger(p.prize) && p.prize >= 0).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('places', () => {
  it('one bust per hand takes the worst free place', async () => {
    const { users, ctl } = await setup(['Ann', 'Bob', 'Cid', 'Dee']);
    const [a, b, c, d] = users as [User, User, User, User];
    let r = await ctl.onHandEnded(hand([a, STACK, 3000], [b, STACK, STACK], [c, STACK, STACK], [d, STACK, 0]), T0);
    expect(r).toEqual({ eliminated: [{ userId: d.id, place: 4 }], finished: false });
    r = await ctl.onHandEnded(hand([a, 3000, 4500], [b, STACK, STACK], [c, STACK, 0]), T0);
    expect(r).toEqual({ eliminated: [{ userId: c.id, place: 3 }], finished: false });
    const res = await ctl.results();
    expect(res.map((x) => [x.name, x.place, x.prize])).toEqual([
      ['Cid', 3, 0],
      ['Dee', 4, 0],
    ]);
  });

  it('two busting in the same hand: the bigger start stack gets the better place', async () => {
    const { users, ctl } = await setup(['Ann', 'Bob', 'Cid', 'Dee']);
    const [a, b] = users as [User, User, User, User];
    // The smaller-stack player has the smaller user id, so ordering by id would be wrong.
    const [small, big] = byId(users[2] as User, users[3] as User);
    const r = await ctl.onHandEnded(hand([a, STACK, 3500], [b, STACK, STACK], [small, 500, 0], [big, 1000, 0]), T0);
    expect(r.finished).toBe(false);
    expect(r.eliminated).toEqual([
      { userId: big.id, place: 3 },
      { userId: small.id, place: 4 },
    ]);
  });

  it('two busting in the same hand with equal start stacks share the place', async () => {
    const { users, ctl } = await setup(['Ann', 'Bob', 'Cid', 'Dee']);
    const [a, b, c, d] = users as [User, User, User, User];
    const r = await ctl.onHandEnded(hand([a, STACK, 4000], [b, STACK, 2000], [c, 1000, 0], [d, 1000, 0]), T0);
    expect(r.finished).toBe(false);
    expect(new Set(r.eliminated.map((e) => e.place))).toEqual(new Set([3]));
    expect(r.eliminated.map((e) => e.userId).sort()).toEqual([c.id, d.id].sort());
  });
});

describe('levels', () => {
  it('follow the schedule, exclude paused time, and the last level has no next', async () => {
    let paused = 0;
    const { ctl } = await setup(['Ann', 'Bob'], settings(), () => paused);
    expect(ctl.levelFor(T0).level).toBe(1);
    expect(ctl.nextLevelAt(T0)).toBe(T0 + 10 * MIN);
    expect(ctl.levelFor(T0 + 9 * MIN).level).toBe(1);
    expect(ctl.levelFor(T0 + 10 * MIN).level).toBe(2);
    expect(ctl.nextLevelAt(T0 + 12 * MIN)).toBe(T0 + 20 * MIN);

    paused = 3 * MIN;
    expect(ctl.levelFor(T0 + 12 * MIN).level).toBe(1);
    expect(ctl.nextLevelAt(T0 + 12 * MIN)).toBe(T0 + 13 * MIN);
    expect(ctl.levelFor(T0 + 13 * MIN).level).toBe(2);

    expect(ctl.levelFor(T0 + 25 * MIN).level).toBe(3);
    expect(ctl.nextLevelAt(T0 + 25 * MIN)).toBeNull();
    expect(ctl.levelFor(T0 + 500 * MIN).level).toBe(3);
    expect(ctl.nextLevelAt(T0 + 500 * MIN)).toBeNull();
  });
});

describe('rebuys', () => {
  it('allowed until untilLevel and debit the wallet; refused (409) after', async () => {
    const { gameId, users, ctl } = await setup(['Ann', 'Bob', 'Cid']);
    const [a, b, c] = users as [User, User, User];
    await move(gameId, b.id, a.id, STACK);
    await ctl.onHandEnded(hand([a, STACK, 3000], [b, STACK, 0], [c, STACK, STACK]), T0 + MIN);
    // b was eliminated by that call; use c (still in) for the level checks.
    expect(ctl.canRebuy(c.id, T0 + 5 * MIN)).toBe(true);
    const before = await walletBalance(pool, c.id);
    await expect(ctl.rebuy(c.id, T0 + 5 * MIN)).resolves.toBe(STACK);
    expect(await walletBalance(pool, c.id)).toBe(before - STACK);
    const tableAcct = await ensureAccount(pool, 'table', c.id, gameId);
    expect(await balance(pool, tableAcct)).toBe(2 * STACK);

    expect(ctl.canRebuy(c.id, T0 + 11 * MIN)).toBe(false);
    await expect(ctl.rebuy(c.id, T0 + 11 * MIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(await walletBalance(pool, c.id)).toBe(before - STACK);
  });

  it('a player busting in the first hand can rebuy before onHandEnded; an eliminated player cannot', async () => {
    const { gameId, users, ctl } = await setup(['Ann', 'Bob', 'Cid', 'Dee']);
    const [a, b, c, d] = users as [User, User, User, User];
    // First hand: Bob and Cid both bust to Ann. The controller has seen no hand yet.
    await move(gameId, b.id, a.id, STACK);
    await move(gameId, c.id, a.id, STACK);
    expect(ctl.canRebuy(b.id, T0)).toBe(true);
    expect(ctl.canRebuy(c.id, T0)).toBe(true);
    const before = await walletBalance(pool, b.id);
    expect(await ctl.rebuy(b.id, T0)).toBe(STACK);
    expect(await walletBalance(pool, b.id)).toBe(before - STACK);

    // Bob's endStack includes the rebuy; Cid did not rebuy and is eliminated.
    const r = await ctl.onHandEnded(hand([a, STACK, 4500], [b, STACK, STACK], [c, STACK, 0], [d, STACK, STACK]), T0);
    expect(r).toEqual({ eliminated: [{ userId: c.id, place: 4 }], finished: false });
    expect(ctl.canRebuy(c.id, T0)).toBe(false);
    await expect(ctl.rebuy(c.id, T0)).rejects.toMatchObject({ statusCode: 409 });
    expect(ctl.canRebuy(b.id, T0)).toBe(true);
  });

  it('refused when rebuys are off', async () => {
    const { users, ctl } = await setup(['Ann', 'Bob'], settings({ rebuys: { allowed: false, untilLevel: 3 } }));
    const [a, b] = users as [User, User];
    await ctl.onHandEnded(hand([a, STACK, STACK], [b, STACK, STACK]), T0);
    expect(ctl.canRebuy(a.id, T0)).toBe(false);
  });

  it('an insufficient wallet throws InsufficientFundsError', async () => {
    const { users, ctl } = await setup(['Ann', 'Bob']);
    const [a, b] = users as [User, User];
    await ctl.onHandEnded(hand([a, STACK, STACK], [b, STACK, STACK]), T0);
    // Spend the wallet down to less than a buy-in.
    const other = await makeGame(a.id, settings());
    await buyIn(pool, b.id, other, (await walletBalance(pool, b.id)) - 100);
    await expect(ctl.rebuy(b.id, T0)).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe('finish, end to end', () => {
  it('sweeps the table accounts, pays 65/35 of the 4-entry pool and stores the results', async () => {
    const { gameId, users, ctl } = await setup(['Ann', 'Bob', 'Cid']);
    const [a, b, c] = users as [User, User, User];

    // Hand 1: Bob loses everything to Ann and rebuys.
    await move(gameId, b.id, a.id, STACK);
    expect(ctl.canRebuy(b.id, T0 + MIN)).toBe(true);
    expect(await ctl.rebuy(b.id, T0 + MIN)).toBe(STACK);
    let r = await ctl.onHandEnded(hand([a, STACK, 3000], [b, STACK, STACK], [c, STACK, STACK]), T0 + MIN);
    expect(r).toEqual({ eliminated: [], finished: false });

    // Hand 2: Cid busts to Ann.
    await move(gameId, c.id, a.id, STACK);
    r = await ctl.onHandEnded(hand([a, 3000, 4500], [b, STACK, STACK], [c, STACK, 0]), T0 + 2 * MIN);
    expect(r).toEqual({ eliminated: [{ userId: c.id, place: 3 }], finished: false });

    // Hand 3: Bob busts to Ann; Ann wins.
    await move(gameId, b.id, a.id, STACK);
    r = await ctl.onHandEnded(hand([a, 4500, 6000], [b, STACK, 0]), T0 + 3 * MIN);
    expect(r).toEqual({ eliminated: [{ userId: b.id, place: 2 }], finished: true });

    const pot = 4 * STACK; // 3 buy-ins + 1 rebuy = 6000
    const { rows } = await pool.query<{ user_id: string; place: number; prize: number }>(
      'select user_id, place, prize from tournament_results where game_id = $1 order by place',
      [gameId],
    );
    expect(rows).toEqual([
      { user_id: a.id, place: 1, prize: (pot * 65) / 100 },
      { user_id: b.id, place: 2, prize: (pot * 35) / 100 },
      { user_id: c.id, place: 3, prize: 0 },
    ]);

    expect(await walletBalance(pool, a.id)).toBe(10_000 - STACK + 3900);
    expect(await walletBalance(pool, b.id)).toBe(10_000 - 2 * STACK + 2100);
    expect(await walletBalance(pool, c.id)).toBe(10_000 - STACK);

    const tables = await pool.query<{ total: number }>(
      `select coalesce(sum(e.amount), 0)::bigint as total from ledger_accounts a left join ledger_entries e on e.account_id = a.id
        where a.kind = 'table' and a.game_id = $1 group by a.id`,
      [gameId],
    );
    expect(tables.rows).toHaveLength(3);
    for (const t of tables.rows) expect(t.total).toBe(0);
    const sum = await pool.query<{ total: number }>('select coalesce(sum(amount), 0)::bigint as total from ledger_entries');
    expect(sum.rows[0]?.total).toBe(0);

    expect(await ctl.results()).toEqual([
      { userId: a.id, name: 'Ann', place: 1, prize: 3900 },
      { userId: b.id, name: 'Bob', place: 2, prize: 2100 },
      { userId: c.id, name: 'Cid', place: 3, prize: 0 },
    ]);
    await expect(ctl.onHandEnded(hand([a, 6000, 6000]), T0 + 4 * MIN)).rejects.toThrow();
    expect(ctl.canRebuy(a.id, T0 + 4 * MIN)).toBe(false);
  });
});

describe('GET /api/games/:id/results', () => {
  it('tournament: stored standings ordered by place', async () => {
    const host = await makeUser(pool, 'Host');
    const p = await makeUser(pool, 'Pam');
    const gameId = await makeGame(host.id, settings());
    await invite(gameId, p.id);

    let res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results`, headers: await authed(app, p) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });

    await pool.query('insert into tournament_results (game_id, user_id, place, prize) values ($1, $2, 2, 0), ($1, $3, 1, 3000)', [
      gameId,
      p.id,
      host.id,
    ]);
    res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results`, headers: await authed(app, p) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { userId: host.id, name: 'Host', place: 1, prize: 3000 },
        { userId: p.id, name: 'Pam', place: 2, prize: 0 },
      ],
    });
  });

  it('cash: sum of nets, ties share a place, prize 0', async () => {
    const host = await makeUser(pool, 'Hal');
    const x = await makeUser(pool, 'Xia');
    const y = await makeUser(pool, 'Yul');
    const gameId = await makeGame(host.id, settings({ kind: 'cash', levels: settings().levels.slice(0, 1), minBuyIn: 100, maxBuyIn: 2000 }));
    await invite(gameId, x.id);
    await invite(gameId, y.id);

    let res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results`, headers: await authed(app, host) });
    expect(res.json()).toEqual({ results: [] });

    // Hand 1: host +200, x −100, y −100. Hand 2: x +50, y +50, host −100.
    const nets = [
      [200, -100, -100],
      [-100, 50, 50],
    ];
    for (const [i, [h, xn, yn]] of nets.entries()) {
      const handId = randomUUID();
      await pool.query(
        `insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, '{}'::jsonb, now(), now())`,
        [handId, gameId, i + 1],
      );
      await pool.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, 0, $3), ($1, $4, 1, $5), ($1, $6, 2, $7)', [
        handId,
        host.id,
        h,
        x.id,
        xn,
        y.id,
        yn,
      ]);
    }
    res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results`, headers: await authed(app, host) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { userId: host.id, name: 'Hal', place: 1, prize: 0 },
        { userId: x.id, name: 'Xia', place: 2, prize: 0 },
        { userId: y.id, name: 'Yul', place: 2, prize: 0 },
      ],
    });
  });

  it('403 for a stranger, 404 for an unknown game, 400 for a bad id, 401 signed out', async () => {
    const host = await makeUser(pool, 'Hob');
    const stranger = await makeUser(pool, 'Sal');
    const gameId = await makeGame(host.id, settings());
    let res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results`, headers: await authed(app, stranger) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.any(String) });
    res = await app.inject({ method: 'GET', url: `/api/games/${randomUUID()}/results`, headers: await authed(app, host) });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: '/api/games/not-a-uuid/results', headers: await authed(app, host) });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/games/${gameId}/results` });
    expect(res.statusCode).toBe(401);
  });
});
