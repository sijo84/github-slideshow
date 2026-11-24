import path from 'node:path';

export type TrustProxy = boolean | number | string;
export type Registration = 'open' | 'invite';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  secureCookies: boolean;
  avatarDir: string;
  publicOrigin: string;
  trustProxy: TrustProxy;
  registration: Registration;
  production: boolean;
  /** Requests per minute per IP on each /api/auth/* route. */
  authRateLimitMax: number;
  /** Requests per minute per IP for the global rate limit. */
  rateLimitMax: number;
}

/** The server package root (`apps/server`); relative paths in config resolve against it. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

/** `true`/`false`, a hop count, or an address list / preset name (`loopback`, `10.0.0.0/8,...`). */
function parseTrustProxy(value: string | undefined): TrustProxy {
  if (value === undefined || value.trim() === '') return 'loopback';
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  return n;
}

function parseRegistration(value: string | undefined): Registration {
  if (value === undefined || value === '') return 'invite';
  if (value === 'open' || value === 'invite') return value;
  throw new Error(`Invalid REGISTRATION: ${value} (expected "open" or "invite")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT, 3001),
    host: env.HOST || 'localhost',
    databaseUrl: env.DATABASE_URL || 'postgres://poker:poker@localhost:5432/poker_dev',
    secureCookies: parseBool(env.SECURE_COOKIES, false),
    avatarDir: path.resolve(PACKAGE_ROOT, env.AVATAR_DIR || 'data/avatars'),
    publicOrigin: env.PUBLIC_ORIGIN || 'http://localhost:5173',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    registration: parseRegistration(env.REGISTRATION),
    production: env.NODE_ENV === 'production',
    authRateLimitMax: parsePositiveInt('AUTH_RATE_LIMIT_MAX', env.AUTH_RATE_LIMIT_MAX, 10),
    rateLimitMax: parsePositiveInt('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, 300),
  };
}
