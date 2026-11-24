import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Double-entry ledger for play-money chips. Every transaction is two rows with the
 * same tx_id summing to 0. The single bank account (user_id and game_id null) is the
 * source of grants and may go negative; wallet and table accounts never do.
 */

export type Queryable = Pool | PoolClient;
export type AccountKind = 'wallet' | 'table' | 'bank';

export class InsufficientFundsError extends Error {
  readonly statusCode = 409;
  constructor(message = 'Not enough chips') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

/** Returns the account id, creating the account if missing (safe under concurrency). */
export async function ensureAccount(
  db: Queryable,
  kind: AccountKind,
  userId?: string | null,
  gameId?: string | null,
): Promise<string> {
  const params = [kind, userId ?? null, gameId ?? null];
  // The unique constraint is NULLS NOT DISTINCT, so on conflict also covers the null columns.
  await db.query(
    `insert into ledger_accounts (kind, user_id, game_id) values ($1, $2, $3)
     on conflict (kind, user_id, game_id) do nothing`,
    params,
  );
  const { rows } = await db.query<{ id: string }>(
    `select id from ledger_accounts
      where kind = $1 and user_id is not distinct from $2 and game_id is not distinct from $3`,
    params,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('ledger account was not created');
  return row.id;
}

/** Returns the tx id; the caller owns the transaction. */
export async function transfer(client: PoolClient, fromAcct: string, toAcct: string, amount: number, reason: string): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(`transfer amount must be a positive safe integer, got ${String(amount)}`);
  }
  if (fromAcct === toAcct) throw new RangeError('transfer accounts must differ');

  // Lock both rows in id order (deadlock-free) so concurrent transfers serialise on the source.
  const locked = await client.query<{ id: string; kind: AccountKind }>(
    'select id, kind from ledger_accounts where id = any($1) order by id for update',
    [[fromAcct, toAcct]],
  );
  if (locked.rows.length !== 2) throw new Error('unknown ledger account');
  const source = locked.rows.find((r) => r.id === fromAcct);
  if (source === undefined) throw new Error('unknown ledger account');

  if (source.kind === 'wallet' || source.kind === 'table') {
    const current = await balance(client, fromAcct);
    if (current < amount) throw new InsufficientFundsError();
  }

  const txId = randomUUID();
  await client.query(
    `insert into ledger_entries (tx_id, account_id, amount, reason) values ($1, $2, $3, $5), ($1, $4, $6, $5)`,
    [txId, fromAcct, -amount, toAcct, reason, amount],
  );
  return txId;
}

export async function balance(db: Queryable, acct: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    'select coalesce(sum(amount), 0)::bigint as total from ledger_entries where account_id = $1',
    [acct],
  );
  return rows[0]?.total ?? 0;
}

export async function walletBalance(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `select coalesce(sum(e.amount), 0)::bigint as total
       from ledger_accounts a join ledger_entries e on e.account_id = a.id
      where a.kind = 'wallet' and a.user_id = $1 and a.game_id is null`,
    [userId],
  );
  return rows[0]?.total ?? 0;
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** bank → wallet */
export async function grant(pool: Pool, userId: string, amount: number, reason: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    const bank = await ensureAccount(client, 'bank');
    const wallet = await ensureAccount(client, 'wallet', userId);
    await transfer(client, bank, wallet, amount, reason);
  });
}

/** wallet → table account (kind 'table', that user, that game) */
export async function buyIn(pool: Pool, userId: string, gameId: string, amount: number): Promise<void> {
  await inTransaction(pool, async (client) => {
    // Always ensure wallet before table so concurrent buy-ins and cash-outs create rows in the same order.
    const wallet = await ensureAccount(client, 'wallet', userId);
    const table = await ensureAccount(client, 'table', userId, gameId);
    await transfer(client, wallet, table, amount, 'buy-in');
  });
}

/** table account → wallet */
export async function cashOut(pool: Pool, userId: string, gameId: string, amount: number): Promise<void> {
  await inTransaction(pool, async (client) => {
    const wallet = await ensureAccount(client, 'wallet', userId);
    const table = await ensureAccount(client, 'table', userId, gameId);
    await transfer(client, table, wallet, amount, 'cash-out');
  });
}
