import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { notify, setNotifyEmitter, type NotifyPayload } from '../src/notify.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

interface ListBody {
  unread: number;
  notifications: { id: string; kind: string; text: string; link: string | null; read: boolean; createdAt: string }[];
}

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

afterEach(() => {
  setNotifyEmitter(null);
});

async function list(user: { id: string }): Promise<ListBody> {
  const res = await app.inject({ method: 'GET', url: '/api/notifications', headers: await authed(app, user) });
  expect(res.statusCode).toBe(200);
  return res.json<ListBody>();
}

async function post(user: { id: string }, url: string): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({ method: 'POST', url, headers: await authed(app, user) });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('notify', () => {
  it('inserts the row and returns the payload', async () => {
    const u = await makeUser(pool, 'N1');
    const p = await notify(pool, u.id, 'invite', 'You are invited', '/games/abc');
    expect(p).toEqual({ id: expect.stringMatching(/^[1-9][0-9]*$/), kind: 'invite', text: 'You are invited', link: '/games/abc' });
    const { rows } = await pool.query('select user_id, kind, text, link, read from notifications where id = $1', [p.id]);
    expect(rows).toEqual([{ user_id: u.id, kind: 'invite', text: 'You are invited', link: '/games/abc', read: false }]);
  });

  it('omits link when there is none', async () => {
    const u = await makeUser(pool, 'N2');
    const p = await notify(pool, u.id, 'gameStarting', 'Starting soon');
    expect(p).not.toHaveProperty('link');
    const { rows } = await pool.query<{ link: string | null }>('select link from notifications where id = $1', [p.id]);
    expect(rows[0]?.link).toBeNull();
  });

  it('calls the emitter with (userId, payload)', async () => {
    const u = await makeUser(pool, 'N3');
    const fn = vi.fn<(userId: string, payload: NotifyPayload) => void>();
    setNotifyEmitter(fn);
    const p = await notify(pool, u.id, 'seatRequest', 'Seat request');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(u.id, p);
  });

  it('swallows a throwing emitter', async () => {
    const u = await makeUser(pool, 'N4');
    setNotifyEmitter(() => {
      throw new Error('socket down');
    });
    const p = await notify(pool, u.id, 'integrityFlag', 'Flagged');
    expect(p.kind).toBe('integrityFlag');
    const { rowCount } = await pool.query('select 1 from notifications where id = $1', [p.id]);
    expect(rowCount).toBe(1);
  });

  it('setNotifyEmitter(null) stops emitting', async () => {
    const u = await makeUser(pool, 'N5');
    const fn = vi.fn();
    setNotifyEmitter(fn);
    setNotifyEmitter(null);
    await notify(pool, u.id, 'invite', 'Quiet');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  it('lists newest first with the unread count, including rows inserted by other code', async () => {
    const u = await makeUser(pool, 'L1');
    await pool.query(
      `insert into notifications (user_id, kind, text, link, created_at) values
         ($1, 'invite', 'first', null, now() - interval '3 minutes'),
         ($1, 'friendRequest', 'Bob wants to be friends', '/friends', now() - interval '2 minutes')`,
      [u.id],
    );
    const third = await notify(pool, u.id, 'gameStarting', 'third');
    const body = await list(u);
    expect(body.unread).toBe(3);
    expect(body.notifications.map((n) => n.text)).toEqual(['third', 'Bob wants to be friends', 'first']);
    expect(body.notifications[0]).toEqual({
      id: third.id,
      kind: 'gameStarting',
      text: 'third',
      link: null,
      read: false,
      createdAt: expect.any(String),
    });
    expect(new Date(body.notifications[0]?.createdAt ?? '').toISOString()).toBe(body.notifications[0]?.createdAt);
    expect(body.notifications[1]).toMatchObject({ kind: 'friendRequest', link: '/friends', read: false });
  });

  it('marks one read; another user cannot mark it or see it', async () => {
    const a = await makeUser(pool, 'Alice');
    const b = await makeUser(pool, 'Bob');
    const p1 = await notify(pool, a.id, 'invite', 'one');
    await notify(pool, a.id, 'invite', 'two');

    expect(await post(b, `/api/notifications/${p1.id}/read`)).toEqual({ statusCode: 404, body: { error: 'Notification not found' } });
    expect((await list(b)).notifications).toEqual([]);
    expect((await list(a)).unread).toBe(2);

    expect(await post(a, `/api/notifications/${p1.id}/read`)).toEqual({ statusCode: 200, body: { ok: true } });
    const body = await list(a);
    expect(body.unread).toBe(1);
    expect(body.notifications.find((n) => n.id === p1.id)?.read).toBe(true);
  });

  it('404 for an id that does not exist', async () => {
    const u = await makeUser(pool, 'Xavier');
    expect((await post(u, '/api/notifications/999999999/read')).statusCode).toBe(404);
  });

  it('400 for a bad id', async () => {
    const u = await makeUser(pool, 'Bad');
    for (const id of ['abc', '0', '-1', '1.5', '01', '99999999999999999999']) {
      const res = await post(u, `/api/notifications/${id}/read`);
      expect(res.statusCode, id).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    }
  });

  it('read-all marks only mine', async () => {
    const a = await makeUser(pool, 'RA');
    const b = await makeUser(pool, 'RB');
    await notify(pool, a.id, 'invite', 'a1');
    await notify(pool, a.id, 'invite', 'a2');
    await notify(pool, b.id, 'invite', 'b1');
    expect(await post(a, '/api/notifications/read-all')).toEqual({ statusCode: 200, body: { ok: true } });
    const body = await list(a);
    expect(body.unread).toBe(0);
    expect(body.notifications.every((n) => n.read)).toBe(true);
    expect((await list(b)).unread).toBe(1);
  });

  it('401 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Not signed in' });
    expect((await app.inject({ method: 'POST', url: '/api/notifications/read-all' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/1/read' })).statusCode).toBe(401);
  });

  it('returns at most 50, while unread counts all', async () => {
    const u = await makeUser(pool, 'Many');
    await pool.query(
      `insert into notifications (user_id, kind, text, created_at)
       select $1, 'invite', 'n' || g, now() - (g || ' seconds')::interval from generate_series(1, 55) g`,
      [u.id],
    );
    const body = await list(u);
    expect(body.notifications).toHaveLength(50);
    expect(body.unread).toBe(55);
    expect(body.notifications[0]?.text).toBe('n1');
    expect(body.notifications[49]?.text).toBe('n50');
  });
});
