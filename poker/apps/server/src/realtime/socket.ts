import {
  ClientEventSchemas,
  type ClientEventName,
  type ClientEventPayload,
  type ClientEvents,
  type ServerEvents,
  type TableJoinAck,
} from '@poker/protocol';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { Server, type Socket } from 'socket.io';
import { userFromCookieHeader, type SessionUser } from '../auth/session.js';
import type { Config } from '../config.js';
import type { TableManager } from './tableManager.js';

/** Chat: at most this many messages in a burst, refilled at CHAT_REFILL_TOKENS per CHAT_REFILL_MS. */
export const CHAT_BUCKET_CAPACITY = 5;
export const CHAT_REFILL_TOKENS = 5;
export const CHAT_REFILL_MS = 10_000;
/** All other client events (table:* and host:command): 10 per second. */
export const TABLE_BUCKET_CAPACITY = 10;
export const TABLE_REFILL_TOKENS = 10;
export const TABLE_REFILL_MS = 1_000;

/** The TableManager methods the socket layer calls (tests pass a fake). */
export type SocketTables = Pick<
  TableManager,
  'join' | 'sit' | 'leave' | 'act' | 'setClientSeed' | 'useTimeBank' | 'rebuy' | 'host' | 'setConnected'
>;

export interface AttachSocketsDeps {
  tables: SocketTables;
  pool: Pool;
  config: Config;
}

export type PokerServer = Server<ClientEvents, ServerEvents>;
type PokerSocket = Socket<ClientEvents, ServerEvents>;

/** A token bucket with continuous refill. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillTokens: number,
    private readonly refillMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillTokens) / this.refillMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class SocketError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** TableError (and anything shaped like it) carries a string `code`; detected structurally. */
function errorCode(err: unknown): { code: string; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || code === '') return null;
  return { code, message: typeof message === 'string' && message !== '' ? message : code };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Socket.IO on the Fastify HTTP server.
 * - Handshake: a valid `sid` cookie is required; an `Origin` header, if present, must equal `config.publicOrigin`.
 * - Every socket joins room `user:<id>`; `table:join` adds room `game:<id>`.
 * - Every payload is validated with the protocol schema; invalid → `error { code: 'bad_request' }`, nothing else.
 * - Valid messages from one socket are handled one at a time, in order.
 * - Thrown errors become `error { code, message }` for that socket (unknown errors → `internal`).
 */
