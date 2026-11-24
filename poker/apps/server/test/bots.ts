/**
 * Bot players for the real-time integration test: each bot registers over REST against a listening
 * server, connects socket.io-client with its session cookie, records every event it receives (in order,
 * tagged with the hand it belongs to), answers `hand:commitment` with a client seed, and acts randomly
 * within `legal` on its own `toAct` (unless it is idle).
 */
import { newClientSeed, type HandEvent, type LegalActions } from '@poker/engine';
import type {
  ClientEvents,
  HandCommitment,
  HandEventMessage,
  HostCommand,
  ServerEvents,
  TableJoinAck,
  TableSeats,
} from '@poker/protocol';
import { io, type Socket } from 'socket.io-client';

export type BotSocket = Socket<ServerEvents, ClientEvents>;

/** One received event: socket event name, raw payload, hand number it belongs to (null if none), receive time. */
export interface Received {
  name: string;
  payload: unknown;
  gameId: string | null;
  handNumber: number | null;
  at: number;
}

export type HandStarted = Extract<HandEvent, { type: 'handStarted' }>;
export type HandEnded = Extract<HandEvent, { type: 'handEnded' }>;

/** A hand event with the time it arrived. */
export interface TimedEvent {
  event: HandEvent;
  at: number;
}

/** What one bot knows about one hand of one game. */
export interface BotHand {
  gameId: string;
  handNumber: number;
  /** The `hand:commitment` for this hand number, if it arrived before this hand's `handStarted`. */
  commitmentBeforeStart: string | null;
  /** The client seed this bot sent for this hand number. */
  clientSeed: string | null;
  /** Diagnostics: commitments received for this hand number, when the seed left, when handStarted arrived. */
  commitmentsReceived: number;
  seedEmittedAt: number | null;
  startedAt: number | null;
  /** Client seeds of `table:sit` messages sent since the bot's previous hand in which it was dealt. */
  sitSeeds: string[];
  started: HandStarted | null;
  ended: HandEnded | null;
  /** Every `hand:event` of the hand in arrival order (handStarted .. handEnded), cardProofs included. */
  events: TimedEvent[];
}

export interface BotOptions {
  baseUrl: string;
  origin: string;
  name: string;
  /** Seed for the action PRNG. */
  seed: number;
  /** Never act (the server must time this bot out). */
  idle?: boolean;
}

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Client-side bucket for outgoing table events, below the server's 10 per second per socket. */
const BUCKET_CAPACITY = 8;
const BUCKET_RATE = 8; // tokens per second

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function gameIdOf(payload: unknown): string | null {
  return isObject(payload) && typeof payload.gameId === 'string' ? payload.gameId : null;
}

export class Bot {
  readonly name: string;
  readonly email: string;
  readonly password = 'bot-password-123';
  readonly idle: boolean;
  id = '';
  cookie = '';
  socket: BotSocket | null = null;
  /** Every event received, in order. */
  readonly received: Received[] = [];
  /** Hands keyed by `${gameId}:${handNumber}`. */
  readonly hands = new Map<string, BotHand>();
  /** Actions this bot sent: hand id, kind, amount, time. */
  readonly sent: { gameId: string; handId: string; kind: string; amount?: number; at: number }[] = [];
  /** When false, a bot that has been unseated (bust) does not sit again. */
  autoResit = true;

  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly rand: () => number;
  private readonly current = new Map<string, number>(); // gameId -> hand number in progress
  private readonly seatPref = new Map<string, { seat: number; buyIn: number }>();
  private readonly seated = new Set<string>(); // gameIds where the latest table:seats lists this bot
  private readonly waiters = new Set<() => void>();
  private readonly pendingSitSeeds = new Map<string, string[]>();
  // The server allows 10 table events per second per socket (I-9 token bucket); stay below it.
  private readonly outbox: { urgent: boolean; run: () => void }[] = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private tokens = BUCKET_CAPACITY;
  private refilledAt = Date.now();

  constructor(opts: BotOptions) {
    this.baseUrl = opts.baseUrl;
    this.origin = opts.origin;
    this.name = opts.name;
    this.idle = opts.idle ?? false;
    this.rand = mulberry32(opts.seed);
    this.email = `${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${Math.floor(Math.random() * 1e9)}@bots.test`;
  }

