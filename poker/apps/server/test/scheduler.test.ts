import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../src/games/scheduler.js';
import { notify } from '../src/notify.js';
import { fakeClock, makeUser, testDb } from '../src/test/helpers.js';

const MIN = 60_000;

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
});

afterAll(async () => {
  await db?.cleanup();
});

const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  // Games left scheduled by one test must not be picked up by the next test's scheduler.
  await pool.query(`update games set status = 'finished' where status = 'scheduled'`);
});

async function insertGame(host: string, name: string, startsAtMs: number, status = 'scheduled'): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, $2, '{}'::jsonb, $3, $4) returning id`,
    [host, name, new Date(startsAtMs), status],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insert into games returned no row');
  return row.id;
}

async function invite(gameId: string, userId: string, rsvp: string): Promise<void> {
  await pool.query(`insert into game_invites (game_id, user_id, rsvp) values ($1, $2, $3)`, [gameId, userId, rsvp]);
}

async function notes(userId: string): Promise<{ kind: string; text: string; link: string | null }[]> {
  const res = await pool.query<{ kind: string; text: string; link: string | null }>(
    `select kind, text, link from notifications where user_id = $1 order by id`,
    [userId],
  );
  return res.rows;
}

async function statusOf(gameId: string): Promise<string | undefined> {
  const res = await pool.query<{ status: string }>(`select status from games where id = $1`, [gameId]);
  return res.rows[0]?.status;
}

/** Starts a scheduler on a fake clock; `tick(ms)` advances the clock and waits until the tick has finished and re-armed. */
function harness(open: (id: string) => Promise<void>, startMs?: number) {
  const clock = fakeClock(startMs);
  let armed = 0;
  const tables = { open: vi.fn(open) };
  const stop = startScheduler({
    pool,
    clock: clock.now,
    setTimer: (fn, ms) => {
      armed++;
      return clock.setTimer(fn, ms);
    },
    clearTimer: clock.clearTimer,
    tables,
    notify,
  });
  stops.push(stop);
  const tick = async (ms: number): Promise<void> => {
    const before = armed;
    await clock.advance(ms);
    await vi.waitFor(() => expect(armed).toBeGreaterThan(before), { timeout: 5000, interval: 5 });
  };
  return { clock, tables, stop, tick, armed: () => armed };
}

describe('scheduler', () => {
  it('opens table at starts_at and notifies RSVP yes', async () => {
    const T0 = 1_700_000_000_000;
    const host = await makeUser(pool, 'Host One');
    const yes = await makeUser(pool, 'Yes Guest');
    const maybe = await makeUser(pool, 'Maybe Guest');
    const no = await makeUser(pool, 'No Guest');
    const pending = await makeUser(pool, 'Pending Guest');
    const id = await insertGame(host.id, 'Friday Game', T0 + 20_000);
    await invite(id, yes.id, 'yes');
    await invite(id, maybe.id, 'maybe');
    await invite(id, no.id, 'no');
    await invite(id, pending.id, 'pending');

    const h = harness(async () => {}, T0);
    await h.tick(0); // T0
    await h.tick(15_000); // T0 + 15 s, still before the start
    expect(h.tables.open).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('scheduled');

    await h.tick(15_000); // T0 + 30 s, past the start
    expect(h.tables.open).toHaveBeenCalledTimes(1);
    expect(h.tables.open).toHaveBeenCalledWith(id);
    expect(await statusOf(id)).toBe('open');

    const starting = { kind: 'gameStarting', text: 'Friday Game is starting now', link: `/table/${id}` };
    for (const u of [host, yes, maybe]) expect(await notes(u.id)).toContainEqual(starting);
    for (const u of [no, pending]) expect(await notes(u.id)).toEqual([]);

    // Later ticks neither reopen nor notify again.
    await h.tick(15_000);
    expect(h.tables.open).toHaveBeenCalledTimes(1);
    expect((await notes(host.id)).filter((n) => n.text.endsWith('is starting now'))).toHaveLength(1);
  });

  it('sends the 10-minute reminder once across ticks and a restart', async () => {
    const T0 = 1_700_100_000_000;
    const host = await makeUser(pool, 'Host Two');
    const yes = await makeUser(pool, 'Yes Two');
    const no = await makeUser(pool, 'No Two');
    const id = await insertGame(host.id, 'Late Game', T0 + 5 * MIN);
    await invite(id, yes.id, 'yes');
    await invite(id, no.id, 'no');

    const first = harness(async () => {}, T0);
    await first.tick(0);
    await first.tick(15_000);
    await first.tick(15_000);
    first.stop();

    // A second instance (a restart) has no in-memory record and must rely on the notifications table.
    const second = harness(async () => {}, T0 + 60_000);
    await second.tick(0);
    await second.tick(15_000);

    const reminder = { kind: 'gameStarting', text: 'Late Game starts in 10 minutes', link: `/games/${id}` };
    expect(await notes(host.id)).toEqual([reminder]);
    expect(await notes(yes.id)).toEqual([reminder]);
    expect(await notes(no.id)).toEqual([]);
    expect(first.tables.open).not.toHaveBeenCalled();
    expect(second.tables.open).not.toHaveBeenCalled();
  });

  it('sends no reminder for a game more than 10 minutes away', async () => {
    const T0 = 1_700_200_000_000;
    const host = await makeUser(pool, 'Host Three');
    const yes = await makeUser(pool, 'Yes Three');
    const id = await insertGame(host.id, 'Far Game', T0 + 11 * MIN);
    await invite(id, yes.id, 'yes');

    const h = harness(async () => {}, T0);
    await h.tick(0);
    await h.tick(15_000);
    expect(await notes(host.id)).toEqual([]);
    expect(await notes(yes.id)).toEqual([]);

    // Once inside the window, the reminder arrives.
    await h.tick(45_000);
    await h.tick(15_000);
    expect(await notes(host.id)).toEqual([
      { kind: 'gameStarting', text: 'Far Game starts in 10 minutes', link: `/games/${id}` },
    ]);
  });

  it('ignores cancelled and already-open games', async () => {
    const T0 = 1_700_300_000_000;
    const host = await makeUser(pool, 'Host Four');
    const yes = await makeUser(pool, 'Yes Four');
    const cancelledDue = await insertGame(host.id, 'Cancelled Due', T0 - MIN, 'cancelled');
    const cancelledSoon = await insertGame(host.id, 'Cancelled Soon', T0 + 5 * MIN, 'cancelled');
    const openDue = await insertGame(host.id, 'Open Due', T0 - MIN, 'open');
    const openSoon = await insertGame(host.id, 'Open Soon', T0 + 5 * MIN, 'open');
    for (const g of [cancelledDue, cancelledSoon, openDue, openSoon]) await invite(g, yes.id, 'yes');

    const h = harness(async () => {}, T0);
    await h.tick(0);
    await h.tick(15_000);
    expect(h.tables.open).not.toHaveBeenCalled();
    expect(await notes(host.id)).toEqual([]);
    expect(await notes(yes.id)).toEqual([]);
    expect(await statusOf(cancelledDue)).toBe('cancelled');
    expect(await statusOf(openDue)).toBe('open');
  });

  it('keeps going when tables.open throws for one game', async () => {
    const T0 = 1_700_400_000_000;
    const host = await makeUser(pool, 'Host Five');
    const bad = await insertGame(host.id, 'Bad Game', T0 - 2 * MIN);
    const good = await insertGame(host.id, 'Good Game', T0 - MIN);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const h = harness(async (id) => {
      if (id === bad) throw new Error('boom');
    }, T0);
    await h.tick(0);

    expect(h.tables.open).toHaveBeenCalledWith(bad);
    expect(h.tables.open).toHaveBeenCalledWith(good);
    expect(await statusOf(bad)).toBe('scheduled');
    expect(await statusOf(good)).toBe('open');
    expect(errors).toHaveBeenCalled();
    expect(await notes(host.id)).toEqual([
      { kind: 'gameStarting', text: 'Good Game is starting now', link: `/table/${good}` },
    ]);

    // The loop is still alive and retries the failed game on the next tick.
    await h.tick(15_000);
    expect(h.tables.open.mock.calls.filter(([id]) => id === bad)).toHaveLength(2);
  });

  it('stop prevents further ticks, even when called during a tick', async () => {
    const T0 = 1_700_500_000_000;
    const host = await makeUser(pool, 'Host Six');

    // Stopped between ticks: a game becoming due later is never opened.
    const a = harness(async () => {}, T0);
    await a.tick(0);
    a.stop();
    const later = await insertGame(host.id, 'Later Game', T0 + 10_000);
    const armedAfterStop = a.armed();
    await a.clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.tables.open).not.toHaveBeenCalled();
    expect(a.armed()).toBe(armedAfterStop);
    expect(await statusOf(later)).toBe('scheduled');
    await pool.query(`update games set status = 'finished' where id = $1`, [later]);

    // Stopped while a tick is in flight: that tick finishes but does not re-arm.
    const due = await insertGame(host.id, 'Due Game', T0 + 100_000 - MIN);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const b = harness(() => gate, T0 + 100_000);
    await b.clock.advance(0);
    await vi.waitFor(() => expect(b.tables.open).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 5 });
    const armedBefore = b.armed();
    b.stop();
    release();
    await vi.waitFor(async () => expect(await statusOf(due)).toBe('open'), { timeout: 5000, interval: 5 });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.armed()).toBe(armedBefore);
    await b.clock.advance(60_000);
    expect(b.tables.open).toHaveBeenCalledTimes(1);
  });
});
