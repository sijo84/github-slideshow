import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const DEFAULT_DIR = path.resolve(import.meta.dirname, '../../migrations');

// One lock per schema, so concurrent migrators of the same schema serialise while
// test files migrating their own schemas do not block each other.
const LOCK_SQL = `select pg_advisory_xact_lock(hashtext('poker:migrate:' || current_schema()))`;

async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query(LOCK_SQL);
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Applies `dir/*.sql` in name order, one transaction each. Returns the names applied by this call. */
export async function migrate(pool: Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await inTransaction(client, async () => {
      await client.query(
        'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
      );
    });
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      await inTransaction(client, async () => {
        const done = await client.query('select 1 from schema_migrations where name = $1', [name]);
        if (done.rowCount) return;
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        applied.push(name);
      });
    }
  } finally {
    client.release();
  }
  return applied;
}

async function main(): Promise<void> {
  const { loadConfig } = await import('../config.js');
  const { makePool } = await import('./pool.js');
  const config = loadConfig();
  const pool = makePool(config.databaseUrl);
  try {
    const names = await migrate(pool);
    console.log(names.length ? `Applied migrations: ${names.join(', ')}` : 'No new migrations.');
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
