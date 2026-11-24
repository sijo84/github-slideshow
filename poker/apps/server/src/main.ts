import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { makePool } from './db/pool.js';
import { createServer } from './server.js';

/** The built web client (`npm run build`). */
const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');
const NOT_SPA = /^\/(?:api|avatars|socket\.io)(?:\/|$|\?)/;

/** Production: serve the web build, with index.html for every other GET (client-side routes). */
async function serveWebDist(app: FastifyInstance, dir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/',
    wildcard: false,
    index: ['index.html'],
    decorateReply: false,
  });
  app.get('/*', (req, reply) => {
    if (NOT_SPA.test(req.url)) return reply.code(404).send({ error: 'Not found' });
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html', dir);
  });
}

const config = loadConfig();
const pool = makePool(config.databaseUrl);

try {
  await migrate(pool);
} catch (err) {
  console.error('Migration failed:', err);
  await pool.end();
  process.exit(1);
}

const server = await createServer({ pool, config });
const { app } = server;

if (config.production) {
  if (existsSync(path.join(WEB_DIST, 'index.html'))) {
    await serveWebDist(app, WEB_DIST);
  } else {
    app.log.warn(`NODE_ENV=production but ${WEB_DIST}/index.html is missing; run \`npm run build\` to serve the web client`);
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  try {
    await server.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await app.listen({ port: config.port, host: config.host });
  app.log.info(`Poker server listening on ${address}`);
} catch (err) {
  app.log.error(err);
  await server.close().catch(() => {});
  await pool.end();
  process.exit(1);
}
