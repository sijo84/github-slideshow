/**
 * The one Socket.IO connection (I-10).
 *
 * - `getSocket()` creates a lazy singleton (`withCredentials`, path `/socket.io`). The server needs the `sid` cookie
 *   at handshake, so call it only once the user is signed in.
 * - `joinTable(gameId)` emits `table:join` and remembers the id; after every reconnect the socket re-joins every
 *   remembered table and hands the fresh views to `onRejoin` listeners.
 * - `leaveTableRoom(gameId)` forgets the id locally (no rejoin). It does not emit `table:leave`, which stands the
 *   player up; the server drops the room on disconnect.
 * - `disconnectSocket()` closes and forgets the connection (used on log out).
 */
import type { ClientEvents, ServerEvents, TableView } from '@poker/protocol';
import { io, type Socket } from 'socket.io-client';

export type PokerSocket = Socket<ServerEvents, ClientEvents>;

const JOIN_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(view: TableView): void;
  reject(err: Error): void;
}

let socket: PokerSocket | null = null;
/** Tables to (re-)join on every connect. */
const joined = new Set<string>();
/** joinTable calls waiting for the socket to connect, by game id. */
const pending = new Map<string, Pending[]>();
const rejoinListeners = new Set<(view: TableView) => void>();

function emitJoin(s: PokerSocket, gameId: string): Promise<TableView> {
  return new Promise<TableView>((resolve, reject) => {
    s.timeout(JOIN_TIMEOUT_MS).emit('table:join', { gameId }, (err, res) => {
      if (err) reject(new Error('The table did not answer in time'));
      else if (res.ok) resolve(res.view);
      else reject(new Error(res.error));
    });
  });
}

function settle(gameId: string, result: { view: TableView } | { error: Error }): void {
  const waiters = pending.get(gameId) ?? [];
  pending.delete(gameId);
  for (const w of waiters) {
    if ('view' in result) w.resolve(result.view);
    else w.reject(result.error);
  }
}

function onConnect(s: PokerSocket): void {
  for (const gameId of [...joined]) {
    const isRejoin = !pending.has(gameId);
    emitJoin(s, gameId).then(
      (view) => {
        if (isRejoin) for (const l of rejoinListeners) l(view);
        settle(gameId, { view });
      },
      (error: Error) => {
        if (!isRejoin) joined.delete(gameId);
        settle(gameId, { error });
      },
    );
  }
}

export function getSocket(): PokerSocket {
  if (socket) return socket;
  const s: PokerSocket = io({
    path: '/socket.io',
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });
  s.on('connect', () => onConnect(s));
  s.on('disconnect', (reason) => {
    // A server-side disconnect is not retried automatically by socket.io; try again (the handshake re-checks auth).
    if (reason === 'io server disconnect' && socket === s) setTimeout(() => socket === s && s.connect(), 1_000);
  });
  socket = s;
  return s;
}

export function joinTable(gameId: string): Promise<TableView> {
  const s = getSocket();
  joined.add(gameId);
  if (s.connected) {
    return emitJoin(s, gameId).catch((err: unknown) => {
      joined.delete(gameId);
      throw err;
    });
  }
  return new Promise<TableView>((resolve, reject) => {
    const list = pending.get(gameId) ?? [];
    list.push({ resolve, reject });
    pending.set(gameId, list);
  });
}

export function leaveTableRoom(gameId: string): void {
  joined.delete(gameId);
  settle(gameId, { error: new Error('Left the table') });
}

/** Called with the fresh view each time a remembered table is re-joined after a reconnect. Returns an unsubscribe. */
export function onRejoin(listener: (view: TableView) => void): () => void {
  rejoinListeners.add(listener);
  return () => rejoinListeners.delete(listener);
}

export function disconnectSocket(): void {
  const s = socket;
  socket = null;
  joined.clear();
  for (const gameId of [...pending.keys()]) settle(gameId, { error: new Error('Disconnected') });
  s?.removeAllListeners();
  s?.disconnect();
}