export function attachSockets(app: FastifyInstance, deps: AttachSocketsDeps): PokerServer {
  const { tables, pool, config } = deps;
  const clock = (): number => app.deps.clock();
  const io: PokerServer = new Server<ClientEvents, ServerEvents>(app.server, { serveClient: false });

  const users = new WeakMap<PokerSocket, SessionUser>();
  /** Number of this server's sockets per `${gameId}:${userId}` that have joined that game. */
  const joinedCount = new Map<string, number>();

  io.use((socket, next) => {
    const origin = headerValue(socket.handshake.headers.origin);
    if (origin !== undefined && origin !== config.publicOrigin) {
      next(new Error('forbidden origin'));
      return;
    }
    userFromCookieHeader(pool, headerValue(socket.handshake.headers.cookie)).then(
      (user) => {
        if (user === null) {
          next(new Error('unauthorized'));
          return;
        }
        users.set(socket, user);
        next();
      },
      (err: unknown) => {
        app.log.error({ err }, 'socket auth failed');
        next(new Error('unauthorized'));
      },
    );
  });

  io.on('connection', (socket) => {
    const user = users.get(socket);
    if (user === undefined) {
      socket.disconnect(true);
      return;
    }
    const userId = user.id;
    void socket.join(`user:${userId}`);

    const joinedGames = new Set<string>();
    const chatBucket = new TokenBucket(CHAT_BUCKET_CAPACITY, CHAT_REFILL_TOKENS, CHAT_REFILL_MS, clock());
    const tableBucket = new TokenBucket(TABLE_BUCKET_CAPACITY, TABLE_REFILL_TOKENS, TABLE_REFILL_MS, clock());

    let queue: Promise<void> = Promise.resolve();

    const sendError = (err: unknown): void => {
      const known = errorCode(err);
      if (known) {
        socket.emit('error', known);
        return;
      }
      app.log.error({ err, userId }, 'socket handler failed');
      socket.emit('error', { code: 'internal', message: 'Internal error' });
    };

    /** Registers a handler: rate limit, then schema validation, then `run`; errors go back as `error` events. */
    function handle<E extends ClientEventName>(
      event: E,
      run: (payload: ClientEventPayload<E>, ack: ((res: TableJoinAck) => void) | null) => Promise<void> | void,
    ): void {
      const listener = (raw: unknown, maybeAck?: unknown): void => {
        const ack = typeof maybeAck === 'function' ? (maybeAck as (res: TableJoinAck) => void) : null;
        const bucket = event === 'chat:send' ? chatBucket : tableBucket;
        if (!bucket.take(clock())) {
          socket.emit('error', { code: 'rate_limited', message: 'Too many messages; slow down' });
          ack?.({ ok: false, error: 'rate_limited' });
          return;
        }
        const parsed = ClientEventSchemas[event].safeParse(raw);
        if (!parsed.success) {
          const message = parsed.error.issues[0]?.message ?? 'Invalid payload';
          socket.emit('error', { code: 'bad_request', message: `${event}: ${message}` });
          ack?.({ ok: false, error: 'bad_request' });
          return;
        }
        // One queue per socket: a client's messages are handled (and chat is stored and broadcast) in the order sent.
        queue = queue.then(() => run(parsed.data as ClientEventPayload<E>, ack)).catch(sendError);
      };
      // The typed `on` cannot see that this listener fits event E; it accepts unknown input and validates it.
      socket.on(event, listener as never);
    }

    handle('table:join', async ({ gameId }, ack) => {
      let view;
      try {
        view = await tables.join(gameId, userId);
      } catch (err) {
        const known = errorCode(err);
        if (!known) app.log.error({ err, userId, gameId }, 'table:join failed');
        ack?.({ ok: false, error: known ? known.code : 'internal' });
        return;
      }
      if (!socket.connected) return;
      await socket.join(`game:${gameId}`);
      if (!joinedGames.has(gameId)) {
        joinedGames.add(gameId);
        const key = `${gameId}:${userId}`;
        joinedCount.set(key, (joinedCount.get(key) ?? 0) + 1);
      }
      tables.setConnected(gameId, userId, true);
      ack?.({ ok: true, view });
    });

    handle('table:sit', ({ gameId, seat, buyIn, clientSeed }) => tables.sit(gameId, userId, seat, buyIn, clientSeed));
    handle('table:leave', ({ gameId }) => tables.leave(gameId, userId));
    handle('table:action', ({ gameId, handId, kind, amount }) => tables.act(gameId, userId, handId, kind, amount));
    handle('table:clientSeed', ({ gameId, handNumber, clientSeed }) =>
      tables.setClientSeed(gameId, userId, handNumber, clientSeed),
    );
    handle('table:useTimeBank', ({ gameId }) => tables.useTimeBank(gameId, userId));
    handle('table:rebuy', ({ gameId }) => tables.rebuy(gameId, userId));
    handle('host:command', ({ gameId, command }) => tables.host(gameId, userId, command));

    handle('chat:send', async ({ gameId, text }) => {
      if (!joinedGames.has(gameId)) throw new SocketError('forbidden', 'Join the table before chatting');
      const { rows } = await pool.query<{ id: string | number; created_at: Date }>(
        'insert into chat_messages (game_id, user_id, text) values ($1, $2, $3) returning id, created_at',
        [gameId, userId, text],
      );
      const row = rows[0];
      if (!row) throw new Error('insert into chat_messages returned no row');
      io.to(`game:${gameId}`).emit('chat:message', {
        gameId,
        id: String(row.id),
        playerId: userId,
        name: user.displayName,
        text,
        at: row.created_at.getTime(),
      });
    });

    socket.on('disconnect', () => {
      for (const gameId of joinedGames) {
        const key = `${gameId}:${userId}`;
        const left = (joinedCount.get(key) ?? 1) - 1;
        if (left > 0) {
          joinedCount.set(key, left);
          continue;
        }
        joinedCount.delete(key);
        try {
          tables.setConnected(gameId, userId, false);
        } catch (err) {
          app.log.error({ err, userId, gameId }, 'setConnected failed');
        }
      }
      joinedGames.clear();
    });
  });

  // Close sockets before Fastify closes the HTTP server (io.close() would close that server itself).
  app.addHook('preClose', (done) => {
    io.local.disconnectSockets(true);
    io.engine.close();
    done();
  });

  return io;
}
