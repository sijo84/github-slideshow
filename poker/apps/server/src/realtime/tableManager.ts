/**
 * Server-side table manager: one in-memory table per open game (PLAN I-9).
 *
 * - Every piece of work for a table runs through that table's promise queue, so two fast actions cannot
 *   interleave. Hand state is read and replaced synchronously inside a queued task (no await in between).
 * - Stacks in memory are the source of truth for the running game. A player's stack always equals the
 *   balance of their `table` ledger account: buy-ins and cash-outs go through the ledger, and every hand's
 *   result is booked between table accounts in the same transaction that stores the hand.
 * - Hole cards only ever leave the server through `redact` (owner only) or public `showCards` events.
 *   Server seeds and salt keys are stored in `hand_seeds` and never sent or logged.
 */
import { randomUUID } from 'node:crypto';
import {
  advance,
  allInRunout,
  analyse,
  applyAction,
  board as boardOf,
  cardCommitments,
  cardSalt,
  commit,
  dealPositions,
  deckFromSeeds,
  equityExact,
  evaluate7,
  holeCards,
  IllegalActionError,
  isComplete,
  legalActions,
  newServerSeed,
  nextButton,
  settle,
  sharedNetwork,
  startHand,
  timeoutAction,
  toAct as toActOf,
  type ActionKind,
  type Card,
  type HandEvent,
  type HandRecord,
  type HandState,
  type IntegrityFlag,
  type PlayerAction,
  type Pot,
  type SeatIndex,
  type Stakes,
  type Street,
} from '@poker/engine';
import {
  GameSettingsSchema,
  type ChatMessage,
  type GameSettings,
  type HostCommand,
  type ResultEntry,
  type SeatView,
  type ServerEventName,
  type TableStatus,
  type TableView,
} from '@poker/protocol';
import type { Pool } from 'pg';
import { TournamentController, type TournamentControllerLike } from '../games/tournament.js';
import { notify } from '../notify.js';
import { avatarUrlFor } from '../storage/avatars.js';
import * as ledger from '../wallet/ledger.js';
import { applyHostCommand, type GameStatus, type HostEffect } from './hostControls.js';

// ---------------------------------------------------------------------------------------------------------
// Public types

export class TableError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'TableError';
  }
}

export interface TableLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface TournamentFactoryArgs {
  pool: Pool;
  gameId: string;
  settings: GameSettings;
  startedAtMs: number;
  pausedMs: () => number;
}

export interface TableManagerDeps {
  pool: Pool;
  clock: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  emitTo: (userId: string, event: ServerEventName, payload: unknown) => void;
  emitRoom: (gameId: string, event: ServerEventName, payload: unknown) => void;
  seedWaitMs?: number;
  runoutPacingMs?: number;
  handDelayMs?: number;
  autoStartMs?: number;
  rebuyWaitMs?: number;
  tournamentFactory?: (a: TournamentFactoryArgs) => TournamentControllerLike;
  /** Defaults to the console. Never receives seeds, salts or hole cards. */
  logger?: TableLogger;
}

/** The protocol's host commands plus `end` (I-9; the protocol gains it in S12). */
export type TableHostCommand = HostCommand | { kind: 'end' };

/** The per-viewer view of a hand event: other seats' hole cards are removed. */
export function redact(event: HandEvent, viewerSeat: SeatIndex | null): HandEvent {
  if (event.type === 'dealHole' && event.seat !== viewerSeat) {
    return { ...event, cards: [] };
  }
  return event;
}

// ---------------------------------------------------------------------------------------------------------
// Internal state

interface SeatState {
  seat: SeatIndex;
  userId: string;
  name: string;
  avatarUrl: string;
  /** stack between hands (the hand's live stack is in LiveSeat) */
  stack: number;
  timeBankMs: number;
  connected: boolean;
  /** cash: kicked, or left during a hand. Auto-acted at each turn, cashed out after the hand. */
  leaving: boolean;
  /** tournament: left or kicked. Keeps the seat and is auto-acted until blinded out. */
  away: boolean;
}

interface LiveSeat {
  stack: number;
  bet: number;
  folded: boolean;
  allIn: boolean;
  shown: Card[] | null;
}

interface Turn {
  seat: SeatIndex;
  deadline: number;
  usingTimeBank: boolean;
  bankStartedAt: number;
  token: number;
  timer: unknown;
}

interface LiveHand {
  handId: string;
  handNumber: number;
  state: HandState;
  bigBlind: number;
  startedAt: number;
  serverSeed: string;
  saltKey: string;
  commitment: string;
  clientSeeds: string[];
  deck: Card[];
  /** hole-card deck positions per seat (from dealPositions and the deal order) */
  holePositions: Map<SeatIndex, number[]>;
  boardPositions: number[];
  playerIds: Record<SeatIndex, string>;
  startStacks: Map<SeatIndex, number>;
  live: Map<SeatIndex, LiveSeat>;
  board: Card[];
  pots: Pot[];
  events: HandEvent[];
  turn: Turn | null;
  runout: boolean;
  proofsShown: Set<SeatIndex>;
}

interface PendingSeed {
  handNumber: number;
  serverSeed: string;
  saltKey: string;
  commitment: string;
}

interface Seeding {
  handNumber: number;
  expected: Set<string>;
  seeds: Map<string, string>;
  timer: unknown;
}

interface SeatRequest {
  playerId: string;
  name: string;
  avatarUrl: string;
  seat: SeatIndex;
  buyIn: number;
  clientSeed: string;
}

interface RebuyWindow {
  users: Set<string>;
  timer: unknown;
  stacks: { userId: string; startStack: number }[];
}

interface Table {
  gameId: string;
  hostId: string;
  name: string;
  kind: 'cash' | 'tournament';
  settings: GameSettings;
  /** host changes, applied at the start of the next hand */
  pendingSettings: GameSettings | null;
  status: TableStatus;
  seats: Map<SeatIndex, SeatState>;
  /** users who joined (watchers and players) */
  members: Set<string>;
  /** users whose access was checked (host or invited) */
  allowed: Set<string>;
  requests: Map<string, SeatRequest>;
  chat: ChatMessage[];
  hand: LiveHand | null;
  lastHandNumber: number;
  buttonSeat: SeatIndex | null;
  pending: PendingSeed | null;
  seeding: Seeding | null;
  /** clientSeed given at sit time, used for the pending hand if no other seed arrives */
  sitSeeds: Map<string, { handNumber: number; seed: string }>;
  queue: Promise<void>;
  timers: Set<unknown>;
  nextHandTimer: unknown;
  autoStartTimer: unknown;
  pauseRequested: boolean;
  endRequested: boolean;
  records: HandRecord[];
  analyseEvery: number;
  handsSinceAnalysis: number;
  nets: Map<string, number>;
  names: Map<string, string>;
  controller: TournamentControllerLike | null;
  levelNumber: number | null;
  pausedTotalMs: number;
  pausedSince: number | null;
  rebuyWindow: RebuyWindow | null;
  results: ResultEntry[] | null;
}

interface GameRow {
  id: string;
  host: string;
  name: string;
  settings: unknown;
  status: GameStatus;
}

// ---------------------------------------------------------------------------------------------------------
// Module helpers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_LIMIT = 50;
const ANALYSE_SLOW_MS = 50;
const ANALYSE_SLOW_EVERY = 25;
const TOP_UP_EVERY_HANDS = 100;
const LIVE_DB_STATUSES: ReadonlySet<GameStatus> = new Set(['open', 'running', 'paused']);

const consoleLogger: TableLogger = {
  info: (message) => console.info(`[tables] ${message}`),
  error: (message, err) => console.error(`[tables] ${message}`, err),
};

const err = {
  notFound: () => new TableError('not_found', 'Game not found', 404),
  forbidden: () => new TableError('forbidden', 'You are not invited to this game', 403),
  closed: (msg = 'The table is closed') => new TableError('closed', msg, 409),
  badState: (msg: string) => new TableError('bad_state', msg, 409),
  notSeated: () => new TableError('not_seated', 'You are not seated at this table', 409),
};

