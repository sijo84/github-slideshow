import { createHash, randomBytes } from 'node:crypto';
import { fastifyCookie } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';

export interface SessionUser {
  id: string;
  displayName: string;
}

export const SESSION_COOKIE = 'sid';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 32 bytes base64url without padding is always 43 chars. */
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/;

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function createSession(
  pool: Pool,
  userId: string,
  ip: string,
  deviceId: string,
): Promise<{ value: string; expiresAt: Date }> {
  const value = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('insert into sessions (id, user_id, ip, device_id, expires_at) values ($1, $2, $3, $4, $5)', [
    hashValue(value),
    userId,
    ip,
    deviceId,
    expiresAt,
  ]);
  return { value, expiresAt };
}

export async function destroySession(pool: Pool, cookieValue: string): Promise<void> {
  await pool.query('delete from sessions where id = $1', [hashValue(cookieValue)]);
}

export function setSessionCookie(reply: FastifyReply, config: Config, session: { value: string; expiresAt: Date }): void {
  reply.setCookie(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies,
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies,
  });
}

async function userFromCookieValue(pool: Pool, value: string | undefined): Promise<SessionUser | null> {
  if (value === undefined || !COOKIE_VALUE_RE.test(value)) return null;
  const id = hashValue(value);
  const { rows } = await pool.query<{ user_id: string; display_name: string; expired: boolean }>(
    `select u.id as user_id, u.display_name, s.expires_at <= now() as expired
       from sessions s join users u on u.id = s.user_id
      where s.id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (row.expired) {
    await pool.query('delete from sessions where id = $1', [id]);
    return null;
  }
  return { id: row.user_id, displayName: row.display_name };
}

export async function userFromCookieHeader(pool: Pool, cookieHeader: string | undefined): Promise<SessionUser | null> {
  if (cookieHeader === undefined || cookieHeader === '') return null;
  const cookies = fastifyCookie.parse(cookieHeader);
  return userFromCookieValue(pool, cookies[SESSION_COOKIE]);
}

const requestCache = new WeakMap<FastifyRequest, Promise<SessionUser | null>>();

export function userFromRequest(req: FastifyRequest): Promise<SessionUser | null> {
  let cached = requestCache.get(req);
  if (cached === undefined) {
    const pool = req.server.deps.pool;
    // req.cookies is filled by @fastify/cookie; fall back to the raw header if it has not run.
    cached = req.cookies
      ? userFromCookieValue(pool, req.cookies[SESSION_COOKIE])
      : userFromCookieHeader(pool, req.headers.cookie);
    requestCache.set(req, cached);
    // Do not keep a rejected lookup cached; the next call retries.
    cached.catch(() => requestCache.delete(req));
  }
  return cached;
}

/** preHandler: sets `req.user` or replies 401 `{ error: 'Not signed in' }`. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await userFromRequest(req);
  if (user === null) {
    reply.code(401).send({ error: 'Not signed in' });
    return;
  }
  req.user = user;
}

export function deviceIdFrom(req: FastifyRequest): string {
  const raw = req.headers['x-device-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return 'unknown';
  return value.slice(0, 64);
}
