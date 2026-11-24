import Fastify from 'fastify';
import { loadConfig } from './config.js';

// Checkpoint 0: health endpoint only, no database. S2 replaces this boot (migrate, buildApp, listen).
const config = loadConfig();
const app = Fastify({ logger: true });

app.get('/api/health', async () => ({ ok: true }));

app.log.info('not wired yet');

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