function toDbStatus(s: TableStatus): GameStatus {
  return s === 'waiting' ? 'open' : s;
}

/** Seats in deal order: first seat left of the button first, the button last. */
function dealOrder(seats: SeatIndex[], button: SeatIndex, maxSeats: number): SeatIndex[] {
  const dist = (s: SeatIndex): number => (s - button + maxSeats) % maxSeats || maxSeats;
  return [...seats].sort((a, b) => dist(a) - dist(b));
}

function stakesOf(level: Stakes): Stakes {
  return { smallBlind: level.smallBlind, bigBlind: level.bigBlind, ante: level.ante, anteKind: level.anteKind };
}

/** The street the next runout deal produces, from the board size before it. */
function streetAfter(boardLength: number): Street {
  if (boardLength === 0) return 'flop';
  return boardLength === 3 ? 'turn' : 'river';
}

/** 1-based places by net result, best first; equal nets share a place. */
function placesByNet(nets: Map<string, number>, names: Map<string, string>): ResultEntry[] {
  const list = [...nets.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return list.map(([userId, net]) => ({
    userId,
    name: names.get(userId) ?? '',
    place: 1 + list.filter(([, other]) => other > net).length,
    prize: 0,
  }));
}

/** Flags with the same (kind, players) become one: higher score, summaries joined, evidence merged. */
function mergeFlags(flags: IntegrityFlag[]): IntegrityFlag[] {
  const byKey = new Map<string, IntegrityFlag>();
  for (const f of flags) {
    const players = [...f.players].sort() as [string, string];
    const key = `${f.kind}:${players.join(',')}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...f, players, evidenceHandIds: [...f.evidenceHandIds] });
      continue;
    }
    prev.score = Math.max(prev.score, f.score);
    if (!prev.summary.includes(f.summary)) prev.summary = `${prev.summary}; ${f.summary}`;
    prev.evidenceHandIds = [...new Set([...prev.evidenceHandIds, ...f.evidenceHandIds])];
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------------------------------------

export class TableManager {
  private readonly deps: TableManagerDeps;
  private readonly log: TableLogger;
  private readonly seedWaitMs: number;
  private readonly runoutPacingMs: number;
  private readonly handDelayMs: number;
  private readonly autoStartMs: number;
  private readonly rebuyWaitMs: number;
  private readonly tournamentFactory: (a: TournamentFactoryArgs) => TournamentControllerLike;
  private readonly tables = new Map<string, Table>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly listeners: ((gameId: string, record: HandRecord) => void)[] = [];
  private turnTokens = 0;
  private closed = false;

  constructor(deps: TableManagerDeps) {
    this.deps = deps;
    this.log = deps.logger ?? consoleLogger;
    this.seedWaitMs = deps.seedWaitMs ?? 2000;
    this.runoutPacingMs = deps.runoutPacingMs ?? 1500;
    this.handDelayMs = deps.handDelayMs ?? 3000;
    this.autoStartMs = deps.autoStartMs ?? 5000;
    this.rebuyWaitMs = deps.rebuyWaitMs ?? 15000;
    this.tournamentFactory = deps.tournamentFactory ?? ((a) => new TournamentController(a));
  }

  // ------------------------------------------------------------------------------------------------------
  // Public API

  async open(gameId: string): Promise<void> {
    if (this.tables.has(gameId)) return;
    const inFlight = this.opening.get(gameId);
    if (inFlight) return inFlight;
    const p = this.load(gameId);
    this.opening.set(gameId, p);
    try {
      await p;
    } finally {
      this.opening.delete(gameId);
    }
  }

  isOpen(gameId: string): boolean {
    return this.tables.has(gameId);
  }

  async join(gameId: string, userId: string): Promise<TableView> {
    const table = await this.tableFor(gameId, userId);
    table.members.add(userId);
    await this.refreshChat(table);
    return this.viewFor(gameId, userId);
  }

  async sit(gameId: string, userId: string, seat: number, buyIn: number, clientSeed: string): Promise<void> {
    const table = await this.tableFor(gameId, userId);
    await this.enqueue(table, async () => {
      this.validateSit(table, userId, seat, buyIn);
      await this.checkWallet(userId, buyIn);
      const user = await this.loadUser(userId);
      const request: SeatRequest = { playerId: userId, ...user, seat, buyIn, clientSeed };
      if (table.settings.seatApproval && userId !== table.hostId) {
        await this.queueSeatRequest(table, request);
        return;
      }
      await this.seatPlayer(table, request);
    });
  }

  async leave(gameId: string, userId: string): Promise<void> {
    const table = this.requireTable(gameId, userId);
    await this.enqueue(table, async () => {
      if (table.requests.delete(userId) && !this.seatOfUser(table, userId)) {
        this.emitHostView(table);
        return;
      }
      const seat = this.seatOfUser(table, userId);
      if (!seat) throw err.notSeated();
      await this.removeFromPlay(table, seat);
    });
  }

  async act(gameId: string, userId: string, handId: string, kind: ActionKind, amount?: number): Promise<void> {
    const table = this.requireTable(gameId, userId);
    await this.enqueue(table, async () => {
      const hand = table.hand;
      if (!hand || hand.handId !== handId) throw new TableError('stale_hand', 'That hand is over', 409);
      const seat = this.seatOfUser(table, userId);
      if (!seat) throw err.notSeated();
      if (toActOf(hand.state) !== seat.seat) throw new TableError('not_your_turn', 'It is not your turn', 409);
      const turn = hand.turn;
      const bankUsed = turn?.usingTimeBank ? this.deps.clock() - turn.bankStartedAt : 0;
      const action: PlayerAction = amount === undefined ? { seat: seat.seat, kind } : { seat: seat.seat, kind, amount };
      try {
        this.applyPlayerAction(table, hand, action, false);
      } catch (e) {
        if (e instanceof IllegalActionError) throw new TableError('illegal_action', e.message);
        throw e;
      }
      seat.timeBankMs = Math.max(0, seat.timeBankMs - bankUsed);
      await this.advanceHand(table);
    });
  }

  setClientSeed(gameId: string, userId: string, handNumber: number, clientSeed: string): void {
    const table = this.tables.get(gameId);
    const seeding = table?.seeding;
    if (!table || !seeding || seeding.handNumber !== handNumber || !this.seatOfUser(table, userId)) return;
    if (typeof clientSeed !== 'string' || clientSeed.length === 0 || clientSeed.length > 128) return;
    seeding.seeds.set(userId, clientSeed);
    if ([...seeding.expected].every((u) => seeding.seeds.has(u))) {
      this.cancelTimer(table, seeding.timer);
      void this.enqueue(table, () => this.dealIfSeeding(table, seeding)).catch((e: unknown) => this.log.error('deal failed', e));
    }
  }

  async useTimeBank(gameId: string, userId: string): Promise<void> {
    const table = this.requireTable(gameId, userId);
    await this.enqueue(table, () => {
      const hand = table.hand;
      const seat = this.seatOfUser(table, userId);
      const turn = hand?.turn;
      if (!hand || !turn || !seat || turn.seat !== seat.seat) throw new TableError('not_your_turn', 'It is not your turn', 409);
      if (!turn.usingTimeBank && seat.timeBankMs > 0) this.switchToTimeBank(table, hand, turn, seat);
    });
  }

  async rebuy(gameId: string, userId: string): Promise<void> {
    const table = this.requireTable(gameId, userId);
    await this.enqueue(table, async () => {
      const window = table.rebuyWindow;
      const seat = this.seatOfUser(table, userId);
      if (!window || !window.users.has(userId) || !seat || !table.controller) throw err.badState('No rebuy is open for you now');
      window.users.delete(userId);
      seat.stack = await table.controller.rebuy(userId, this.deps.clock());
      this.emitSeats(table);
      if (window.users.size === 0) await this.closeRebuyWindow(table, window);
    });
  }

  async host(gameId: string, userId: string, cmd: TableHostCommand): Promise<void> {
    const table = await this.tableFor(gameId, userId);
    await this.enqueue(table, async () => {
      if (userId !== table.hostId) throw new TableError('forbidden', 'Only the host can do that', 403);
      if (table.status === 'finished') throw err.closed('The game is over');
      if (cmd.kind === 'end' && table.kind === 'tournament' && table.status !== 'waiting') {
        throw err.badState('A running tournament ends by itself');
      }
      const current = table.pendingSettings ?? table.settings;
      // The cast only matters until the protocol's HostCommand gains { kind: 'end' } (S12).
      // A pause that waits for the end of the hand already counts: resume cancels it, a second pause is refused.
      const effective: GameStatus = table.pauseRequested ? 'paused' : toDbStatus(table.status);
      const res = applyHostCommand(current, effective, cmd as HostCommand, userId, table.hostId);
      if ('error' in res) throw err.badState(res.error);
      if (cmd.kind === 'updateSettings') await this.updateSettings(table, res.settings);
      const playerId = 'playerId' in cmd ? cmd.playerId : null;
      for (const effect of res.effects) await this.applyEffect(table, effect, playerId);
    });
  }

  setConnected(gameId: string, userId: string, connected: boolean): void {
    const table = this.tables.get(gameId);
    const seat = table ? this.seatOfUser(table, userId) : null;
    if (!table || !seat || seat.connected === connected) return;
    seat.connected = connected;
    this.emitSeats(table);
  }

  pendingSeatRequests(gameId: string): { playerId: string; name: string }[] {
    const table = this.tables.get(gameId);
    return table ? [...table.requests.values()].map((r) => ({ playerId: r.playerId, name: r.name })) : [];
  }

  async results(gameId: string): Promise<ResultEntry[]> {
    const table = this.tables.get(gameId);
    if (table) {
      if (table.results) return table.results;
      if (table.kind === 'cash') return placesByNet(table.nets, table.names);
      return table.controller ? table.controller.results() : [];
    }
    return this.resultsFromDb(gameId);
  }

  onHandEnded(listener: (gameId: string, record: HandRecord) => void): void {
    this.listeners.push(listener);
  }

  /** Stops every timer; the manager does no further timed work. */
  shutdown(): void {
    this.closed = true;
    for (const table of this.tables.values()) {
      for (const h of table.timers) this.deps.clearTimer(h);
      table.timers.clear();
    }
  }

  /** Resolves once the table's work queue is empty (tests and graceful shutdown). */
  async whenIdle(gameId: string): Promise<void> {
    const table = this.tables.get(gameId);
    if (!table) return;
    let q: Promise<void>;
    do {
      q = table.queue;
      await q;
    } while (q !== table.queue);
  }

  viewFor(gameId: string, userId: string): TableView {
    const table = this.tables.get(gameId);
    if (!table) throw err.closed('The table is not open');
    if (!this.mayView(table, userId)) throw err.forbidden();
    const hand = table.hand;
    const me = this.seatOfUser(table, userId);
    const mySeat = me?.seat ?? null;
    const toAct = hand ? toActOf(hand.state) : null;
    const myTurn = hand !== null && toAct !== null && toAct === mySeat;
    const dealtIn = hand !== null && mySeat !== null && hand.playerIds[mySeat] === userId;
    return {
      gameId,
      settings: table.settings,
      status: table.status,
      seats: this.seatViews(table, mySeat),
      board: hand ? [...hand.board] : [],
      pots: hand ? hand.pots : [],
      handId: hand?.handId ?? null,
      handNumber: hand?.handNumber ?? table.lastHandNumber,
      buttonSeat: table.buttonSeat,
      toAct,
      legal: myTurn ? legalActions(hand.state, toAct) : null,
      deadline: hand?.turn?.deadline ?? null,
      mySeat,
      myHole: dealtIn ? (holeCards(hand.state)[mySeat] ?? []) : [],
      commitment: hand ? hand.commitment : (table.pending?.commitment ?? null),
      chat: table.chat,
      seatRequests: userId === table.hostId ? this.pendingSeatRequests(gameId) : [],
    };
  }

  // ------------------------------------------------------------------------------------------------------
  // Loading, access, queue, timers

  private async load(gameId: string): Promise<void> {
    const row = await this.gameRow(gameId);
    if (!LIVE_DB_STATUSES.has(row.status) && row.status !== 'scheduled') throw err.closed('The game is over');
    const settings = GameSettingsSchema.parse(row.settings);
    if (row.status !== 'open') await this.deps.pool.query(`update games set status = 'open' where id = $1`, [gameId]);
    if (settings.kind === 'cash') await this.recoverTableBalances(gameId);
    const last = await this.deps.pool.query<{ n: number }>(
      'select coalesce(max(hand_number), 0)::int as n from hands where game_id = $1',
      [gameId],
    );
    this.tables.set(gameId, this.newTable(row, settings, last.rows[0]?.n ?? 0));
  }

  private newTable(row: GameRow, settings: GameSettings, lastHandNumber: number): Table {
    return {
      gameId: row.id,
      hostId: row.host,
      name: row.name,
      kind: settings.kind,
      settings,
      pendingSettings: null,
      status: 'waiting',
      seats: new Map(),
      members: new Set(),
      allowed: new Set([row.host]),
      requests: new Map(),
      chat: [],
      hand: null,
      lastHandNumber,
      buttonSeat: null,
      pending: null,
      seeding: null,
      sitSeeds: new Map(),
      queue: Promise.resolve(),
      timers: new Set(),
      nextHandTimer: null,
      autoStartTimer: null,
      pauseRequested: false,
      endRequested: false,
      records: [],
      analyseEvery: 1,
      handsSinceAnalysis: 0,
      nets: new Map(),
      names: new Map(),
      controller: null,
      levelNumber: null,
      pausedTotalMs: 0,
      pausedSince: null,
      rebuyWindow: null,
      results: null,
    };
  }

  /** A crash can leave chips in a cash game's table accounts; they go back to the wallets. */
  private async recoverTableBalances(gameId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ user_id: string; total: number }>(
      `select a.user_id, sum(e.amount)::bigint as total
         from ledger_accounts a join ledger_entries e on e.account_id = a.id
        where a.kind = 'table' and a.game_id = $1
        group by a.user_id having sum(e.amount) > 0`,
      [gameId],
    );
    for (const r of rows) await ledger.cashOut(this.deps.pool, r.user_id, gameId, r.total);
  }

  private async gameRow(gameId: string): Promise<GameRow> {
    if (!UUID_RE.test(gameId)) throw err.notFound();
    const { rows } = await this.deps.pool.query<GameRow>('select id, host, name, settings, status from games where id = $1', [gameId]);
    const row = rows[0];
    if (!row) throw err.notFound();
    return row;
  }

  private async hasInvite(gameId: string, userId: string): Promise<boolean> {
    if (!UUID_RE.test(userId)) return false;
    const r = await this.deps.pool.query('select 1 from game_invites where game_id = $1 and user_id = $2', [gameId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The open table for an allowed user, opening it lazily when the game is live (AC1 first). */
  private async tableFor(gameId: string, userId: string): Promise<Table> {
    let table = this.tables.get(gameId);
    if (!table) {
      const row = await this.gameRow(gameId);
      if (row.host !== userId && !(await this.hasInvite(gameId, userId))) throw err.forbidden();
      if (!LIVE_DB_STATUSES.has(row.status)) throw err.closed(row.status === 'scheduled' ? 'The game has not opened yet' : 'The game is over');
      await this.open(gameId);
      table = this.tables.get(gameId);
      if (!table) throw err.closed();
    }
    if (!table.allowed.has(userId)) {
      if (!(await this.hasInvite(gameId, userId))) throw err.forbidden();
      table.allowed.add(userId);
    }
    return table;
  }

  /** An open table, for users already known to it. */
  private requireTable(gameId: string, userId: string): Table {
    const table = this.tables.get(gameId);
    if (!table) throw err.closed('The table is not open');
    if (!this.mayView(table, userId)) throw err.forbidden();
    return table;
  }

  private mayView(table: Table, userId: string): boolean {
    return table.allowed.has(userId) || table.members.has(userId) || this.seatOfUser(table, userId) !== null;
  }

  private seatOfUser(table: Table, userId: string): SeatState | null {
    for (const s of table.seats.values()) if (s.userId === userId) return s;
    return null;
  }

  private enqueue<T>(table: Table, fn: () => T | Promise<T>): Promise<T> {
    const run = table.queue.then(() => fn());
    table.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A timer whose callback runs in the table's queue. */
  private timer(table: Table, ms: number, fn: () => void | Promise<void>): unknown {
    if (this.closed) return null;
    const h: unknown = this.deps.setTimer(() => {
      table.timers.delete(h);
      void this.enqueue(table, fn).catch((e: unknown) => this.log.error(`timer task failed in game ${table.gameId}`, e));
    }, Math.max(0, ms));
    table.timers.add(h);
    return h;
  }

  private cancelTimer(table: Table, h: unknown): void {
    if (h === null || h === undefined) return;
    this.deps.clearTimer(h);
    table.timers.delete(h);
  }

  // ------------------------------------------------------------------------------------------------------
  // Emitting

  private emitRoom(table: Table, event: ServerEventName, payload: object): void {
    this.deps.emitRoom(table.gameId, event, { gameId: table.gameId, ...payload });
  }

  private recipients(table: Table): Set<string> {
    const out = new Set(table.members);
    for (const s of table.seats.values()) out.add(s.userId);
    return out;
  }

  private emitSeats(table: Table): void {
    this.emitRoom(table, 'table:seats', { seats: this.seatViews(table, null) });
  }

  private emitStatus(table: Table): void {
    const msg: { status: TableStatus; level?: unknown; nextLevelAt?: number } = { status: table.status };
    if (table.controller) {
      const now = this.deps.clock();
      msg.level = table.controller.levelFor(now);
      const next = table.controller.nextLevelAt(now);
      if (next !== null) msg.nextLevelAt = next;
    }
    this.emitRoom(table, 'table:status', msg);
  }

  private emitHostView(table: Table): void {
    this.deps.emitTo(table.hostId, 'table:view', this.viewFor(table.gameId, table.hostId));
  }

  private seatViews(table: Table, viewerSeat: SeatIndex | null): SeatView[] {
    const hand = table.hand;
    const holes = hand ? holeCards(hand.state) : {};
    return [...table.seats.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((s) => {
        const live = hand?.live.get(s.seat);
        const own = live !== undefined && s.seat === viewerSeat ? (holes[s.seat] ?? null) : null;
        return {
          seat: s.seat,
          playerId: s.userId,
          name: s.name,
          avatarUrl: s.avatarUrl,
          stack: live?.stack ?? s.stack,
          bet: live?.bet ?? 0,
          folded: live?.folded ?? false,
          allIn: live?.allIn ?? false,
          sittingOut: (hand !== null && live === undefined) || s.away,
          connected: s.connected,
          cardsVisible: own ?? live?.shown ?? null,
          hasCards: live !== undefined && !live.folded,
        };
      });
  }

  // ------------------------------------------------------------------------------------------------------
  // Seating

  private validateSit(table: Table, userId: string, seat: number, buyIn: number): void {
    const s = table.settings;
    if (table.status === 'finished') throw err.closed('The game is over');
    if (!Number.isInteger(seat) || seat < 0 || seat >= s.maxSeats) throw new TableError('seat_taken', 'There is no such seat', 409);
    if (this.seatOfUser(table, userId)) throw new TableError('already_seated', 'You already have a seat', 409);
    if (table.seats.has(seat)) throw new TableError('seat_taken', 'That seat is taken', 409);
    if (!Number.isSafeInteger(buyIn)) throw new TableError('bad_buy_in', 'The buy-in must be a whole number of chips');
    if (s.kind === 'cash') {
      if (buyIn < s.minBuyIn || buyIn > s.maxBuyIn) {
        throw new TableError('bad_buy_in', `The buy-in must be between ${s.minBuyIn} and ${s.maxBuyIn}`);
      }
      return;
    }
    if (table.status !== 'waiting') throw err.badState('The tournament has started');
    if (buyIn !== s.startingStack) throw new TableError('bad_buy_in', `The buy-in is ${s.startingStack}`);
  }

  private async checkWallet(userId: string, buyIn: number): Promise<void> {
    if ((await ledger.walletBalance(this.deps.pool, userId)) < buyIn) {
      throw new TableError('not_enough_chips', 'Not enough chips in your wallet', 409);
    }
  }

  private async loadUser(userId: string): Promise<{ name: string; avatarUrl: string }> {
    const { rows } = await this.deps.pool.query<{ id: string; display_name: string; avatar_path: string | null }>(
      'select id, display_name, avatar_path from users where id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row) throw err.forbidden();
    return { name: row.display_name, avatarUrl: avatarUrlFor(row) };
  }

  private async queueSeatRequest(table: Table, request: SeatRequest): Promise<void> {
    table.requests.set(request.playerId, request);
    await notify(this.deps.pool, table.hostId, 'seatRequest', `${request.name} asks to sit at ${table.name}`, `/table/${table.gameId}`);
    await this.refreshChat(table);
    this.emitHostView(table);
  }

  private async seatPlayer(table: Table, r: SeatRequest): Promise<void> {
    try {
      await ledger.buyIn(this.deps.pool, r.playerId, table.gameId, r.buyIn);
    } catch (e) {
      if (e instanceof ledger.InsufficientFundsError) throw new TableError('not_enough_chips', 'Not enough chips in your wallet', 409);
      throw e;
    }
    table.seats.set(r.seat, {
      seat: r.seat,
      userId: r.playerId,
      name: r.name,
      avatarUrl: r.avatarUrl,
      stack: r.buyIn,
      timeBankMs: table.settings.timeBankSeconds * 1000,
      connected: true,
      leaving: false,
      away: false,
    });
    table.names.set(r.playerId, r.name);
    table.members.add(r.playerId);
    this.registerSitSeed(table, r.playerId, r.clientSeed);
    this.emitSeats(table);
    await this.checkSharedNetwork(table);
    this.checkAutoStart(table);
    this.maybeStartHand(table);
  }

  /** A seed sent at sit time counts for a hand whose commitment already exists (never for a later one). */
  private registerSitSeed(table: Table, userId: string, seed: string): void {
    const pending = table.pending;
    if (!pending || !seed) return;
    if (table.seeding?.handNumber === pending.handNumber) {
      if (!table.seeding.seeds.has(userId)) table.seeding.seeds.set(userId, seed);
      return;
    }
    table.sitSeeds.set(userId, { handNumber: pending.handNumber, seed });
  }

  private async approveRequest(table: Table, playerId: string, approve: boolean): Promise<void> {
    const r = table.requests.get(playerId);
    if (!r) throw err.badState('There is no seat request from that player');
    table.requests.delete(playerId);
    if (approve) {
      try {
        this.validateSit(table, r.playerId, r.seat, r.buyIn);
        await this.checkWallet(r.playerId, r.buyIn);
        await this.seatPlayer(table, r);
      } catch (e) {
        if (!(e instanceof TableError)) throw e;
        this.deps.emitTo(r.playerId, 'error', { code: e.code, message: e.message });
      }
    }
    this.emitHostView(table);
  }

  /** Leave or kick: a cash player is cashed out now or after the current hand; a tournament player goes away. */
  private async removeFromPlay(table: Table, seat: SeatState): Promise<void> {
    const inHand = table.hand?.playerIds[seat.seat] === seat.userId;
    if (table.kind === 'tournament' && table.status !== 'waiting') {
      seat.away = true;
    } else if (inHand) {
      seat.leaving = true;
    } else {
      await this.unseat(table, seat, true);
      this.emitSeats(table);
      return;
    }
    this.emitSeats(table);
    const hand = table.hand;
    if (hand && inHand && toActOf(hand.state) === seat.seat) {
      this.applyPlayerAction(table, hand, timeoutAction(hand.state, seat.seat), true);
      await this.advanceHand(table);
    }
  }

  private async unseat(table: Table, seat: SeatState, refund: boolean): Promise<void> {
    table.seats.delete(seat.seat);
    table.sitSeeds.delete(seat.userId);
    if (refund && seat.stack > 0) {
      try {
        await ledger.cashOut(this.deps.pool, seat.userId, table.gameId, seat.stack);
      } catch (e) {
        this.log.error(`cash-out failed in game ${table.gameId}`, e);
      }
    }
    this.checkAutoStart(table);
  }

  private async checkSharedNetwork(table: Table): Promise<void> {
    const ids = [...table.seats.values()].map((s) => s.userId);
    if (ids.length < 2) return;
    try {
      const { rows } = await this.deps.pool.query<{ user_id: string; ip: string; device_id: string }>(
        `select distinct on (user_id) user_id, ip, device_id from sessions
          where user_id = any($1::uuid[]) order by user_id, created_at desc`,
        [ids],
      );
      await this.storeFlags(table, sharedNetwork(rows.map((r) => ({ playerId: r.user_id, ip: r.ip, deviceId: r.device_id }))));
    } catch (e) {
      this.log.error(`shared-network check failed in game ${table.gameId}`, e);
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Status and host commands

  private async applyEffect(table: Table, effect: HostEffect, playerId: string | null): Promise<void> {
    switch (effect) {
      case 'start':
        if (table.status !== 'waiting') throw err.badState('The game has already started');
        if (table.seats.size < 2) throw err.badState('At least two players must be seated');
        await this.start(table);
        return;
      case 'pause':
        if (table.status !== 'running') return;
        if (this.busy(table)) table.pauseRequested = true;
        else await this.pauseNow(table);
        return;
      case 'resume':
        table.pauseRequested = false;
        if (table.status !== 'paused') return;
        await this.setStatus(table, 'running');
        this.maybeStartHand(table);
        return;
      case 'end':
        if (this.busy(table)) table.endRequested = true;
        else await this.finishGame(table);
        return;
      case 'kick': {
        const seat = playerId ? this.seatOfUser(table, playerId) : null;
        if (seat) await this.removeFromPlay(table, seat);
        else if (!(playerId && table.requests.delete(playerId))) throw err.notSeated();
        return;
      }
      case 'approve':
      case 'reject':
        if (!playerId) throw err.badState('No player given');
        await this.approveRequest(table, playerId, effect === 'approve');
        return;
    }
  }

  /** AC15: a change during a hand waits for the next hand; with no hand in progress it applies at once. */
  private async updateSettings(table: Table, settings: GameSettings): Promise<void> {
    const parsed = GameSettingsSchema.safeParse(settings);
    if (!parsed.success) throw err.badState(parsed.error.issues.map((i) => i.message).join('; '));
    await this.deps.pool.query('update games set settings = $2 where id = $1', [table.gameId, JSON.stringify(parsed.data)]);
    if (this.handInProgress(table)) {
      table.pendingSettings = parsed.data;
    } else {
      this.applySettings(table, parsed.data);
    }
  }

  /** The single place where settings take effect. */
  private applySettings(table: Table, settings: GameSettings): void {
    table.settings = settings;
    table.pendingSettings = null;
    this.checkAutoStart(table);
  }

  /** From the start of a hand's seed collection until it is stored (rebuy window included). */
  private handInProgress(table: Table): boolean {
    return table.seeding !== null || this.busy(table);
  }

  private busy(table: Table): boolean {
    return table.hand !== null || table.rebuyWindow !== null;
  }

  private checkAutoStart(table: Table): void {
    const wanted = table.status === 'waiting' && table.kind === 'cash' && table.settings.autoStart && table.seats.size >= 2;
    if (!wanted) {
      this.cancelTimer(table, table.autoStartTimer);
      table.autoStartTimer = null;
      return;
    }
    if (table.autoStartTimer !== null) return;
    table.autoStartTimer = this.timer(table, this.autoStartMs, async () => {
      table.autoStartTimer = null;
      if (table.status === 'waiting' && table.seats.size >= 2) await this.start(table);
    });
  }

  private async start(table: Table): Promise<void> {
    this.cancelTimer(table, table.autoStartTimer);
    table.autoStartTimer = null;
    if (table.kind === 'tournament' && !table.controller) {
      table.controller = this.tournamentFactory({
        pool: this.deps.pool,
        gameId: table.gameId,
        settings: table.pendingSettings ?? table.settings,
        startedAtMs: this.deps.clock(),
        pausedMs: () => table.pausedTotalMs + (table.pausedSince === null ? 0 : this.deps.clock() - table.pausedSince),
      });
    }
    await this.setStatus(table, 'running');
    this.maybeStartHand(table);
  }

  private async pauseNow(table: Table): Promise<void> {
    table.pauseRequested = false;
    this.stopBetweenHands(table);
    await this.setStatus(table, 'paused');
  }

  /** Cancels the next-hand timer and an unfinished seed collection (the pending seed is kept). */
  private stopBetweenHands(table: Table): void {
    this.cancelTimer(table, table.nextHandTimer);
    table.nextHandTimer = null;
    if (table.seeding) this.cancelTimer(table, table.seeding.timer);
    table.seeding = null;
    // The cancelled hand never started, so changes held for it apply now.
    if (table.pendingSettings && !this.busy(table)) this.applySettings(table, table.pendingSettings);
  }

  private async setStatus(table: Table, status: TableStatus): Promise<void> {
    const now = this.deps.clock();
    if (status === 'paused' && table.pausedSince === null) table.pausedSince = now;
    if (status !== 'paused' && table.pausedSince !== null) {
      table.pausedTotalMs += now - table.pausedSince;
      table.pausedSince = null;
    }
    table.status = status;
    await this.deps.pool.query('update games set status = $2 where id = $1', [table.gameId, toDbStatus(status)]);
    this.emitStatus(table);
  }

  private async finishGame(table: Table): Promise<void> {
    table.endRequested = false;
    this.stopBetweenHands(table);
    this.cancelTimer(table, table.autoStartTimer);
    table.autoStartTimer = null;
    let results: ResultEntry[];
    if (table.kind === 'cash') {
      results = placesByNet(table.nets, table.names);
      for (const seat of [...table.seats.values()]) await this.unseat(table, seat, true);
    } else if (table.controller) {
      results = await table.controller.results();
      // The controller swept the table accounts into the prize pool, so the remaining stacks are gone.
      for (const seat of [...table.seats.values()]) await this.unseat(table, seat, false);
    } else {
      // A tournament ended before it started: the buy-ins go back.
      results = [];
      for (const seat of [...table.seats.values()]) await this.unseat(table, seat, true);
    }
    table.results = results;
    table.requests.clear();
    await this.setStatus(table, 'finished');
    this.emitRoom(table, 'table:results', { results });
    this.emitSeats(table);
  }

  // ------------------------------------------------------------------------------------------------------
  // Hand loop: seeds and dealing

  private playersToDeal(table: Table): SeatState[] {
    return [...table.seats.values()].filter((s) => s.stack > 0 && s.seat < table.settings.maxSeats).sort((a, b) => a.seat - b.seat);
  }

  private pendingSeed(table: Table): PendingSeed {
    if (!table.pending) {
      const serverSeed = newServerSeed();
      table.pending = { handNumber: table.lastHandNumber + 1, serverSeed, saltKey: newServerSeed(), commitment: commit(serverSeed) };
    }
    return table.pending;
  }

  /** Step 1-2 of the hand loop: announce the commitment and collect client seeds. */
  private maybeStartHand(table: Table): void {
    if (this.closed || table.status !== 'running' || this.busy(table) || table.seeding || table.nextHandTimer !== null) return;
    const players = this.playersToDeal(table);
    if (players.length < 2) return;
    const pending = this.pendingSeed(table);
    const seeding: Seeding = {
      handNumber: pending.handNumber,
      expected: new Set(players.filter((p) => p.connected && !p.away).map((p) => p.userId)),
      seeds: new Map(),
      timer: null,
    };
    for (const [userId, s] of table.sitSeeds) if (s.handNumber === pending.handNumber) seeding.seeds.set(userId, s.seed);
    table.sitSeeds.clear();
    table.seeding = seeding;
    seeding.timer = this.timer(table, this.seedWaitMs, () => this.dealIfSeeding(table, seeding));
    this.emitRoom(table, 'hand:commitment', { handNumber: pending.handNumber, commitment: pending.commitment });
    if (table.seeding === seeding && [...seeding.expected].every((u) => seeding.seeds.has(u))) {
      this.cancelTimer(table, seeding.timer);
      void this.enqueue(table, () => this.dealIfSeeding(table, seeding)).catch((e: unknown) => this.log.error('deal failed', e));
    }
  }

  private async dealIfSeeding(table: Table, seeding: Seeding): Promise<void> {
    if (table.seeding !== seeding) return;
    this.cancelTimer(table, seeding.timer);
    table.seeding = null;
    if (table.status !== 'running' || this.busy(table)) return;
    await this.dealHand(table, seeding);
  }

  /** Step 3-4: shuffle, move the button, start the hand. */
  private async dealHand(table: Table, seeding: Seeding): Promise<void> {
    // AC15: settings changed during the previous hand take effect here, at the start of the next hand.
    if (table.pendingSettings) this.applySettings(table, table.pendingSettings);
    const players = this.playersToDeal(table);
    if (players.length < 2) return;
    const pending = this.pendingSeed(table);
    const { maxSeats } = table.settings;
    const stakes = this.stakesForHand(table);
    const button = nextButton(table.buttonSeat, players.map((p) => p.seat), maxSeats);
    const clientSeeds = players.flatMap((p) => seeding.seeds.get(p.userId) ?? []).sort();
    const deck = deckFromSeeds(pending.serverSeed, clientSeeds, pending.handNumber);
    const handId = randomUUID();
    const { state, events } = startHand({
      handId,
      handNumber: pending.handNumber,
      maxSeats,
      buttonSeat: button,
      stakes,
      seats: players.map((p) => ({ seat: p.seat, playerId: p.userId, stack: p.stack })),
      deck,
    });
    table.pending = null;
    table.buttonSeat = button;
    table.lastHandNumber = pending.handNumber;
    const positions = dealPositions(players.length);
    const order = dealOrder(players.map((p) => p.seat), button, maxSeats);
    const hand: LiveHand = {
      handId,
      handNumber: pending.handNumber,
      state,
      bigBlind: stakes.bigBlind,
      startedAt: this.deps.clock(),
      serverSeed: pending.serverSeed,
      saltKey: pending.saltKey,
      commitment: pending.commitment,
      clientSeeds,
      deck,
      holePositions: new Map(order.map((seat, k) => [seat, positions.hole[k] ?? []])),
      boardPositions: positions.board,
      playerIds: Object.fromEntries(players.map((p) => [p.seat, p.userId])),
      startStacks: new Map(players.map((p) => [p.seat, p.stack])),
      live: new Map(),
      board: [],
      pots: [],
      events: [],
      turn: null,
      runout: false,
      proofsShown: new Set(),
    };
    table.hand = hand;
    this.emitHandEvents(table, hand, events);
    await this.advanceHand(table);
  }

  private stakesForHand(table: Table): Stakes {
    if (table.kind === 'cash' || !table.controller) {
      const level = table.settings.levels[0];
      if (!level) throw new Error('settings have no blind level');
      return stakesOf(level);
    }
    const level = table.controller.levelFor(this.deps.clock());
    if (table.levelNumber !== null && level.level !== table.levelNumber) {
      this.topUpTimeBanks(table);
      table.levelNumber = level.level;
      this.emitStatus(table);
    }
    table.levelNumber = level.level;
    return stakesOf(level);
  }

  private topUpTimeBanks(table: Table): void {
    const cap = table.settings.timeBankSeconds * 1000;
    const add = table.settings.timeBankTopUpSeconds * 1000;
    for (const s of table.seats.values()) s.timeBankMs = Math.min(cap, s.timeBankMs + add);
  }

  // ------------------------------------------------------------------------------------------------------
  // Hand loop: events

  /** Fills the server fields, records, tracks the public state, sends redacted views and card proofs. */
  private emitHandEvents(table: Table, hand: LiveHand, events: HandEvent[]): void {
    const to = this.recipients(table);
    for (const raw of events) {
      const event = this.fillEvent(table, hand, raw);
      hand.events.push(event);
      this.trackLive(hand, event);
      for (const userId of to) {
        const viewer = this.seatOfUser(table, userId)?.seat ?? null;
        this.deps.emitTo(userId, 'hand:event', { gameId: table.gameId, event: redact(event, viewer) });
      }
      this.sendProofs(table, hand, event, to);
    }
  }

  private fillEvent(table: Table, hand: LiveHand, event: HandEvent): HandEvent {
    switch (event.type) {
      case 'handStarted':
        return { ...event, commitment: hand.commitment, cardCommitments: cardCommitments(hand.deck, hand.saltKey) };
      case 'toAct': {
        const deadline = this.deps.clock() + table.settings.turnSeconds * 1000;
        hand.turn = { seat: event.seat, deadline, usingTimeBank: false, bankStartedAt: 0, token: ++this.turnTokens, timer: null };
        return { ...event, deadline };
      }
      case 'handEnded':
        return { ...event, clientSeeds: [...hand.clientSeeds], nextCommitment: this.pendingSeed(table).commitment };
      default:
        return event;
    }
  }

  private trackLive(hand: LiveHand, e: HandEvent): void {
    const seat = (s: SeatIndex): LiveSeat => {
      const live = hand.live.get(s);
      if (!live) throw new Error(`seat ${s} is not in the hand`);
      return live;
    };
    switch (e.type) {
      case 'handStarted':
        for (const s of e.seats) hand.live.set(s.seat, { stack: s.stack, bet: 0, folded: false, allIn: false, shown: null });
        return;
      case 'postAnte':
      case 'postBlind': {
        const p = seat(e.seat);
        p.stack -= e.amount;
        if (e.type === 'postBlind') p.bet += e.amount;
        p.allIn = p.stack === 0;
        return;
      }
      case 'action': {
        const p = seat(e.seat);
        p.bet = e.amount;
        p.stack = e.stackAfter;
        p.folded = e.kind === 'fold';
        p.allIn = !p.folded && e.stackAfter === 0;
        return;
      }
      case 'uncalledReturned': {
        const p = seat(e.seat);
        p.stack += e.amount;
        p.bet -= e.amount;
        p.allIn = p.stack === 0;
        return;
      }
      case 'potsFormed':
        hand.pots = e.pots;
        for (const p of hand.live.values()) p.bet = 0;
        return;
      case 'street':
        hand.board.push(...e.cards);
        for (const p of hand.live.values()) p.bet = 0;
        return;
      case 'showCards':
        seat(e.seat).shown = [...e.cards];
        return;
      case 'potAwarded':
        e.seats.forEach((s, i) => (seat(s).stack += e.amounts[i] ?? 0));
        return;
      case 'handEnded':
        for (const s of e.stacks) seat(s.seat).stack = s.stack;
        return;
      default:
        return;
    }
  }

  /** cardProof: own hole cards to the owner, board cards and shown hands to everyone; never folded cards or burns. */
  private sendProofs(table: Table, hand: LiveHand, event: HandEvent, everyone: Set<string>): void {
    const send = (users: Iterable<string>, position: number): void => {
      const card = hand.deck[position];
      if (card === undefined) return;
      const proof: HandEvent = { type: 'cardProof', position, card, salt: cardSalt(hand.saltKey, position) };
      for (const userId of users) this.deps.emitTo(userId, 'hand:event', { gameId: table.gameId, event: proof });
    };
    if (event.type === 'dealHole') {
      const owner = hand.playerIds[event.seat];
      if (owner) for (const p of hand.holePositions.get(event.seat) ?? []) send([owner], p);
    } else if (event.type === 'street') {
      const first = hand.board.length - event.cards.length;
      event.cards.forEach((_, i) => {
        const p = hand.boardPositions[first + i];
        if (p !== undefined) send(everyone, p);
      });
    } else if (event.type === 'showCards' && !hand.proofsShown.has(event.seat)) {
      hand.proofsShown.add(event.seat);
      for (const p of hand.holePositions.get(event.seat) ?? []) send(everyone, p);
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Hand loop: turns, timers, runout

  private applyPlayerAction(table: Table, hand: LiveHand, action: PlayerAction, auto: boolean): void {
    const { state, events } = applyAction(hand.state, action);
    hand.state = state;
    this.clearTurn(table, hand);
    const marked = auto ? events.map((e): HandEvent => (e.type === 'action' ? { ...e, auto: 'timeout' } : e)) : events;
    this.emitHandEvents(table, hand, marked);
  }

  private clearTurn(table: Table, hand: LiveHand): void {
    if (hand.turn) this.cancelTimer(table, hand.turn.timer);
    hand.turn = null;
  }

  /** Moves the hand on after its events went out: next turn, auto-acts, runout or the end. */
  private async advanceHand(table: Table): Promise<void> {
    for (;;) {
      const hand = table.hand;
      if (!hand) return;
      if (isComplete(hand.state)) return this.finishHand(table, hand);
      if (allInRunout(hand.state)) return this.continueRunout(table, hand);
      const seatIndex = toActOf(hand.state);
      if (seatIndex === null) return;
      const seat = table.seats.get(seatIndex);
      if (seat && (seat.leaving || seat.away)) {
        this.applyPlayerAction(table, hand, timeoutAction(hand.state, seatIndex), true);
        continue;
      }
      this.startTurnClock(table, hand);
      return;
    }
  }

  private emitClock(table: Table, turn: Turn, timeBankMs: number): void {
    this.emitRoom(table, 'table:clock', { seat: turn.seat, deadline: turn.deadline, timeBankMs, usingTimeBank: turn.usingTimeBank });
  }

  private startTurnClock(table: Table, hand: LiveHand): void {
    const turn = hand.turn;
    if (!turn) return;
    this.emitClock(table, turn, table.seats.get(turn.seat)?.timeBankMs ?? 0);
    turn.timer = this.timer(table, turn.deadline - this.deps.clock(), () => this.onTurnExpired(table, hand.handId, turn.token));
  }

  private switchToTimeBank(table: Table, hand: LiveHand, turn: Turn, seat: SeatState): void {
    const now = this.deps.clock();
    this.cancelTimer(table, turn.timer);
    turn.usingTimeBank = true;
    turn.bankStartedAt = now;
    turn.deadline = now + seat.timeBankMs;
    this.emitClock(table, turn, seat.timeBankMs);
    turn.timer = this.timer(table, seat.timeBankMs, () => this.onTurnExpired(table, hand.handId, turn.token));
  }

  private async onTurnExpired(table: Table, handId: string, token: number): Promise<void> {
    const hand = table.hand;
    const turn = hand?.turn;
    if (!hand || hand.handId !== handId || !turn || turn.token !== token) return;
    const seat = table.seats.get(turn.seat);
    if (!seat) return this.actOnTimeout(table, hand, turn.seat, null);
    if (turn.usingTimeBank) return this.actOnTimeout(table, hand, turn.seat, seat);
    if (seat.timeBankMs > 0) {
      this.switchToTimeBank(table, hand, turn, seat);
    } else {
      await this.actOnTimeout(table, hand, turn.seat, seat);
    }
  }

  private async actOnTimeout(table: Table, hand: LiveHand, seatIndex: SeatIndex, seat: SeatState | null): Promise<void> {
    if (seat) seat.timeBankMs = 0;
    this.applyPlayerAction(table, hand, timeoutAction(hand.state, seatIndex), true);
    await this.advanceHand(table);
  }

  /** All-in runout: show the hands once, then per street an equity event and a paced deal. */
  private continueRunout(table: Table, hand: LiveHand): void {
    const holes = holeCards(hand.state);
    const board = boardOf(hand.state);
    const remaining = [...hand.live.entries()].filter(([, l]) => !l.folded).map(([s]) => s);
    if (!hand.runout) {
      hand.runout = true;
      this.emitHandEvents(
        table,
        hand,
        remaining.map((seat) => {
          const cards = holes[seat] ?? [];
          return { type: 'showCards', seat, cards, handName: board.length >= 3 ? evaluate7([...cards, ...board]).name : '' };
        }),
      );
    }
    if (table.settings.showAllInEquity) {
      const eq = equityExact(remaining.map((s) => holes[s] ?? []), board);
      const equities = remaining.map((seat, i) => ({ seat, win: eq[i]?.win ?? 0, tie: eq[i]?.tie ?? 0 }));
      this.emitHandEvents(table, hand, [{ type: 'equity', street: streetAfter(board.length), equities }]);
    }
    this.timer(table, this.runoutPacingMs, () => this.runoutStep(table, hand.handId));
  }

  private async runoutStep(table: Table, handId: string): Promise<void> {
    const hand = table.hand;
    if (!hand || hand.handId !== handId || !allInRunout(hand.state)) return;
    const { state, events } = advance(hand.state);
    hand.state = state;
    this.emitHandEvents(table, hand, events);
    await this.advanceHand(table);
  }

  // ------------------------------------------------------------------------------------------------------
  // Hand end

  private async finishHand(table: Table, hand: LiveHand): Promise<void> {
    this.clearTurn(table, hand);
    table.hand = null;
    const nets: { userId: string; seat: SeatIndex; net: number }[] = [];
    for (const [seatIndex, start] of hand.startStacks) {
      const userId = hand.playerIds[seatIndex] ?? '';
      const end = hand.live.get(seatIndex)?.stack ?? start;
      const seat = table.seats.get(seatIndex);
      if (seat && seat.userId === userId) seat.stack = end;
      nets.push({ userId, seat: seatIndex, net: end - start });
      table.nets.set(userId, (table.nets.get(userId) ?? 0) + end - start);
    }
    const record: HandRecord = {
      handId: hand.handId,
      gameId: table.gameId,
      handNumber: hand.handNumber,
      startedAt: new Date(hand.startedAt).toISOString(),
      endedAt: new Date(this.deps.clock()).toISOString(),
      events: hand.events,
      hole: holeCards(hand.state),
      playerIds: hand.playerIds,
      board: boardOf(hand.state),
    };
    table.records.push(record);
    await this.persistHand(table, hand, record, nets);
    for (const listener of this.listeners) {
      try {
        listener(table.gameId, record);
      } catch (e) {
        this.log.error('hand listener failed', e);
      }
    }
    await this.runIntegrity(table, hand.bigBlind);
    if (table.kind === 'cash') {
      if (hand.handNumber % TOP_UP_EVERY_HANDS === 0) this.topUpTimeBanks(table);
      for (const seat of [...table.seats.values()]) if (seat.leaving || seat.stack === 0) await this.unseat(table, seat, true);
    } else if (this.openRebuyWindow(table, hand)) {
      this.emitSeats(table);
      return;
    } else {
      await this.settleTournamentHand(table, this.tournamentStacks(hand));
    }
    await this.afterHand(table);
  }

  /** One transaction: the hand, its players' nets, its seeds, and the chips moved between table accounts. */
  private async persistHand(table: Table, hand: LiveHand, record: HandRecord, nets: { userId: string; seat: SeatIndex; net: number }[]): Promise<void> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        'insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, $4, $5, $6)',
        [hand.handId, table.gameId, hand.handNumber, JSON.stringify(record), record.startedAt, record.endedAt],
      );
      for (const n of nets) {
        await client.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, $3, $4)', [hand.handId, n.userId, n.seat, n.net]);
      }
      await client.query('insert into hand_seeds (hand_id, server_seed, salt_key) values ($1, $2, $3)', [hand.handId, hand.serverSeed, hand.saltKey]);
      const accounts = new Map<string, string>();
      for (const n of nets) accounts.set(n.userId, await ledger.ensureAccount(client, 'table', n.userId, table.gameId));
      await client.query('select id from ledger_accounts where id = any($1::uuid[]) order by id for update', [[...accounts.values()]]);
      const { transfers } = settle(nets.map((n) => ({ playerId: n.userId, chips: n.net })));
      for (const t of transfers) {
        const from = accounts.get(t.from);
        const to = accounts.get(t.to);
        if (!from || !to) throw new Error('missing table account');
        await ledger.transfer(client, from, to, t.chips, `hand ${hand.handNumber}`);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      this.log.error(`failed to store hand ${hand.handNumber} of game ${table.gameId}`, e);
    } finally {
      client.release();
    }
  }

  private async runIntegrity(table: Table, bigBlind: number): Promise<void> {
    table.handsSinceAnalysis += 1;
    if (table.handsSinceAnalysis < table.analyseEvery) return;
    table.handsSinceAnalysis = 0;
    const t0 = performance.now();
    let flags: IntegrityFlag[];
    try {
      flags = analyse(table.records, bigBlind);
    } catch (e) {
      this.log.error(`integrity analysis failed in game ${table.gameId}`, e);
      return;
    }
    const ms = performance.now() - t0;
    this.log.info(`integrity analysis of ${table.records.length} hands in game ${table.gameId} took ${ms.toFixed(1)} ms`);
    if (ms > ANALYSE_SLOW_MS) table.analyseEvery = ANALYSE_SLOW_EVERY;
    await this.storeFlags(table, flags);
  }

  /** Upserts flags; the host is notified about the ones that are new. */
  private async storeFlags(table: Table, flags: IntegrityFlag[]): Promise<void> {
    for (const f of mergeFlags(flags)) {
      try {
        const { rows } = await this.deps.pool.query<{ inserted: boolean }>(
          `insert into integrity_flags (game_id, kind, players, score, evidence, summary)
           values ($1, $2, $3::uuid[], $4, $5::uuid[], $6)
           on conflict (game_id, kind, players) do update
             set score = greatest(integrity_flags.score, excluded.score), evidence = excluded.evidence, summary = excluded.summary
           returning (xmax = 0) as inserted`,
          [table.gameId, f.kind, f.players, f.score, f.evidenceHandIds, f.summary],
        );
        if (rows[0]?.inserted) {
          await notify(this.deps.pool, table.hostId, 'integrityFlag', `Integrity flag (${f.kind}) in ${table.name}: ${f.summary}`, `/games/${table.gameId}`);
        }
      } catch (e) {
        this.log.error(`storing an integrity flag failed in game ${table.gameId}`, e);
      }
    }
  }

  private tournamentStacks(hand: LiveHand): { userId: string; startStack: number }[] {
    return [...hand.startStacks].map(([seat, startStack]) => ({ userId: hand.playerIds[seat] ?? '', startStack }));
  }

  /** Tournament: busted players who may rebuy get rebuyWaitMs. Returns true when a window was opened. */
  private openRebuyWindow(table: Table, hand: LiveHand): boolean {
    const controller = table.controller;
    if (!controller) return false;
    const now = this.deps.clock();
    const users = [...table.seats.values()].filter((s) => s.stack === 0 && controller.canRebuy(s.userId, now)).map((s) => s.userId);
    if (users.length === 0) return false;
    const window: RebuyWindow = { users: new Set(users), timer: null, stacks: this.tournamentStacks(hand) };
    window.timer = this.timer(table, this.rebuyWaitMs, () => this.closeRebuyWindow(table, window));
    table.rebuyWindow = window;
    return true;
  }

  private async closeRebuyWindow(table: Table, window: RebuyWindow): Promise<void> {
    if (table.rebuyWindow !== window) return;
    this.cancelTimer(table, window.timer);
    table.rebuyWindow = null;
    await this.settleTournamentHand(table, window.stacks);
    await this.afterHand(table);
  }

  private async settleTournamentHand(table: Table, stacks: { userId: string; startStack: number }[]): Promise<void> {
    const controller = table.controller;
    if (!controller) return;
    const final = stacks.map((s) => ({ ...s, endStack: this.seatOfUser(table, s.userId)?.stack ?? 0 }));
    const res = await controller.onHandEnded(final, this.deps.clock());
    for (const e of res.eliminated) {
      const seat = this.seatOfUser(table, e.userId);
      if (seat) await this.unseat(table, seat, false);
    }
    if (res.finished) table.endRequested = true;
  }

  private async afterHand(table: Table): Promise<void> {
    this.emitSeats(table);
    if (table.endRequested) return this.finishGame(table);
    if (table.pauseRequested) return this.pauseNow(table);
    if (table.status !== 'running') return;
    table.nextHandTimer = this.timer(table, this.handDelayMs, () => {
      table.nextHandTimer = null;
      this.maybeStartHand(table);
    });
  }

  // ------------------------------------------------------------------------------------------------------
  // Chat and results from the database

  private async refreshChat(table: Table): Promise<void> {
    const { rows } = await this.deps.pool.query<{ id: number; user_id: string; display_name: string; text: string; created_at: Date }>(
      `select c.id, c.user_id, u.display_name, c.text, c.created_at
         from chat_messages c join users u on u.id = c.user_id
        where c.game_id = $1 order by c.id desc limit ${CHAT_LIMIT}`,
      [table.gameId],
    );
    table.chat = rows.reverse().map((r) => ({
      gameId: table.gameId,
      id: String(r.id),
      playerId: r.user_id,
      name: r.display_name,
      text: r.text,
      at: r.created_at.getTime(),
    }));
  }

  private async resultsFromDb(gameId: string): Promise<ResultEntry[]> {
    const row = await this.gameRow(gameId);
    const settings = GameSettingsSchema.parse(row.settings);
    if (settings.kind === 'tournament') {
      const { rows } = await this.deps.pool.query<{ user_id: string; display_name: string; place: number; prize: number }>(
        `select t.user_id, u.display_name, t.place, t.prize from tournament_results t join users u on u.id = t.user_id
          where t.game_id = $1 order by t.place, u.display_name`,
        [gameId],
      );
      return rows.map((r) => ({ userId: r.user_id, name: r.display_name, place: r.place, prize: r.prize }));
    }
    const { rows } = await this.deps.pool.query<{ user_id: string; display_name: string; net: number }>(
      `select p.user_id, u.display_name, sum(p.net)::bigint as net
         from hand_players p join hands h on h.id = p.hand_id join users u on u.id = p.user_id
        where h.game_id = $1 group by p.user_id, u.display_name`,
      [gameId],
    );
    return placesByNet(new Map(rows.map((r) => [r.user_id, r.net])), new Map(rows.map((r) => [r.user_id, r.display_name])));
  }
}
