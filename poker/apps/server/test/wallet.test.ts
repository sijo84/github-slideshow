import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';
import {
  balance,
  buyIn,
  cashOut,
  ensureAccount,
  grant,
  InsufficientFundsError,
  transfer,
  walletBalance,
} from '../src/wallet/ledger.js';

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;

type User = Awaited<ReturnType<typeof makeUser>>;

async function makeGame(host: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at) values ($1, 'Test game', '{}'::jsonb, now()) returning id`,
    [host],
  );
  const row = rows[0];
  if (!row) throw new Error('no game row');
  return row.id;
}

async function invite(gameId: string, userId: string): Promise<void> {
  await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [gameId, userId]);
}

async function entryCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select count(*)::bigint as n from ledger_entries');
  return rows[0]?.n ?? 0;
}

function tableAcct(userId: string, gameId: string): Promise<string> {
  return ensureAccount(pool, 'table', userId, gameId);
}

/** Rejects if `p` does not settle within `ms`, so a broken lock can never hang the suite. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
});

afterAll(async () => {
  await app.close();
  await db.cleanup();
});

describe('ledger', () => {
  it('grant then balance', async () => {
    const u = await makeUser(pool, 'Granted');
    expect(await walletBalance(pool, u.id)).toBe(0);
    await grant(pool, u.id, 500, 'test grant');
    await grant(pool, u.id, 250, 'test grant');
    expect(await walletBalance(pool, u.id)).toBe(750);
    expect(await balance(pool, await ensureAccount(pool, 'wallet', u.id))).toBe(750);
  });

  it('buyIn moves chips wallet → table and cashOut moves them back', async () => {
    const u = await makeUser(pool, 'Buyer');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 1000, 'test grant');
    await buyIn(pool, u.id, game, 600);
    expect(await walletBalance(pool, u.id)).toBe(400);
    expect(await balance(pool, await tableAcct(u.id, game))).toBe(600);
    await cashOut(pool, u.id, game, 450);
    expect(await walletBalance(pool, u.id)).toBe(850);
    expect(await balance(pool, await tableAcct(u.id, game))).toBe(150);
    await expect(cashOut(pool, u.id, game, 151)).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('buyIn above the balance throws InsufficientFundsError and writes nothing', async () => {
    const u = await makeUser(pool, 'Short');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 100, 'test grant');
    const before = await entryCount();
    const err = await buyIn(pool, u.id, game, 101).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).statusCode).toBe(409);
    expect(await entryCount()).toBe(before);
    expect(await walletBalance(pool, u.id)).toBe(100);
    // The rolled-back transaction did not leave a table account behind either.
    const { rowCount } = await pool.query("select 1 from ledger_accounts where kind = 'table' and game_id = $1", [game]);
    expect(rowCount).toBe(0);
  });

  it('rejects non-positive, non-integer and unsafe amounts, and same-account transfers', async () => {
    const u = await makeUser(pool, 'Amounts');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 100, 'test grant');
    const before = await entryCount();
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(grant(pool, u.id, bad, 'bad')).rejects.toThrow(RangeError);
      await expect(buyIn(pool, u.id, game, bad)).rejects.toThrow(RangeError);
    }
    const wallet = await ensureAccount(pool, 'wallet', u.id);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await expect(transfer(client, wallet, wallet, 10, 'self')).rejects.toThrow(RangeError);
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect(await entryCount()).toBe(before);
  });

  it('20 parallel buy-ins of 1000 from a 10,000 wallet: exactly 10 succeed', async () => {
    const u = await makeUser(pool, 'Parallel');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 10_000, 'test grant');
    const results = await withTimeout(
      Promise.allSettled(Array.from({ length: 20 }, () => buyIn(pool, u.id, game, 1000))),
      20_000,
      'parallel buy-ins',
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const f of failed) expect(f.reason).toBeInstanceOf(InsufficientFundsError);
    expect(await walletBalance(pool, u.id)).toBe(0);
    expect(await balance(pool, await tableAcct(u.id, game))).toBe(10_000);
  });

  it('deterministic race: the row lock makes the second transfer see the first one', async () => {
    const u = await makeUser(pool, 'Racer');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 1000, 'test grant');
    const wallet = await ensureAccount(pool, 'wallet', u.id);
    const table = await tableAcct(u.id, game);

    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const pending: Promise<string>[] = [];
    try {
      for (const c of [c1, c2]) await c.query("set lock_timeout = '10s'");
      const pidRes = await c2.query<{ pid: number }>('select pg_backend_pid() as pid');
      const secondPid = pidRes.rows[0]?.pid;

      const flags = { firstTransferred: false, secondTransferred: false };
      const run = async (client: PoolClient, which: 'firstTransferred' | 'secondTransferred'): Promise<string> => {
        await client.query('begin');
        try {
          const tx = await transfer(client, wallet, table, 800, 'race');
          flags[which] = true;
          await barrier;
          await client.query('commit');
          return tx;
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      };

      const first = run(c1, 'firstTransferred');
      pending.push(first);
      // Wait until the first transfer holds its locks before starting the second.
      const t0 = Date.now();
      while (!flags.firstTransferred && Date.now() - t0 < 5000) await pause(10);
      expect(flags.firstTransferred).toBe(true);

      const second = run(c2, 'secondTransferred');
      pending.push(second);
      // Wait until the second is blocked on the row lock (or has finished, which means the lock is missing).
      const t1 = Date.now();
      let blocked = false;
      while (!blocked && !flags.secondTransferred && Date.now() - t1 < 2000) {
        const { rows } = await pool.query<{ waiting: boolean }>(
          "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
          [secondPid],
        );
        blocked = rows[0]?.waiting === true;
        if (!blocked) await pause(10);
      }

      releaseBarrier();
      const [r1, r2] = await withTimeout(Promise.allSettled([first, second]), 15_000, 'race transactions');
      // Without the row lock both transfers pass their balance check and the wallet ends at -600.
      expect(await walletBalance(pool, u.id)).toBe(200);
      expect(await balance(pool, table)).toBe(800);
      expect(blocked).toBe(true);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('rejected');
      expect(r2.status === 'rejected' ? r2.reason : null).toBeInstanceOf(InsufficientFundsError);
    } finally {
      releaseBarrier();
      // Never release a client while its query is still running.
      await withTimeout(Promise.allSettled(pending), 15_000, 'race cleanup').catch(() => undefined);
      c1.release();
      c2.release();
    }
  });

  it('two concurrent ensureAccount calls return the same id; only one bank account exists', async () => {
    const u = await makeUser(pool, 'Ensure');
    const [a, b] = await Promise.all([ensureAccount(pool, 'wallet', u.id), ensureAccount(pool, 'wallet', u.id)]);
    expect(a).toBe(b);
    const [x, y, z] = await Promise.all([ensureAccount(pool, 'bank'), ensureAccount(pool, 'bank', null, null), ensureAccount(pool, 'bank')]);
    expect(x).toBe(y);
    expect(y).toBe(z);
    const { rows } = await pool.query<{ n: number }>("select count(*)::bigint as n from ledger_accounts where kind = 'bank'");
    expect(rows[0]?.n).toBe(1);
  });
});

describe('wallet routes', () => {
  let host: User;
  let guest: User;
  let outsider: User;
  let gameId: string;
  let hostHeaders: { cookie: string; origin: string };

  beforeAll(async () => {
    host = await makeUser(pool, 'Host');
    guest = await makeUser(pool, 'Guest');
    outsider = await makeUser(pool, 'Outsider');
    gameId = await makeGame(host.id);
    await invite(gameId, guest.id);
    hostHeaders = await authed(app, host);
  });

  const grantReq = (headers: Record<string, string>, body: unknown, id = gameId) =>
    app.inject({ method: 'POST', url: `/api/games/${id}/grant`, headers, payload: body as object });

  it('GET /wallet with no account → balance 0 and no entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/wallet', headers: await authed(app, outsider) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ balance: 0, entries: [] });
  });

  it('GET /wallet shape and newest-first ordering', async () => {
    const u = await makeUser(pool, 'Viewer');
    const game = await makeGame(u.id);
    await grant(pool, u.id, 1000, 'first');
    await buyIn(pool, u.id, game, 300);
    await cashOut(pool, u.id, game, 100);
    const res = await app.inject({ method: 'GET', url: '/api/wallet', headers: await authed(app, u) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ balance: number; entries: { id: number; amount: number; reason: string; createdAt: string }[] }>();
    expect(body.balance).toBe(800);
    expect(body.entries.map((e) => [e.amount, e.reason])).toEqual([
      [100, 'cash-out'],
      [-300, 'buy-in'],
      [1000, 'first'],
    ]);
    for (const e of body.entries) {
      expect(Object.keys(e).sort()).toEqual(['amount', 'createdAt', 'id', 'reason']);
      expect(typeof e.id).toBe('number');
      expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);
    }
  });

  it('GET /wallet returns at most 50 entries', async () => {
    const u = await makeUser(pool, 'Many');
    for (let i = 0; i < 55; i++) await grant(pool, u.id, 1, `g${i}`);
    const res = await app.inject({ method: 'GET', url: '/api/wallet', headers: await authed(app, u) });
    const body = res.json<{ balance: number; entries: { reason: string }[] }>();
    expect(body.balance).toBe(55);
    expect(body.entries).toHaveLength(50);
    expect(body.entries[0]?.reason).toBe('g54');
  });

  it('host can grant to an invited player and to themself', async () => {
    const res = await grantReq(hostHeaders, { userId: guest.id, amount: 5000 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ balance: 5000 });
    const again = await grantReq(hostHeaders, { userId: guest.id, amount: 1 });
    expect(again.json()).toEqual({ balance: 5001 });
    const self = await grantReq(hostHeaders, { userId: host.id, amount: 1_000_000 });
    expect(self.statusCode).toBe(200);
    expect(self.json()).toEqual({ balance: 1_000_000 });
  });

  it('non-host → 403', async () => {
    const res = await grantReq(await authed(app, guest), { userId: guest.id, amount: 100 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('bad amounts and ids → 400', async () => {
    for (const amount of [0, 1_000_001, -1, 1.5, '100']) {
      const res = await grantReq(hostHeaders, { userId: guest.id, amount });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
    }
    expect((await grantReq(hostHeaders, { userId: 'nope', amount: 10 })).statusCode).toBe(400);
    expect((await grantReq(hostHeaders, { userId: guest.id, amount: 10 }, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('target not in the game → 400', async () => {
    const res = await grantReq(hostHeaders, { userId: outsider.id, amount: 100 });
    expect(res.statusCode).toBe(400);
    expect(await walletBalance(pool, outsider.id)).toBe(0);
  });

  it('unknown game → 404', async () => {
    const res = await grantReq(hostHeaders, { userId: guest.id, amount: 100 }, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/grant`,
      headers: { origin: hostHeaders.origin },
      payload: { userId: guest.id, amount: 100 },
    });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/wallet' })).statusCode).toBe(401);
  });
});

describe('ledger invariants (after everything above)', () => {
  it('is zero-sum overall and per tx, and no wallet/table account is negative', async () => {
    const total = await pool.query<{ total: number }>('select coalesce(sum(amount), 0)::bigint as total from ledger_entries');
    expect(total.rows[0]?.total).toBe(0);
    expect(await entryCount()).toBeGreaterThan(0);

    const badTx = await pool.query(
      'select tx_id from ledger_entries group by tx_id having sum(amount) <> 0 or count(*) < 2',
    );
    expect(badTx.rowCount).toBe(0);

    const negative = await pool.query(
      `select a.id from ledger_accounts a join ledger_entries e on e.account_id = a.id
        where a.kind in ('wallet', 'table') group by a.id having sum(e.amount) < 0`,
    );
    expect(negative.rowCount).toBe(0);
  });
});
