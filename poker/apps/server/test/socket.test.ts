import type { AddressInfo } from 'node:net';
import { TableViewSchema, type ChatMessage, type ClientEvents, type ErrorMessage, type Notify, type ServerEvents, type TableJoinAck, type TableView } from '@poker/protocol';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { notify } from '../src/notify.js';
import { CHAT_BUCKET_CAPACITY, attachSockets, type PokerServer, type SocketTables } from '../src/realtime/socket.js';
import { createServer } from '../src/server.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

type Client = ClientSocket<ServerEvents, ClientEvents>;
type User = { id: string; displayName: string };

const SEED = '0123456789abcdef0123456789abcdef';
const HAND = '7d3f8a52-6c1e-4b8f-9a0d-2e5c4b1a9f30';

function viewFor(gameId: string): TableView {
  return {
    gameId,
    settings: {
      kind: 'cash',
      maxSeats: 6,
      levels: [{ level: 1, smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none', durationMinutes: 60 }],
      minBuyIn: 40,
      maxBuyIn: 200,
      startingStack: 0,
      turnSeconds: 20,
      timeBankSeconds: 60,
      timeBankTopUpSeconds: 10,
      rebuys: { allowed: false, untilLevel: 0 },
      payouts: [100],
      seatApproval: false,
      autoStart: true,
      showAllInEquity: true,
    },
    status: 'waiting',
    seats: [],
    board: [],
    pots: [],
    handId: null,
    handNumber: 0,
    buttonSeat: null,
    toAct: null,
    legal: null,
    deadline: null,
    mySeat: null,
    myHole: [],
    commitment: null,
    chat: [],
    seatRequests: [],
  };
}

function tableError(code: string, message: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

let forbiddenGames = new Set<string>();

function makeFakeTables() {
  return {
    join: vi.fn(async (gameId: string, _userId: string) => {
      if (forbiddenGames.has(gameId)) throw tableError('forbidden', 'You are not invited to this game');
      return viewFor(gameId);
    }),
    sit: vi.fn(async (_g: string, _u: string, _seat: number, _buyIn: number, _seed: string) => {}),
    leave: vi.fn(async (_g: string, _u: string) => {}),
    act: vi.fn(async (_g: string, _u: string, _h: string, _k: string, _a?: number) => {}),
    setClientSeed: vi.fn((_g: string, _u: string, _n: number, _s: string) => {}),
    useTimeBank: vi.fn(async (_g: string, _u: string) => {}),
    rebuy: vi.fn(async (_g: string, _u: string) => {}),
    host: vi.fn(async (_g: string, _u: string, _cmd: unknown) => {}),
    setConnected: vi.fn((_g: string, _u: string, _c: boolean) => {}),
  };
}

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let config: Config;
let app: FastifyInstance;
let io: PokerServer;
let url: string;
let now = 1_700_000_000_000;
let tables: ReturnType<typeof makeFakeTables>;
const clients: Client[] = [];

function connect(baseUrl: string, headers: Record<string, string>): Promise<Client> {
  const socket: Client = ioClient(baseUrl, {
    transports: ['websocket'],
    extraHeaders: headers,
    reconnection: false,
    forceNew: true,
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

async function connectAs(user: User, baseUrl = url): Promise<Client> {
  const h = await authed(app, user);
  return connect(baseUrl, { cookie: h.cookie, origin: config.publicOrigin });
}

function nextEvent<E extends 'error' | 'chat:message' | 'notify'>(
  socket: Client,
  event: E,
): Promise<E extends 'error' ? ErrorMessage : E extends 'chat:message' ? ChatMessage : Notify> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event within 3 s`)), 3000);
    (socket.once as (ev: string, fn: (p: unknown) => void) => void)(event, (p) => {
      clearTimeout(timer);
      resolve(p as never);
    });
  });
}

function collect<E extends 'error' | 'chat:message' | 'notify'>(socket: Client, event: E): unknown[] {
  const seen: unknown[] = [];
  (socket.on as (ev: string, fn: (p: unknown) => void) => void)(event, (p) => seen.push(p));
  return seen;
}

function join(socket: Client, gameId: string): Promise<TableJoinAck> {
  return socket.timeout(5000).emitWithAck('table:join', { gameId });
}

/** A round trip through the server: everything the server sent this socket before it has arrived. */
async function roundTrip(socket: Client): Promise<void> {
  await join(socket, crypto.randomUUID());
}

async function makeGame(host: User): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, 'Test game', '{}', now(), 'open') returning id`,
    [host.id],
  );
  return rows[0]!.id;
}

function emitRaw(socket: Client, event: string, payload: unknown): void {
  (socket.emit as (ev: string, p: unknown) => void)(event, payload);
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  config = testConfig();
  app = await buildApp({ pool, config, clock: () => now });
  tables = makeFakeTables();
  io = attachSockets(app, { tables: tables as unknown as SocketTables, pool, config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  // Let the server see every disconnect before the mocks are reset, so no call leaks into the next test.
  await vi.waitFor(() => expect(io.of('/').sockets.size).toBe(0));
  vi.clearAllMocks();
  forbiddenGames = new Set();
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await app?.close();
  await db?.cleanup();
});

describe('handshake', () => {
  it('rejects a connection without a session cookie', async () => {
    await expect(connect(url, { origin: config.publicOrigin })).rejects.toThrow('unauthorized');
  });

  it('rejects a connection with an unknown session cookie', async () => {
    await expect(connect(url, { cookie: `sid=${'a'.repeat(43)}`, origin: config.publicOrigin })).rejects.toThrow(
      'unauthorized',
    );
  });

  it('rejects a foreign Origin even with a valid cookie', async () => {
    const u = await makeUser(pool, 'Origin');
    const h = await authed(app, u);
    await expect(connect(url, { cookie: h.cookie, origin: 'http://evil.example' })).rejects.toThrow('forbidden origin');
  });

  it('accepts a valid cookie and joins room user:<id>', async () => {
    const u = await makeUser(pool, 'Valid');
    const s = await connectAs(u);
    await vi.waitFor(() => expect(io.sockets.adapter.rooms.get(`user:${u.id}`)?.has(s.id!)).toBe(true));
  });
});

describe('table:join', () => {
  it('acks the view, joins the game room and marks the user connected', async () => {
    const u = await makeUser(pool, 'Joiner');
    const s = await connectAs(u);
    const gameId = crypto.randomUUID();
    const ack = await join(s, gameId);
    expect(ack).toEqual({ ok: true, view: viewFor(gameId) });
    expect(TableViewSchema.safeParse(ack.ok && ack.view).success).toBe(true);
    expect(tables.join).toHaveBeenCalledWith(gameId, u.id);
    expect(tables.setConnected).toHaveBeenCalledWith(gameId, u.id, true);
    expect(io.sockets.adapter.rooms.get(`game:${gameId}`)?.has(s.id!)).toBe(true);
  });

  it('acks { ok: false } for a forbidden game and does not join its room', async () => {
    const u = await makeUser(pool, 'Outsider');
    const s = await connectAs(u);
    const gameId = crypto.randomUUID();
    forbiddenGames.add(gameId);
    const ack = await join(s, gameId);
    expect(ack).toEqual({ ok: false, error: 'forbidden' });
    expect(io.sockets.adapter.rooms.get(`game:${gameId}`)).toBeUndefined();
    expect(tables.setConnected).not.toHaveBeenCalled();
  });
});

describe('payload validation', () => {
  const gameId = '0b8c5a4e-3d2f-4e1a-9b7c-6d5e4f3a2b1c';
  const invalid: [string, unknown][] = [
    ['table:sit', { gameId, seat: 99, buyIn: 100, clientSeed: SEED }],
    ['table:sit', { gameId: 'not-a-uuid', seat: 1, buyIn: 100, clientSeed: SEED }],
    ['table:action', { gameId, handId: HAND, kind: 'shove' }],
    ['table:action', { gameId, handId: HAND, kind: 'bet', amount: 1.5 }],
    ['table:clientSeed', { gameId, handNumber: -1, clientSeed: SEED }],
    ['table:leave', { gameId, userId: '11111111-1111-4111-8111-111111111111' }],
    ['table:useTimeBank', 'nope'],
    ['table:rebuy', null],
    ['host:command', { gameId, command: { kind: 'explode' } }],
    ['chat:send', { gameId, text: '   ' }],
    ['chat:send', { gameId, text: 'x'.repeat(201) }],
  ];

  it.each(invalid)('%s %j → error bad_request and no manager call', async (event, payload) => {
    const u = await makeUser(pool, 'Invalid');
    const s = await connectAs(u);
    const err = nextEvent(s, 'error');
    emitRaw(s, event, payload);
    expect(await err).toMatchObject({ code: 'bad_request' });
    for (const fn of Object.values(tables)) expect(fn).not.toHaveBeenCalled();
    const { rows } = await pool.query('select 1 from chat_messages where user_id = $1', [u.id]);
    expect(rows).toEqual([]);
  });

  it('table:join with a non-uuid gameId → bad_request, ack { ok: false }, no manager call', async () => {
    const u = await makeUser(pool, 'BadJoin');
    const s = await connectAs(u);
    const err = nextEvent(s, 'error');
    const ack = await s.timeout(5000).emitWithAck('table:join', { gameId: 'nope' });
    expect(ack).toEqual({ ok: false, error: 'bad_request' });
    expect(await err).toMatchObject({ code: 'bad_request' });
    expect(tables.join).not.toHaveBeenCalled();
  });
});

describe('table events reach the manager with the session user', () => {
  it('forwards every table event and host command', async () => {
    const u = await makeUser(pool, 'Player');
    const s = await connectAs(u);
    const gameId = crypto.randomUUID();
    const other = '22222222-2222-4222-8222-222222222222';

    // userId fields in payloads are refused (strict schemas), so the user always comes from the session.
    s.emit('table:sit', { gameId, seat: 3, buyIn: 150, clientSeed: SEED });
    s.emit('table:action', { gameId, handId: HAND, kind: 'raise', amount: 40 });
    s.emit('table:action', { gameId, handId: HAND, kind: 'fold' });
    s.emit('table:clientSeed', { gameId, handNumber: 7, clientSeed: SEED });
    s.emit('table:useTimeBank', { gameId });
    s.emit('table:rebuy', { gameId });
    s.emit('host:command', { gameId, command: { kind: 'kick', playerId: other } });
    s.emit('host:command', { gameId, command: { kind: 'end' } });
    s.emit('table:leave', { gameId });

    await vi.waitFor(() => expect(tables.leave).toHaveBeenCalled());
    expect(tables.sit).toHaveBeenCalledWith(gameId, u.id, 3, 150, SEED);
    expect(tables.act).toHaveBeenNthCalledWith(1, gameId, u.id, HAND, 'raise', 40);
    expect(tables.act).toHaveBeenNthCalledWith(2, gameId, u.id, HAND, 'fold', undefined);
    expect(tables.setClientSeed).toHaveBeenCalledWith(gameId, u.id, 7, SEED);
    expect(tables.useTimeBank).toHaveBeenCalledWith(gameId, u.id);
    expect(tables.rebuy).toHaveBeenCalledWith(gameId, u.id);
    expect(tables.host).toHaveBeenNthCalledWith(1, gameId, u.id, { kind: 'kick', playerId: other });
    expect(tables.host).toHaveBeenNthCalledWith(2, gameId, u.id, { kind: 'end' });
    expect(tables.leave).toHaveBeenCalledWith(gameId, u.id);
  });

  it('turns a manager error into an error event with its code', async () => {
    const u = await makeUser(pool, 'Taken');
    const s = await connectAs(u);
    tables.sit.mockRejectedValueOnce(tableError('seat_taken', 'Seat 3 is taken'));
    const err = nextEvent(s, 'error');
    s.emit('table:sit', { gameId: crypto.randomUUID(), seat: 3, buyIn: 150, clientSeed: SEED });
    expect(await err).toEqual({ code: 'seat_taken', message: 'Seat 3 is taken' });
  });

  it('turns a synchronous manager error into an error event too', async () => {
    const u = await makeUser(pool, 'SyncErr');
    const s = await connectAs(u);
    tables.setClientSeed.mockImplementationOnce(() => {
      throw tableError('stale_hand', 'Old hand');
    });
    const err = nextEvent(s, 'error');
    s.emit('table:clientSeed', { gameId: crypto.randomUUID(), handNumber: 1, clientSeed: SEED });
    expect(await err).toEqual({ code: 'stale_hand', message: 'Old hand' });
  });

  it('hides unknown errors behind code internal', async () => {
    const u = await makeUser(pool, 'Boom');
    const s = await connectAs(u);
    tables.rebuy.mockRejectedValueOnce(new Error('db exploded: secret detail'));
    const err = nextEvent(s, 'error');
    s.emit('table:rebuy', { gameId: crypto.randomUUID() });
    expect(await err).toEqual({ code: 'internal', message: 'Internal error' });
  });

  it('rate limits a burst of more than 10 table events per second', async () => {
    const u = await makeUser(pool, 'Spammer');
    const s = await connectAs(u);
    const errors = collect(s, 'error');
    const gameId = crypto.randomUUID();
    for (let i = 0; i < 12; i++) s.emit('table:clientSeed', { gameId, handNumber: i, clientSeed: SEED });
    await vi.waitFor(() => expect(errors.length).toBe(2));
    expect(errors).toEqual([
      { code: 'rate_limited', message: expect.any(String) },
      { code: 'rate_limited', message: expect.any(String) },
    ]);
    expect(tables.setClientSeed).toHaveBeenCalledTimes(10);
    expect(tables.setClientSeed).not.toHaveBeenCalledWith(gameId, u.id, 10, SEED);

    // One second later the bucket is full again.
    now += 1000;
    s.emit('table:clientSeed', { gameId, handNumber: 99, clientSeed: SEED });
    await vi.waitFor(() => expect(tables.setClientSeed).toHaveBeenCalledWith(gameId, u.id, 99, SEED));
  });
});

describe('chat', () => {
  it('delivers to the game room only, with the sender name and trimmed text, and stores it', async () => {
    const a = await makeUser(pool, 'Alice');
    const b = await makeUser(pool, 'Bob');
    const c = await makeUser(pool, 'Carol');
    const gameId = await makeGame(a);
    const sa = await connectAs(a);
    const sb = await connectAs(b);
    const sc = await connectAs(c);
    const carolSaw = collect(sc, 'chat:message');
    expect((await join(sa, gameId)).ok).toBe(true);
    expect((await join(sb, gameId)).ok).toBe(true);
    await join(sc, crypto.randomUUID()); // Carol is at another table

    const got = nextEvent(sb, 'chat:message');
    sa.emit('chat:send', { gameId, text: '  nice hand  ' });
    const msg = await got;
    expect(msg).toEqual({
      gameId,
      id: expect.stringMatching(/^[1-9][0-9]*$/),
      playerId: a.id,
      name: 'Alice',
      text: 'nice hand',
      at: expect.any(Number),
    });
    const { rows } = await pool.query('select id::text, game_id, user_id, text from chat_messages where game_id = $1', [gameId]);
    expect(rows).toEqual([{ id: msg.id, game_id: gameId, user_id: a.id, text: 'nice hand' }]);

    await roundTrip(sc);
    expect(carolSaw).toEqual([]);
  });

  it('refuses chat from a socket that has not joined the game', async () => {
    const a = await makeUser(pool, 'Host');
    const d = await makeUser(pool, 'Dave');
    const gameId = await makeGame(a);
    const sa = await connectAs(a);
    await join(sa, gameId);
    const sd = await connectAs(d);
    const hostSaw = collect(sa, 'chat:message');
    const err = nextEvent(sd, 'error');
    sd.emit('chat:send', { gameId, text: 'let me in' });
    expect(await err).toMatchObject({ code: 'forbidden' });
    await roundTrip(sa);
    expect(hostSaw).toEqual([]);
    const { rows } = await pool.query('select 1 from chat_messages where game_id = $1', [gameId]);
    expect(rows).toEqual([]);
  });

  it(`rejects message ${CHAT_BUCKET_CAPACITY + 1} within 10 s with rate_limited; not stored or broadcast`, async () => {
    const a = await makeUser(pool, 'Chatty');
    const b = await makeUser(pool, 'Listener');
    const gameId = await makeGame(a);
    const sa = await connectAs(a);
    const sb = await connectAs(b);
    await join(sa, gameId);
    await join(sb, gameId);
    const bobSaw = collect(sb, 'chat:message');
    const errors = collect(sa, 'error');

    for (let i = 1; i <= CHAT_BUCKET_CAPACITY + 1; i++) sa.emit('chat:send', { gameId, text: `msg ${i}` });
    await vi.waitFor(() => expect(errors).toEqual([{ code: 'rate_limited', message: expect.any(String) }]));
    await vi.waitFor(() => expect(bobSaw).toHaveLength(CHAT_BUCKET_CAPACITY));
    await roundTrip(sb);
    expect((bobSaw as ChatMessage[]).map((m) => m.text)).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5']);
    const { rows } = await pool.query<{ text: string }>('select text from chat_messages where game_id = $1 order by id', [gameId]);
    expect(rows.map((r) => r.text)).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5']);

    // After 10 s the bucket has refilled.
    now += 10_000;
    const got = nextEvent(sb, 'chat:message');
    sa.emit('chat:send', { gameId, text: 'later' });
    expect((await got).text).toBe('later');
  });
});

describe('disconnect', () => {
  it('marks the user disconnected in each joined game when their last socket there closes', async () => {
    const u = await makeUser(pool, 'Leaver');
    const g1 = crypto.randomUUID();
    const g2 = crypto.randomUUID();
    const s1 = await connectAs(u);
    const s2 = await connectAs(u);
    await join(s1, g1);
    await join(s1, g2);
    await join(s2, g1);

    s1.disconnect();
    await vi.waitFor(() => expect(tables.setConnected).toHaveBeenCalledWith(g2, u.id, false));
    expect(tables.setConnected).not.toHaveBeenCalledWith(g1, u.id, false);

    s2.disconnect();
    await vi.waitFor(() => expect(tables.setConnected).toHaveBeenCalledWith(g1, u.id, false));
  });
});

describe('createServer wiring', () => {
  it('pushes notify() to that user’s sockets only', async () => {
    const real = await createServer({ pool, config, scheduler: false });
    try {
      await real.app.listen({ port: 0, host: '127.0.0.1' });
      const realUrl = `http://127.0.0.1:${(real.app.server.address() as AddressInfo).port}`;
      expect(real.app.tables).toBe(real.tables);
      const u1 = await makeUser(pool, 'Notified');
      const u2 = await makeUser(pool, 'Bystander');
      const s1 = await connectAs(u1, realUrl);
      const s2 = await connectAs(u2, realUrl);
      const otherSaw = collect(s2, 'notify');
      const got = nextEvent(s1, 'notify');
      const payload = await notify(pool, u1.id, 'invite', 'You are invited', '/games/x');
      expect(await got).toEqual(payload);
      // A round trip to u2's server-side socket via the same io instance.
      await new Promise<void>((resolve) => {
        s2.timeout(5000).emit('table:join', { gameId: 'bad' }, () => resolve());
      });
      expect(otherSaw).toEqual([]);
    } finally {
      for (const c of clients.splice(0)) c.disconnect();
      await real.close();
    }
  });
});