  /** Registers through REST (keeps the session cookie) and connects the socket. */
  async start(): Promise<this> {
    const res = await fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.origin },
      body: JSON.stringify({ email: this.email, password: this.password, displayName: this.name }),
    });
    if (res.status !== 201) throw new Error(`register ${this.name}: ${res.status} ${await res.text()}`);
    const user = (await res.json()) as { id: string };
    this.id = user.id;
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
    if (sid === undefined) throw new Error(`register ${this.name}: no sid cookie`);
    this.cookie = sid.split(';')[0] ?? '';
    await this.connect();
    return this;
  }

  private connect(): Promise<void> {
    const socket: BotSocket = io(this.baseUrl, {
      transports: ['websocket'],
      extraHeaders: { cookie: this.cookie, origin: this.origin },
      reconnection: false,
      forceNew: true,
    });
    this.socket = socket;
    socket.onAny((name: string, ...args: unknown[]) => this.onEvent(name, args[0]));
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err) => reject(err));
    });
  }

  /** Queues an outgoing table event; a client-side token bucket keeps the bot under the server's limit. */
  private send(fn: (socket: BotSocket) => void, urgent = false): void {
    // Client seeds jump the queue: the server waits only seedWaitMs for them.
    const item = { urgent, run: () => fn(this.sock()) };
    if (urgent) this.outbox.unshift(item);
    else this.outbox.push(item);
    this.pump();
  }

  private pump(): void {
    if (this.outboxTimer !== null || this.socket === null) return;
    while (this.outbox.length > 0) {
      const now = Date.now();
      this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + ((now - this.refilledAt) / 1000) * BUCKET_RATE);
      this.refilledAt = now;
      // Non-urgent events leave one token in reserve for the next client seed.
      const need = this.outbox[0]?.urgent === true ? 1 : 2;
      if (this.tokens < need) {
        const wait = Math.ceil(((need - this.tokens) / BUCKET_RATE) * 1000);
        this.outboxTimer = setTimeout(() => {
          this.outboxTimer = null;
          this.pump();
        }, wait);
        return;
      }
      this.tokens -= 1;
      this.outbox.shift()?.run();
    }
  }

  private sock(): BotSocket {
    if (this.socket === null) throw new Error(`${this.name} is not connected`);
    return this.socket;
  }

  private hand(gameId: string, handNumber: number): BotHand {
    const key = `${gameId}:${handNumber}`;
    let h = this.hands.get(key);
    if (h === undefined) {
      h = {
        gameId,
        handNumber,
        commitmentBeforeStart: null,
        clientSeed: null,
        commitmentsReceived: 0,
        seedEmittedAt: null,
        startedAt: null,
        sitSeeds: [],
        started: null,
        ended: null,
        events: [],
      };
      this.hands.set(key, h);
    }
    return h;
  }

  /** Hands of one game that ended, ordered by hand number. */
  handsOf(gameId: string): BotHand[] {
    return [...this.hands.values()]
      .filter((h) => h.gameId === gameId && h.started !== null && h.ended !== null)
      .sort((a, b) => a.handNumber - b.handNumber);
  }

  /** Number of `handEnded` events received for a game. */
  handsEnded(gameId: string): number {
    return this.received.filter(
      (r) => r.name === 'hand:event' && r.gameId === gameId && (r.payload as HandEventMessage).event.type === 'handEnded',
    ).length;
  }

  private onEvent(name: string, payload: unknown): void {
    const at = Date.now();
    const gameId = gameIdOf(payload);
    let handNumber: number | null = gameId === null ? null : (this.current.get(gameId) ?? null);

    if (name === 'hand:commitment') {
      const msg = payload as HandCommitment;
      handNumber = msg.handNumber;
      const h = this.hand(msg.gameId, msg.handNumber);
      if (h.started === null) h.commitmentBeforeStart = msg.commitment;
      const clientSeed = newClientSeed();
      h.clientSeed = clientSeed;
      h.commitmentsReceived++;
      this.send((s) => {
        h.seedEmittedAt = Date.now();
        s.emit('table:clientSeed', { gameId: msg.gameId, handNumber: msg.handNumber, clientSeed });
      }, true);
    } else if (name === 'hand:event') {
      const msg = payload as HandEventMessage;
      const ev = msg.event;
      if (ev.type === 'handStarted') {
        handNumber = ev.handNumber;
        this.current.set(msg.gameId, ev.handNumber);
        const h = this.hand(msg.gameId, ev.handNumber);
        h.started = ev;
        h.startedAt = at;
        // A sit seed counts for the first hand this bot is dealt into after the sit (the server may process
        // the sit after a hand it watched has started).
        if (ev.seats.some((x) => x.playerId === this.id)) {
          h.sitSeeds = this.pendingSitSeeds.get(msg.gameId) ?? [];
          this.pendingSitSeeds.delete(msg.gameId);
        }
      }
      if (handNumber !== null) {
        const h = this.hand(msg.gameId, handNumber);
        h.events.push({ event: ev, at });
        if (ev.type === 'handEnded') {
          h.ended = ev;
          this.current.delete(msg.gameId);
        }
        if (ev.type === 'toAct' && h.started !== null) this.maybeAct(msg.gameId, h.started, ev.seat, ev.legal);
      }
    } else if (name === 'table:seats') {
      this.onSeats(payload as TableSeats);
    }

    this.received.push({ name, payload, gameId, handNumber, at });
    for (const w of [...this.waiters]) w();
  }

  private onSeats(msg: TableSeats): void {
    const mine = msg.seats.some((s) => s.playerId === this.id);
    if (mine) {
      this.seated.add(msg.gameId);
      return;
    }
    const wasSeated = this.seated.delete(msg.gameId);
    const pref = this.seatPref.get(msg.gameId);
    // Bust in a cash game: the server unseats a player at 0 chips; buy in again at the same seat.
    if (wasSeated && pref !== undefined && this.autoResit && !msg.seats.some((s) => s.seat === pref.seat)) {
      this.sit(msg.gameId, pref.seat, pref.buyIn);
    }
  }

  private maybeAct(gameId: string, started: HandStarted, seat: number, legal: LegalActions): void {
    const me = started.seats.find((s) => s.playerId === this.id);
    if (me === undefined || me.seat !== seat || this.idle) return;
    const { kind, amount } = this.choose(legal);
    this.sent.push({ gameId, handId: started.handId, kind, amount, at: Date.now() });
    const payload = { gameId, handId: started.handId, kind, ...(amount === undefined ? {} : { amount }) };
    this.send((s) => s.emit('table:action', payload));
  }

  /** Random legal action: fold sometimes facing a bet, mostly check/call, sometimes bet/raise, rarely all-in. */
  private choose(legal: LegalActions): { kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn'; amount?: number } {
    const r = this.rand();
    const sized = (): number => {
      const span = legal.maxTo - legal.minTo;
      // Skewed towards small sizes so stacks last.
      return legal.minTo + Math.floor(span * this.rand() ** 3);
    };
    const canAggress = legal.canBet || legal.canRaise;
    if (r < 0.02 && canAggress) return { kind: 'allIn' };
    if (legal.canCheck) {
      if (r < 0.25 && legal.canBet) return { kind: 'bet', amount: sized() };
      return { kind: 'check' };
    }
    if (r < 0.2 && legal.canFold) return { kind: 'fold' };
    if (r < 0.32 && legal.canRaise) return { kind: 'raise', amount: sized() };
    if (legal.callAmount > 0) return { kind: 'call' };
    return { kind: 'fold' };
  }

  /** Resolves when `predicate()` is true (checked now and after every received event). */
  waitFor(predicate: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
    });
  }

  join(gameId: string): Promise<TableJoinAck> {
    return this.sock().timeout(5000).emitWithAck('table:join', { gameId });
  }

  sit(gameId: string, seat: number, buyIn: number): void {
    this.seatPref.set(gameId, { seat, buyIn });
    const clientSeed = newClientSeed();
    this.pendingSitSeeds.set(gameId, [...(this.pendingSitSeeds.get(gameId) ?? []), clientSeed]);
    this.send((s) => s.emit('table:sit', { gameId, seat, buyIn, clientSeed }));
  }

  leave(gameId: string): void {
    this.seatPref.delete(gameId);
    this.send((s) => s.emit('table:leave', { gameId }));
  }

  host(gameId: string, command: HostCommand): void {
    this.send((s) => s.emit('host:command', { gameId, command }));
  }

  async wallet(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/wallet`, { headers: { cookie: this.cookie, origin: this.origin } });
    if (res.status !== 200) throw new Error(`wallet ${this.name}: ${res.status}`);
    return ((await res.json()) as { balance: number }).balance;
  }

  disconnect(): void {
    this.waiters.clear();
    if (this.outboxTimer !== null) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    this.outbox.length = 0;
    this.socket?.disconnect();
    this.socket = null;
  }
}
