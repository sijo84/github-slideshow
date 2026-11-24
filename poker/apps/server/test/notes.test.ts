import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type User = { id: string; email: string; displayName: string };
type Headers = { cookie: string; origin: string };

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;
let a: User;
let b: User;
let c: User;
let d: User;
let ha: Headers;
let hb: Headers;
let hc: Headers;

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig() });
  await app.ready();
  a = await makeUser(pool, 'Alice');
  b = await makeUser(pool, 'Bob');
  c = await makeUser(pool, 'Carol');
  d = await makeUser(pool, 'Dave');
  ha = await authed(app, a);
  hb = await authed(app, b);
  hc = await authed(app, c);
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

function put(headers: Headers, subjectId: string, payload: unknown) {
  return app.inject({ method: 'PUT', url: `/api/notes/${subjectId}`, headers, payload: payload as object });
}
function getOne(headers: Headers, subjectId: string) {
  return app.inject({ method: 'GET', url: `/api/notes/${subjectId}`, headers });
}
function list(headers: Headers) {
  return app.inject({ method: 'GET', url: '/api/notes', headers });
}

describe('notes', () => {
  it('A writes a note on C and reads it back', async () => {
    const res = await put(ha, c.id, { text: 'Bluffs the river', color: 'red' });
    expect(res.statusCode).toBe(200);
    const note = res.json();
    expect(note).toMatchObject({ subjectId: c.id, text: 'Bluffs the river', color: 'red' });
    expect(typeof note.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(note.updatedAt))).toBe(false);

    const one = await getOne(ha, c.id);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(note);

    const all = await list(ha);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ notes: [note] });
  });

  it("B cannot read A's note on C (gets B's own empty note, empty list)", async () => {
    const one = await getOne(hb, c.id);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({ subjectId: c.id, text: '', color: null, updatedAt: null });

    const all = await list(hb);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ notes: [] });
  });

  it('C cannot see notes about themself', async () => {
    const all = await list(hc);
    expect(all.json()).toEqual({ notes: [] });
    const one = await getOne(hc, c.id);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({ subjectId: c.id, text: '', color: null, updatedAt: null });
  });

  it("B's own note on C stays separate from A's", async () => {
    const res = await put(hb, c.id, { text: 'Tight-passive', color: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subjectId: c.id, text: 'Tight-passive', color: null });

    expect((await getOne(ha, c.id)).json()).toMatchObject({ text: 'Bluffs the river', color: 'red' });
    expect((await getOne(hb, c.id)).json()).toMatchObject({ text: 'Tight-passive', color: null });
    expect((await list(ha)).json().notes).toHaveLength(1);
    expect((await list(hb)).json().notes).toHaveLength(1);
    expect((await list(hb)).json().notes[0]).toMatchObject({ subjectId: c.id, text: 'Tight-passive' });
  });

  it('update changes text, colour and updatedAt', async () => {
    await pool.query(`update notes set updated_at = now() - interval '1 hour' where author = $1 and subject = $2`, [a.id, c.id]);
    const before = (await getOne(ha, c.id)).json();
    const res = await put(ha, c.id, { text: 'Calls too much', color: 'blue' });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after).toMatchObject({ subjectId: c.id, text: 'Calls too much', color: 'blue' });
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect((await getOne(ha, c.id)).json()).toEqual(after);
    // B's note is untouched.
    expect((await getOne(hb, c.id)).json()).toMatchObject({ text: 'Tight-passive', color: null });
  });

  it('lists my notes newest first', async () => {
    await put(ha, d.id, { text: 'old', color: 'green' });
    await pool.query(`update notes set updated_at = now() - interval '1 day' where author = $1 and subject = $2`, [a.id, d.id]);
    await put(ha, b.id, { text: 'new', color: 'purple' });
    const notes = (await list(ha)).json().notes as { subjectId: string }[];
    expect(notes.map((n) => n.subjectId)).toEqual([b.id, c.id, d.id]);
  });

  it('rejects an invalid colour', async () => {
    const res = await put(ha, c.id, { text: 'x', color: 'pink' });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('rejects 2001 characters and accepts 2000', async () => {
    const res = await put(ha, c.id, { text: 'x'.repeat(2001), color: null });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
    const ok = await put(ha, c.id, { text: 'x'.repeat(2000), color: null });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toHaveLength(2000);
  });

  it('rejects a missing body field', async () => {
    expect((await put(ha, c.id, { text: 'x' })).statusCode).toBe(400);
  });

  it('rejects a note on yourself', async () => {
    const res = await put(ha, a.id, { text: 'me', color: null });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('returns 404 for an unknown subject', async () => {
    const id = randomUUID();
    const g = await getOne(ha, id);
    expect(g.statusCode).toBe(404);
    expect(typeof g.json().error).toBe('string');
    expect((await put(ha, id, { text: 'x', color: null })).statusCode).toBe(404);
  });

  it('returns 400 for a non-uuid subject', async () => {
    expect((await getOne(ha, 'not-a-uuid')).statusCode).toBe(400);
    expect((await put(ha, 'not-a-uuid', { text: 'x', color: null })).statusCode).toBe(400);
    const del = await app.inject({ method: 'DELETE', url: '/api/notes/not-a-uuid', headers: ha });
    expect(del.statusCode).toBe(400);
  });

  it("delete removes only my note; B deleting does not touch A's", async () => {
    const delB = await app.inject({ method: 'DELETE', url: `/api/notes/${c.id}`, headers: hb });
    expect(delB.statusCode).toBe(200);
    expect(delB.json()).toEqual({ ok: true });
    expect((await getOne(hb, c.id)).json()).toEqual({ subjectId: c.id, text: '', color: null, updatedAt: null });
    expect((await getOne(ha, c.id)).json().updatedAt).not.toBeNull();

    const delA = await app.inject({ method: 'DELETE', url: `/api/notes/${c.id}`, headers: ha });
    expect(delA.json()).toEqual({ ok: true });
    expect((await getOne(ha, c.id)).json()).toEqual({ subjectId: c.id, text: '', color: null, updatedAt: null });
    expect((await list(ha)).json().notes.map((n: { subjectId: string }) => n.subjectId)).toEqual([b.id, d.id]);

    const again = await app.inject({ method: 'DELETE', url: `/api/notes/${c.id}`, headers: ha });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true });
  });

  it('requires a session', async () => {
    const origin = ha.origin;
    const reqs = [
      app.inject({ method: 'GET', url: '/api/notes' }),
      app.inject({ method: 'GET', url: `/api/notes/${c.id}` }),
      app.inject({ method: 'PUT', url: `/api/notes/${c.id}`, headers: { origin }, payload: { text: 'x', color: null } }),
      app.inject({ method: 'DELETE', url: `/api/notes/${c.id}`, headers: { origin } }),
    ];
    for (const res of await Promise.all(reqs)) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Not signed in' });
    }
  });
});
