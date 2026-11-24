import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { makePool } from './db/pool.js';

const config = loadConfig();
const pool = makePool(config.databaseUrl);

try {
  await migrate(pool);
} catch (err) {
  console.error('Migration failed:', err);
  await pool.end();
  process.exit(1);
}

const app = await buildApp({ pool, config });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
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
  await pool.end();
  process.exit(1);
}
