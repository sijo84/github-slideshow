import { mkdirSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import auth from './routes/auth.js';
import profile from './routes/profile.js';
import friends from './routes/friends.js';
import notes from './routes/notes.js';
import wallet from './routes/wallet.js';
import games from './routes/games.js';
import history from './routes/history.js';
import stats from './routes/stats.js';
import integrity from './routes/integrity.js';
import notifications from './routes/notifications.js';
import results from './routes/results.js';

export interface BuildAppDeps {
  pool: Pool;
  config: Config;
  clock?: () => number;
  /** Requests per minute per IP for the global rate limit (default 300). */
  rateLimitMax?: number;
}

const API_CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'";
const AVATAR_CSP = "default-src 'none'; img-src 'self'; sandbox";
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SID_COOKIE_RE = /(?:^|;)\s*sid=/;

function isZodError(err: unknown): err is Error & { issues: { message: string }[] } {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { pool, config } = deps;
  const app = Fastify({
    // Fastify accepts a hop count at runtime but its types do not, so a count becomes the equivalent function.
    trustProxy:
      typeof config.trustProxy === 'number'
        ? ((hops: number) => (_addr: string, i: number) => i < hops)(config.trustProxy)
        : config.trustProxy,
    logger: process.env.NODE_ENV !== 'test',
  });

  app.decorate('deps', { pool, config, clock: deps.clock ?? Date.now });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (isZodError(err)) {
      return reply.code(400).send({ error: err.issues[0]?.message ?? 'Invalid request' });
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: err.message });
    }
    req.log.error({ err }, 'request failed');
    return reply.code(typeof statusCode === 'number' && statusCode >= 500 ? statusCode : 500).send({ error: 'Internal error' });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));

  // Security headers on every response; /avatars/* responses already carry a stricter CSP.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (reply.getHeader('content-security-policy') === undefined) {
      reply.header('content-security-policy', req.url.startsWith('/avatars/') ? AVATAR_CSP : API_CSP);
    }
    return payload;
  });

  // CSRF: state-changing requests must come from our own origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!STATE_CHANGING.has(req.method)) return;
    const origin = headerValue(req.headers.origin);
    const fetchSite = headerValue(req.headers['sec-fetch-site']);
    const hasSid = SID_COOKIE_RE.test(headerValue(req.headers.cookie) ?? '');
    const blocked =
      (origin !== undefined && origin !== config.publicOrigin) ||
      fetchSite === 'cross-site' ||
      (origin === undefined && fetchSite === undefined && hasSid);
    if (blocked) {
      return reply.code(403).send({ error: 'Cross-site request blocked' });
    }
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 1_048_576, files: 1 } });
  await app.register(fastifyRateLimit, { global: true, max: deps.rateLimitMax ?? 300, timeWindow: '1 minute' });

  mkdirSync(config.avatarDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.avatarDir,
    prefix: '/avatars/',
    index: false,
    list: false,
    cacheControl: false,
    setHeaders: (reply) => {
      reply.header('cache-control', 'public, max-age=86400');
      reply.header('x-content-type-options', 'nosniff');
      reply.header('content-security-policy', AVATAR_CSP);
      reply.header('content-disposition', 'inline');
    },
  });

  app.get('/api/health', async () => ({ ok: true }));

  for (const plugin of [auth, profile, friends, notes, wallet, games, history, stats, integrity, notifications, results]) {
    await app.register(plugin, { prefix: '/api' });
  }

  return app;
}
