import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { makePool } from '../db/pool.js';

const SCHEMA_RE = /^t_[0-9a-f]+$/;

/** A fresh schema `t_<hex>` with all migrations applied; every pool connection uses it first on its search_path. */
export async function testDb(): Promise<{ pool: Pool; schema: string; cleanup: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const schema = `t_${randomBytes(8).toString('hex')}`;
  if (!SCHEMA_RE.test(schema)) throw new Error(`bad schema name ${schema}`);

  const admin = makePool(url, { max: 1 });
  try {
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }

  // search_path is a connection startup parameter, so it is in force on every pooled
  // connection before its first query (no 'connect' handler race).
  const pool = makePool(url, { options: `-c search_path=${schema},public` });

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await pool.query(`drop schema if exists ${schema} cascade`);
    } finally {
      await pool.end();
    }
  };

  try {
    await migrate(pool);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { pool, schema, cleanup };
}

/** loadConfig({}) with open registration, a unique temp avatarDir, then the overrides. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    registration: 'open',
    avatarDir: mkdtempSync(path.join(os.tmpdir(), 'poker-avatars-')),
    ...overrides,
  };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

export async function makeUser(pool: Pool, name: string): Promise<{ id: string; email: string; displayName: string }> {
  const email = `${slug(name)}-${randomBytes(6).toString('hex')}@test.local`;
  const res = await pool.query<{ id: string; email: string; display_name: string }>(
    `insert into users (email, password_hash, display_name) values ($1, 'x', $2) returning id, email, display_name`,
    [email, name],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insert into users returned no row');
  return { id: row.id, email: row.email, displayName: row.display_name };
}

/** Headers for app.inject: a real session cookie plus the Origin the CSRF hook accepts. */
export async function authed(app: FastifyInstance, user: { id: string }): Promise<{ cookie: string; origin: string }> {
  // Loaded lazily so test files that never call authed() do not load the auth module.
  const { createSession } = await import('../auth/session.js');
  const session = await createSession(app.deps.pool, user.id, '127.0.0.1', 'test-device');
  return { cookie: `sid=${session.value}`, origin: app.deps.config.publicOrigin };
}

interface FakeTimer {
  id: number;
  due: number;
  seq: number;
  fn: () => void;
}

/** A manual clock. `advance` fires due timers in time order and awaits pending promises between them. */
export function fakeClock(startMs = 1_700_000_000_000): {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (h: unknown) => void;
  advance: (ms: number) => Promise<void>;
} {
  let current = startMs;
  let nextId = 1;
  let seq = 0;
  const timers = new Map<number, FakeTimer>();

  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const nextDue = (limit: number): FakeTimer | undefined => {
    let best: FakeTimer | undefined;
    for (const t of timers.values()) {
      if (t.due > limit) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  };

  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { id, due: current + Math.max(0, ms), seq: seq++, fn });
      return id;
    },
    clearTimer: (h) => {
      if (typeof h === 'number') timers.delete(h);
    },
    advance: async (ms) => {
      const target = current + ms;
      await flush();
      for (let t = nextDue(target); t; t = nextDue(target)) {
        timers.delete(t.id);
        current = Math.max(current, t.due);
        t.fn();
        await flush();
      }
      current = target;
    },
  };
}
