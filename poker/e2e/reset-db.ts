// Empties the e2e database before the server boots (the server migrates at startup).
// Run from poker/: `npx tsx e2e/reset-db.ts`. Playwright's server webServer command runs it once,
// before `npm run dev -w @poker/server`.
import pg from 'pg';

const url = process.env.DATABASE_URL || 'postgres://poker:poker@localhost:5432/poker_e2e';
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_e2e')) {
  throw new Error(`reset-db refuses to drop schema of non-e2e database "${dbName}"`);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('drop schema public cascade; create schema public;');
  console.log(`reset-db: emptied schema public of ${dbName}`);
} finally {
  await client.end();
}
