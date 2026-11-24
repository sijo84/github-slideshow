import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { startScheduler } from './games/scheduler.js';
import { notify, setNotifyEmitter } from './notify.js';
import { attachSockets, type PokerServer } from './realtime/socket.js';
import { TableManager } from './realtime/tableManager.js';

export interface TableOptions {
  seedWaitMs?: number;
  runoutPacingMs?: number;
  handDelayMs?: number;
  autoStartMs?: number;
  rebuyWaitMs?: number;
}

export interface CreateServerOptions {
  pool: Pool;
  config: Config;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  tableOptions?: TableOptions;
  /** Start the game scheduler (default true). */
  scheduler?: boolean;
}

export interface PokerApp {
  app: FastifyInstance;
  io: PokerServer;
  tables: TableManager;
  close: () => Promise<void>;
}

const defaultSetTimer = (fn: () => void, ms: number): unknown => setTimeout(fn, ms);
const defaultClearTimer = (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>);

/** Builds the app with the table manager, sockets, notifications push and scheduler. Does not listen or migrate. */
export async function createServer(opts: CreateServerOptions): Promise<PokerApp> {
  const { pool, config } = opts;
  const clock = opts.clock ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const clearTimer = opts.clearTimer ?? defaultClearTimer;

  const app = await buildApp({ pool, config, clock, rateLimitMax: config.rateLimitMax });

  // The manager is built before io exists; its emitters look io up when they run.
  let io: PokerServer | null = null;
  const tables = new TableManager({
    pool,
    clock,
    setTimer,
    clearTimer,
    // The manager passes payloads as `unknown`; it builds them from the protocol types.
    emitTo: (userId, event, payload) => io?.to(`user:${userId}`).emit(event, payload as never),
    emitRoom: (gameId, event, payload) => io?.to(`game:${gameId}`).emit(event, payload as never),
    logger: {
      info: (message) => app.log.info(message),
      error: (message, err) => app.log.error({ err }, message),
    },
    ...opts.tableOptions,
  });
  app.decorate('tables', tables);
  io = attachSockets(app, { tables, pool, config });
  const server = io;

  setNotifyEmitter((userId, payload) => {
    server.to(`user:${userId}`).emit('notify', payload);
  });

  const stopScheduler =
    opts.scheduler === false ? () => {} : startScheduler({ pool, clock, setTimer, clearTimer, tables, notify });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopScheduler();
    setNotifyEmitter(null);
    tables.shutdown();
    // attachSockets' preClose hook disconnects every socket and closes the engine before the HTTP server closes.
    await app.close();
  };

  return { app, io: server, tables, close };
}
