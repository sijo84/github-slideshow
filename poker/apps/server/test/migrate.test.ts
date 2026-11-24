import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { fakeClock, testDb } from '../src/test/helpers.js';

const TABLES = [
  'users', 'sessions', 'friendships', 'notes', 'games', 'game_invites', 'ledger_accounts', 'ledger_entries',
  'hands', 'hand_players', 'chat_messages', 'notifications', 'integrity_flags', 'tournament_results', 'schema_migrations',
];

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

async function freshDb(): Promise<Awaited<ReturnType<typeof testDb>>> {
  const db = await testDb();
  cleanups.push(db.cleanup);
  return db;
}

describe('migrate', () => {
  it('is idempotent and creates every table in the test schema', async () => {
    const { pool, schema } = await freshDb();
    expect(await migrate(pool)).toEqual([]);
    const applied = await pool.query<{ name: string }>('select name from schema_migrations');
    expect(applied.rows.map((r) => r.name)).toContain('001_init.sql');
    const res = await pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1',
      [schema],
    );
    const names = res.rows.map((r) => r.table_name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('allows only one bank account', async () => {
    const { pool } = await freshDb();
    await pool.query(`insert into ledger_accounts (kind, user_id, game_id) values ('bank', null, null)`);
    await expect(
      pool.query(`insert into ledger_accounts (kind, user_id, game_id) values ('bank', null, null)`),
    ).rejects.toThrow(/duplicate key/);
  });

  it('returns bigint columns as JS numbers', async () => {
    const { pool } = await freshDb();
    const acct = await pool.query<{ id: string }>(
      `insert into ledger_accounts (kind) values ('bank') returning id`,
    );
    const res = await pool.query<{ id: unknown; amount: unknown }>(
      `insert into ledger_entries (tx_id, account_id, amount, reason) values (gen_random_uuid(), $1, $2, 'test') returning id, amount`,
      [acct.rows[0]!.id, 9_007_199_254_740_991],
    );
    expect(res.rows[0]!.amount).toBe(9_007_199_254_740_991);
    expect(typeof res.rows[0]!.id).toBe('number');
    const sum = await pool.query<{ s: unknown }>('select sum(amount)::bigint as s from ledger_entries');
    expect(sum.rows[0]!.s).toBe(9_007_199_254_740_991);
  });

  it('handles two concurrent migrators on a fresh schema', async () => {
    const { pool, schema } = await freshDb();
    await pool.query('drop table ' + TABLES.join(', ') + ' cascade');
    const tables = await pool.query('select 1 from information_schema.tables where table_schema = $1', [schema]);
    expect(tables.rowCount).toBe(0);
    const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
    expect([...a, ...b].sort()).toEqual(['001_init.sql']);
    expect(await migrate(pool)).toEqual([]);
  });
});

describe('fakeClock', () => {
  it('fires due timers in time order, honours nested timers and clearTimer', async () => {
    const clock = fakeClock();
    const start = clock.now();
    expect(start).toBe(1_700_000_000_000);
    const log: string[] = [];
    clock.setTimer(() => log.push(`b@${clock.now() - start}`), 200);
    clock.setTimer(() => {
      log.push(`a@${clock.now() - start}`);
      clock.setTimer(() => log.push(`nested@${clock.now() - start}`), 50);
      void Promise.resolve().then(() => log.push('micro'));
    }, 100);
    const cancelled = clock.setTimer(() => log.push('cancelled'), 120);
    clock.setTimer(() => log.push('late'), 1000);
    clock.clearTimer(cancelled);

    await clock.advance(500);
    expect(log).toEqual(['a@100', 'micro', 'nested@150', 'b@200']);
    expect(clock.now() - start).toBe(500);

    await clock.advance(500);
    expect(log.at(-1)).toBe('late');
  });
});
