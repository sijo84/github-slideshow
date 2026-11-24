import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';
import { grant } from '../src/wallet/ledger.js';

vi.mock('../src/wallet/ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/wallet/ledger.js')>()),
  grant: vi.fn(async () => undefined),
}));

const grantMock = vi.mocked(grant);

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;
let inviteApp: FastifyInstance;
let origin: string;

let seq = 0;
function uniqueEmail(prefix = 'user'): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@example.com`;
}

function sidCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === 'sid');
  if (!c || !c.value) throw new Error('no sid cookie set');
  return `sid=${c.value}`;
}

async function register(
  target: FastifyInstance,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return target.inject({ method: 'POST', url: '/api/auth/register', headers: { origin }, payload: body });
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  const config = testConfig({ authRateLimitMax: 1000 });
  origin = config.publicOrigin;
  app = await buildApp({ pool, config });
  inviteApp = await buildApp({ pool, config: testConfig({ registration: 'invite', authRateLimitMax: 1000 }) });
  await app.ready();
  await inviteApp.ready();
});

afterAll(async () => {
  await app?.close();
  await inviteApp?.close();
  await db?.cleanup();
});

beforeEach(() => {
  grantMock.mockClear();
});

describe('register', () => {
  it('creates the user, sets a cookie that /auth/me accepts, and grants signup chips', async () => {
    const email = uniqueEmail('Alice');
    const res = await register(app, { email: `  ${email.toUpperCase()} `, password: 'correct horse', displayName: '  Alice  ' });
    expect(res.statusCode).toBe(201);
    const user = res.json<{ id: string; email: string; displayName: string; avatarUrl: string }>();
    expect(user).toEqual({
      id: expect.any(String),
      email: email.toLowerCase(),
      displayName: 'Alice',
      avatarUrl: `/api/users/${user.id}/avatar.svg`,
    });
    const setCookie = res.cookies.find((c) => c.name === 'sid');
    expect(setCookie?.httpOnly).toBe(true);
    expect(setCookie?.sameSite).toBe('Lax');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sidCookie(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(user);

    expect(grantMock).toHaveBeenCalledTimes(1);
    expect(grantMock).toHaveBeenCalledWith(pool, user.id, 10_000, 'signup');

    const { rows } = await pool.query<{ password_hash: string }>('select password_hash from users where id = $1', [user.id]);
    expect(rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a short password, a bad email and a short display name with 400', async () => {
    const cases = [
      { email: uniqueEmail(), password: 'short', displayName: 'Bob' },
      { email: 'not-an-email', password: 'long enough pw', displayName: 'Bob' },
      { email: `${'a'.repeat(250)}@x.io`, password: 'long enough pw', displayName: 'Bob' },
      { email: uniqueEmail(), password: 'long enough pw', displayName: ' B ' },
      { email: uniqueEmail(), password: 'long enough pw', displayName: 'B'.repeat(25) },
      { email: uniqueEmail(), password: 'x'.repeat(201), displayName: 'Bob' },
      { password: 'long enough pw', displayName: 'Bob' },
    ];
    for (const body of cases) {
      const res = await register(app, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(typeof res.json().error).toBe('string');
    }
    expect(grantMock).not.toHaveBeenCalled();
  });

  it('rejects a duplicate email (in any letter case) with 409', async () => {
    const email = uniqueEmail('dup');
    expect((await register(app, { email, password: 'long enough pw', displayName: 'Dup' })).statusCode).toBe(201);
    for (const again of [email, email.toUpperCase()]) {
      const res = await register(app, { email: again, password: 'another long pw', displayName: 'Dup2' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'That email is already registered' });
    }
    expect(grantMock).toHaveBeenCalledTimes(1);
  });
});

describe('login / logout / me', () => {
  const password = 'my secret password';
  let email: string;
  let userId: string;

  beforeAll(async () => {
    email = uniqueEmail('carol');
    const res = await register(app, { email, password, displayName: 'Carol' });
    expect(res.statusCode).toBe(201);
    userId = res.json<{ id: string }>().id;
  });

  it('sets a new session and destroys the one the request carried', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: userId, email, displayName: 'Carol' });
    const oldCookie = sidCookie(first);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, cookie: oldCookie },
      payload: { email: email.toUpperCase(), password },
    });
    expect(second.statusCode).toBe(200);
    const newCookie = sidCookie(second);
    expect(newCookie).not.toBe(oldCookie);

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldCookie } })).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: newCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: userId });
  });

  it('gives the identical 401 body for a wrong password and an unknown email', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email, password: 'not the password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: uniqueEmail('nobody'), password },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.json()).toEqual({ error: 'Invalid email or password' });
    expect(wrong.cookies.find((c) => c.name === 'sid')).toBeUndefined();
  });

  it('logout invalidates the cookie and clears it', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password } });
    const cookie = sidCookie(login);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin, cookie } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    const cleared = out.cookies.find((c) => c.name === 'sid');
    expect(cleared?.value).toBe('');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('logout without a session still replies { ok: true }', async () => {
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin } });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
  });

  it('/auth/me without a cookie is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Not signed in' });
  });
});

describe('invites', () => {
  it('POST and GET /invites require auth', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: { origin } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/invites' })).statusCode).toBe(401);
  });

  it('invite mode: no code or a bad code is 403; a valid code works once and is marked used', async () => {
    const inviter = await makeUser(pool, 'Inviter');
    const headers = await authed(inviteApp, inviter);
    const created = await inviteApp.inject({ method: 'POST', url: '/api/invites', headers });
    expect(created.statusCode).toBe(201);
    const { code } = created.json<{ code: string }>();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const list = await inviteApp.inject({ method: 'GET', url: '/api/invites', headers });
    expect(list.json()).toEqual({ invites: [{ code, used: false, createdAt: expect.any(String) }] });

    const base = { password: 'long enough pw', displayName: 'Invitee' };
    const none = await register(inviteApp, { ...base, email: uniqueEmail('inv') });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toEqual({ error: 'A valid invite code is required' });

    const badEmail = uniqueEmail('inv');
    const bad = await register(inviteApp, { ...base, email: badEmail, inviteCode: 'nope' });
    expect(bad.statusCode).toBe(403);
    expect(bad.json()).toEqual({ error: 'A valid invite code is required' });
    // The rolled-back registration left no user behind.
    expect((await pool.query('select 1 from users where email = $1', [badEmail])).rowCount).toBe(0);

    const ok = await register(inviteApp, { ...base, email: uniqueEmail('inv'), inviteCode: code });
    expect(ok.statusCode).toBe(201);
    const newId = ok.json<{ id: string }>().id;
    const row = await pool.query<{ used_by: string | null }>('select used_by from invite_codes where code = $1', [code]);
    expect(row.rows[0]?.used_by).toBe(newId);

    const after = await inviteApp.inject({ method: 'GET', url: '/api/invites', headers });
    expect(after.json().invites[0].used).toBe(true);

    const reuse = await register(inviteApp, { ...base, email: uniqueEmail('inv'), inviteCode: code });
    expect(reuse.statusCode).toBe(403);
    expect(grantMock).toHaveBeenCalledTimes(1);
  });

  it('two concurrent registrations with one code: exactly one succeeds', async () => {
    const inviter = await makeUser(pool, 'Inviter2');
    const headers = await authed(inviteApp, inviter);
    const { code } = (await inviteApp.inject({ method: 'POST', url: '/api/invites', headers })).json<{ code: string }>();
    const base = { password: 'long enough pw', displayName: 'Racer', inviteCode: code };
    const results = await Promise.all([
      register(inviteApp, { ...base, email: uniqueEmail('race') }),
      register(inviteApp, { ...base, email: uniqueEmail('race') }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403]);
  });

  it('open mode ignores the invite code', async () => {
    const res = await register(app, { email: uniqueEmail('open'), password: 'long enough pw', displayName: 'Open', inviteCode: 'junk' });
    expect(res.statusCode).toBe(201);
  });
});

describe('auth rate limit', () => {
  it('returns 429 after authRateLimitMax attempts', async () => {
    const limited = await buildApp({ pool, config: testConfig({ authRateLimitMax: 3 }) });
    try {
      const attempt = (): Promise<LightMyRequestResponse> =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload: { email: 'nobody@example.com', password: 'whatever pw' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
      const res = await attempt();
      expect(res.statusCode).toBe(429);
      expect(typeof res.json().error).toBe('string');
    } finally {
      await limited.close();
    }
  });

  it('does not apply to GET /auth/me or POST /auth/logout, while the 4th login still gets 429', async () => {
    const limited = await buildApp({ pool, config: testConfig({ authRateLimitMax: 3 }) });
    try {
      const user = await makeUser(pool, 'Frequent');
      const headers = await authed(limited, user);
      for (let i = 0; i < 6; i++) {
        const me = await limited.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: headers.cookie } });
        expect(me.statusCode).toBe(200);
      }
      for (let i = 0; i < 5; i++) {
        expect((await limited.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin } })).statusCode).toBe(200);
      }
      const login = (): Promise<LightMyRequestResponse> =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload: { email: 'nobody@example.com', password: 'whatever pw' },
        });
      for (let i = 0; i < 3; i++) expect((await login()).statusCode).toBe(401);
      expect((await login()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('config', () => {
  it('reads AUTH_RATE_LIMIT_MAX and RATE_LIMIT_MAX with defaults and rejects bad values', () => {
    expect(loadConfig({})).toMatchObject({ authRateLimitMax: 10, rateLimitMax: 300 });
    expect(loadConfig({ AUTH_RATE_LIMIT_MAX: '5', RATE_LIMIT_MAX: '50' })).toMatchObject({ authRateLimitMax: 5, rateLimitMax: 50 });
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ AUTH_RATE_LIMIT_MAX: bad })).toThrow(/AUTH_RATE_LIMIT_MAX/);
      expect(() => loadConfig({ RATE_LIMIT_MAX: bad })).toThrow(/RATE_LIMIT_MAX/);
    }
  });
});
