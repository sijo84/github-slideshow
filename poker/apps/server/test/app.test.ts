import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  createSession,
  destroySession,
  requireUser,
  SESSION_COOKIE,
  userFromCookieHeader,
  userFromRequest,
} from '../src/auth/session.js';
import { loadConfig, type Config } from '../src/config.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

const API_CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'";

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let config: Config;
let app: FastifyInstance;
let user: { id: string; email: string; displayName: string };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sidOf(cookie: string): string {
  return cookie.replace(/^sid=/, '');
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  config = testConfig();
  app = await buildApp({ pool, config });
  app.post('/api/test/echo', async () => ({ ok: true }));
  app.get('/api/test/me', { preHandler: requireUser }, async (req) => ({ user: req.user }));
  app.get('/api/test/me-twice', async (req) => {
    const a = userFromRequest(req);
    const b = userFromRequest(req);
    return { same: a === b, user: await a };
  });
  await app.ready();
  user = await makeUser(pool, 'Alice');
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

describe('app shell', () => {
  it('serves health with security headers and the API CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toBe(API_CSP);
  });

  it('decorates deps', () => {
    expect(app.deps.pool).toBe(pool);
    expect(app.deps.config).toBe(config);
    expect(typeof app.deps.clock()).toBe('number');
  });

  it('returns 404 { error } for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
    expect(res.headers['content-security-policy']).toBe(API_CSP);
  });

  it('serves avatars with the strict headers', async () => {
    writeFileSync(path.join(config.avatarDir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await app.inject({ method: 'GET', url: '/avatars/a.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; img-src 'self'; sandbox");
    expect(res.headers['content-disposition']).toBe('inline');
  });
});

describe('CSRF hook', () => {
  it('blocks a POST with a foreign Origin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Cross-site request blocked' });
  });

  it('blocks a POST with Sec-Fetch-Site: cross-site', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Cross-site request blocked' });
  });

  it('blocks a cookie-carrying POST with neither Origin nor Sec-Fetch-Site', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers: { cookie: 'theme=dark; sid=abc' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Cross-site request blocked' });
  });

  it('lets a same-origin POST through', async () => {
    const headers = await authed(app, user);
    const res = await app.inject({ method: 'POST', url: '/api/test/echo', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { cookie: headers.cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(res2.statusCode).toBe(200);
  });

  it('lets a cookie-less POST without Origin through', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/test/echo' });
    expect(res.statusCode).toBe(200);
  });
});

describe('sessions', () => {
  it('requireUser replies 401 { error } without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Not signed in' });
  });

  it('requireUser sets req.user with authed() headers', async () => {
    const headers = await authed(app, user);
    const res = await app.inject({ method: 'GET', url: '/api/test/me', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: user.id, displayName: 'Alice' } });
  });

  it('caches the lookup on the request', async () => {
    const headers = await authed(app, user);
    const res = await app.inject({ method: 'GET', url: '/api/test/me-twice', headers });
    expect(res.json()).toEqual({ same: true, user: { id: user.id, displayName: 'Alice' } });
  });

  it('stores sha256(cookie value) hex, never the value', async () => {
    const session = await createSession(pool, user.id, '10.0.0.1', 'dev-1');
    expect(session.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(session.value, 'base64url')).toHaveLength(32);
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const { rows } = await pool.query<{ id: string; ip: string; device_id: string }>(
      'select id, ip, device_id from sessions where user_id = $1 and device_id = $2',
      [user.id, 'dev-1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(session.value);
    expect(rows[0]?.id).toBe(sha256(session.value));
    expect(rows[0]?.ip).toBe('10.0.0.1');
  });

  it('destroySession logs the cookie out', async () => {
    const headers = await authed(app, user);
    expect((await app.inject({ method: 'GET', url: '/api/test/me', headers })).statusCode).toBe(200);
    await destroySession(pool, sidOf(headers.cookie));
    expect((await app.inject({ method: 'GET', url: '/api/test/me', headers })).statusCode).toBe(401);
  });

  it('rejects (and deletes) an expired session', async () => {
    const headers = await authed(app, user);
    const id = sha256(sidOf(headers.cookie));
    await pool.query(`update sessions set expires_at = now() - interval '1 second' where id = $1`, [id]);
    const res = await app.inject({ method: 'GET', url: '/api/test/me', headers });
    expect(res.statusCode).toBe(401);
    expect(await userFromCookieHeader(pool, headers.cookie)).toBeNull();
    const { rowCount } = await pool.query('select 1 from sessions where id = $1', [id]);
    expect(rowCount).toBe(0);
  });

  it('userFromCookieHeader parses a raw header with several cookies', async () => {
    const session = await createSession(pool, user.id, '127.0.0.1', 'socket');
    const header = `theme=dark; ${SESSION_COOKIE}=${session.value}; lang=en`;
    expect(await userFromCookieHeader(pool, header)).toEqual({ id: user.id, displayName: 'Alice' });
    expect(await userFromCookieHeader(pool, 'theme=dark; lang=en')).toBeNull();
    expect(await userFromCookieHeader(pool, `${SESSION_COOKIE}=garbage`)).toBeNull();
    expect(await userFromCookieHeader(pool, undefined)).toBeNull();
  });
});

describe('rate limit', () => {
  it('returns 429 { error } after rateLimitMax requests', async () => {
    const limited = await buildApp({ pool, config: testConfig(), rateLimitMax: 3 });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await limited.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      }
      const res = await limited.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(429);
      expect(typeof res.json().error).toBe('string');
    } finally {
      await limited.close();
    }
  });
});

describe('loadConfig', () => {
  const serverRoot = path.resolve(import.meta.dirname, '..');

  it('has defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 3001,
      host: 'localhost',
      secureCookies: false,
      publicOrigin: 'http://localhost:5173',
      trustProxy: 'loopback',
      registration: 'invite',
      production: false,
    });
    expect(c.avatarDir).toBe(path.join(serverRoot, 'data', 'avatars'));
  });

  it('reads the new env vars', () => {
    const c = loadConfig({ TRUST_PROXY: '10.0.0.0/8', REGISTRATION: 'open', NODE_ENV: 'production', AVATAR_DIR: 'up/av' });
    expect(c.trustProxy).toBe('10.0.0.0/8');
    expect(c.registration).toBe('open');
    expect(c.production).toBe(true);
    expect(c.avatarDir).toBe(path.join(serverRoot, 'up', 'av'));
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ AVATAR_DIR: '/var/avatars' }).avatarDir).toBe('/var/avatars');
    expect(loadConfig({ REGISTRATION: 'invite' }).registration).toBe('invite');
  });

  it('throws on an invalid REGISTRATION', () => {
    expect(() => loadConfig({ REGISTRATION: 'closed' })).toThrow(/REGISTRATION/);
  });
});
