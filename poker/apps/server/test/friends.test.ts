import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { areFriends } from '../src/routes/friends.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type User = Awaited<ReturnType<typeof makeUser>>;
type Headers = Awaited<ReturnType<typeof authed>>;
interface FriendUser {
  id: string;
  displayName: string;
  avatarUrl: string;
}
interface FriendsBody {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
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

async function userWithHeaders(name: string): Promise<{ user: User; h: Headers }> {
  const user = await makeUser(pool, name);
  return { user, h: await authed(app, user) };
}

async function list(h: Headers): Promise<FriendsBody> {
  const res = await app.inject({ method: 'GET', url: '/api/friends', headers: h });
  expect(res.statusCode).toBe(200);
  return res.json<FriendsBody>();
}

function ids(users: FriendUser[]): string[] {
  return users.map((u) => u.id);
}

function request(h: Headers, payload: object) {
  return app.inject({ method: 'POST', url: '/api/friends/requests', headers: h, payload });
}

function action(h: Headers, userId: string, verb: 'accept' | 'decline') {
  return app.inject({ method: 'POST', url: `/api/friends/requests/${userId}/${verb}`, headers: h });
}

function remove(h: Headers, userId: string) {
  return app.inject({ method: 'DELETE', url: `/api/friends/${userId}`, headers: h });
}

describe('friends lifecycle', () => {
  it('request → incoming/outgoing → accept → friends → delete → gone', async () => {
    const a = await userWithHeaders('Ana');
    const b = await userWithHeaders('Ben');
    const c = await userWithHeaders('Cleo');

    const sent = await request(a.h, { userId: b.user.id });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ status: 'pending' });

    let la = await list(a.h);
    let lb = await list(b.h);
    expect(la).toEqual({
      friends: [],
      incoming: [],
      outgoing: [{ id: b.user.id, displayName: 'Ben', avatarUrl: `/api/users/${b.user.id}/avatar.svg` }],
    });
    expect(lb).toEqual({
      friends: [],
      incoming: [{ id: a.user.id, displayName: 'Ana', avatarUrl: `/api/users/${a.user.id}/avatar.svg` }],
      outgoing: [],
    });
    expect(await list(c.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await areFriends(pool, a.user.id, b.user.id)).toBe(false);

    // A third user cannot accept someone else's request.
    expect((await action(c.h, a.user.id, 'accept')).statusCode).toBe(404);
    // The sender cannot accept their own request.
    expect((await action(a.h, b.user.id, 'accept')).statusCode).toBe(404);

    const acc = await action(b.h, a.user.id, 'accept');
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ status: 'accepted' });

    la = await list(a.h);
    lb = await list(b.h);
    expect(ids(la.friends)).toEqual([b.user.id]);
    expect(ids(lb.friends)).toEqual([a.user.id]);
    expect(la.incoming).toEqual([]);
    expect(la.outgoing).toEqual([]);
    expect(lb.incoming).toEqual([]);
    expect(lb.outgoing).toEqual([]);
    expect(await areFriends(pool, a.user.id, b.user.id)).toBe(true);
    expect(await areFriends(pool, b.user.id, a.user.id)).toBe(true);
    expect(await areFriends(pool, a.user.id, c.user.id)).toBe(false);

    // Accepting again: nothing pending any more.
    expect((await action(b.h, a.user.id, 'accept')).statusCode).toBe(404);
    // Requesting again in either direction: already friends.
    expect((await request(a.h, { userId: b.user.id })).statusCode).toBe(409);
    expect((await request(b.h, { userId: a.user.id })).statusCode).toBe(409);

    // A third user cannot remove the friendship.
    expect((await remove(c.h, a.user.id)).statusCode).toBe(404);

    // The addressee can remove it (either direction works).
    const del = await remove(b.h, a.user.id);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    expect(await list(a.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await list(b.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await areFriends(pool, a.user.id, b.user.id)).toBe(false);
    expect((await remove(b.h, a.user.id)).statusCode).toBe(404);
  });

  it('lists are sorted by display name', async () => {
    const me = await userWithHeaders('Mia');
    const zed = await makeUser(pool, 'Zed');
    const al = await makeUser(pool, 'al');
    const bo = await makeUser(pool, 'Bo');
    for (const u of [zed, al, bo]) expect((await request(me.h, { userId: u.id })).statusCode).toBe(201);
    expect(ids((await list(me.h)).outgoing)).toEqual([al.id, bo.id, zed.id]);
  });

  it('decline deletes the incoming request', async () => {
    const a = await userWithHeaders('Dan');
    const b = await userWithHeaders('Eve');
    expect((await request(a.h, { userId: b.user.id })).statusCode).toBe(201);
    // The sender cannot decline their own request.
    expect((await action(a.h, b.user.id, 'decline')).statusCode).toBe(404);
    const res = await action(b.h, a.user.id, 'decline');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await list(a.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await list(b.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect((await action(b.h, a.user.id, 'decline')).statusCode).toBe(404);
    // A fresh request can be sent after a decline.
    expect((await request(a.h, { userId: b.user.id })).statusCode).toBe(201);
  });

  it('the sender can cancel their own outgoing request, the addressee cannot via DELETE', async () => {
    const a = await userWithHeaders('Finn');
    const b = await userWithHeaders('Gus');
    expect((await request(a.h, { userId: b.user.id })).statusCode).toBe(201);
    // DELETE by the addressee does not cancel someone else's pending request (decline does that).
    expect((await remove(b.h, a.user.id)).statusCode).toBe(404);
    expect(ids((await list(b.h)).incoming)).toEqual([a.user.id]);
    const res = await remove(a.h, b.user.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await list(a.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
    expect(await list(b.h)).toEqual({ friends: [], incoming: [], outgoing: [] });
  });

  it('a reverse pending request auto-accepts', async () => {
    const a = await userWithHeaders('Hana');
    const b = await userWithHeaders('Ivan');
    expect((await request(a.h, { userId: b.user.id })).statusCode).toBe(201);
    const res = await request(b.h, { email: a.user.email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(ids((await list(a.h)).friends)).toEqual([b.user.id]);
    expect(ids((await list(b.h)).friends)).toEqual([a.user.id]);
    expect(await areFriends(pool, a.user.id, b.user.id)).toBe(true);
    const { rows } = await pool.query('select * from friendships where requester = $1 or requester = $2', [
      a.user.id,
      b.user.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('concurrent requests in both directions end up as one friendship and never 500', async () => {
    const a = await userWithHeaders('Jo');
    const b = await userWithHeaders('Kai');
    const [r1, r2] = await Promise.all([request(a.h, { userId: b.user.id }), request(b.h, { userId: a.user.id })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);
    expect(await areFriends(pool, a.user.id, b.user.id)).toBe(true);
  });

  it('concurrent duplicate requests give one 201 and one 409', async () => {
    const a = await userWithHeaders('Lea');
    const b = await makeUser(pool, 'Max');
    const [r1, r2] = await Promise.all([request(a.h, { userId: b.id }), request(a.h, { userId: b.id })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
  });
});

describe('friend request validation', () => {
  it('cannot friend yourself by id or by email', async () => {
    const a = await userWithHeaders('Nia');
    const byId = await request(a.h, { userId: a.user.id });
    expect(byId.statusCode).toBe(400);
    expect(byId.json()).toEqual({ error: "You can't add yourself" });
    const byEmail = await request(a.h, { email: `  ${a.user.email.toUpperCase()} ` });
    expect(byEmail.statusCode).toBe(400);
    expect(byEmail.json()).toEqual({ error: "You can't add yourself" });
    const { rows } = await pool.query('select 1 from friendships where requester = $1', [a.user.id]);
    expect(rows).toHaveLength(0);
  });

  it('unknown email or user id → 404', async () => {
    const a = await userWithHeaders('Oli');
    const res = await request(a.h, { email: 'nobody-here@test.local' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No user found' });
    const res2 = await request(a.h, { userId: '00000000-0000-4000-8000-000000000000' });
    expect(res2.statusCode).toBe(404);
    expect(res2.json()).toEqual({ error: 'No user found' });
  });

  it('a duplicate request → 409', async () => {
    const a = await userWithHeaders('Pia');
    const b = await makeUser(pool, 'Quin');
    expect((await request(a.h, { userId: b.id })).statusCode).toBe(201);
    const dup = await request(a.h, { email: b.email });
    expect(dup.statusCode).toBe(409);
    expect(typeof dup.json<{ error: string }>().error).toBe('string');
  });

  it('finds the user by email in a different letter case and with spaces', async () => {
    const a = await userWithHeaders('Rae');
    const b = await userWithHeaders('Sam');
    const res = await request(a.h, { email: `  ${b.user.email.toUpperCase()}  ` });
    expect(res.statusCode).toBe(201);
    expect(ids((await list(b.h)).incoming)).toEqual([a.user.id]);
  });

  it('creates a friendRequest notification for the addressee with the sender name', async () => {
    const a = await userWithHeaders('Tess');
    const b = await makeUser(pool, 'Uma');
    expect((await request(a.h, { userId: b.id })).statusCode).toBe(201);
    const { rows } = await pool.query<{ kind: string; text: string; link: string | null; read: boolean }>(
      'select kind, text, link, read from notifications where user_id = $1',
      [b.id],
    );
    expect(rows).toEqual([{ kind: 'friendRequest', text: 'Tess sent you a friend request', link: '/friends', read: false }]);
    const mine = await pool.query('select 1 from notifications where user_id = $1', [a.user.id]);
    expect(mine.rows).toHaveLength(0);
  });

  it('rejects bad bodies with 400', async () => {
    const a = await userWithHeaders('Vic');
    const b = await makeUser(pool, 'Wes');
    for (const payload of [{}, { email: b.email, userId: b.id }, { email: 'not-an-email' }, { userId: 'nope' }]) {
      const res = await request(a.h, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(typeof res.json<{ error: string }>().error).toBe('string');
    }
  });

  it('a non-uuid :userId → 400 on every route', async () => {
    const a = await userWithHeaders('Xia');
    for (const res of [
      await action(a.h, 'not-a-uuid', 'accept'),
      await action(a.h, 'not-a-uuid', 'decline'),
      await remove(a.h, 'not-a-uuid'),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(typeof res.json<{ error: string }>().error).toBe('string');
    }
  });

  it('unauthenticated → 401 on every route', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const origin = app.deps.config.publicOrigin;
    for (const [method, url] of [
      ['GET', '/api/friends'],
      ['POST', '/api/friends/requests'],
      ['POST', `/api/friends/requests/${id}/accept`],
      ['POST', `/api/friends/requests/${id}/decline`],
      ['DELETE', `/api/friends/${id}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin }, payload: method === 'POST' ? { userId: id } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'Not signed in' });
    }
  });
});
