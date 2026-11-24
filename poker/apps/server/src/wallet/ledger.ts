/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Pool, PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;
export type AccountKind = 'wallet' | 'table' | 'bank';

export class InsufficientFundsError extends Error {}

/** Returns the account id. */
export async function ensureAccount(
  db: Queryable,
  kind: AccountKind,
  userId?: string | null,
  gameId?: string | null,
): Promise<string> {
  throw new Error('not implemented');
}

/** Returns the tx id; the caller owns the transaction. */
export async function transfer(client: PoolClient, fromAcct: string, toAcct: string, amount: number, reason: string): Promise<string> {
  throw new Error('not implemented');
}

export async function balance(db: Queryable, acct: string): Promise<number> {
  throw new Error('not implemented');
}

export async function walletBalance(db: Queryable, userId: string): Promise<number> {
  throw new Error('not implemented');
}

/** bank → wallet */
export async function grant(pool: Pool, userId: string, amount: number, reason: string): Promise<void> {
  throw new Error('not implemented');
}

/** wallet → table account (kind 'table', that user, that game) */
export async function buyIn(pool: Pool, userId: string, gameId: string, amount: number): Promise<void> {
  throw new Error('not implemented');
}

/** table account → wallet */
export async function cashOut(pool: Pool, userId: string, gameId: string, amount: number): Promise<void> {
  throw new Error('not implemented');
}
