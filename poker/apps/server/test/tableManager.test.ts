import {
  cardCommitments,
  commit,
  dealPositions,
  deckFromSeeds,
  mulberry32,
  newClientSeed,
  verifyCard,
  verifyDeck,
  type ActionKind,
  type BlindLevel,
  type HandEvent,
  type HandRecord,
  type LegalActions,
  type SeatIndex,
} from '@poker/engine';
import type {
  GameSettings,
  HandCommitment,
  HandEventMessage,
  ResultEntry,
  ServerEventName,
  TableClock,
  TableResults,
  TableStatusMessage,
  TableView,
} from '@poker/protocol';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TournamentControllerLike } from '../src/games/tournament.js';
import type { GameStatus, HostEffect } from '../src/realtime/hostControls.js';
import {
  redact,
  TableManager,
  type TableHostCommand,
  type TableManagerDeps,
  type TournamentFactoryArgs,
} from '../src/realtime/tableManager.js';
import { fakeClock, makeUser, testDb } from '../src/test/helpers.js';
import { balance, buyIn, ensureAccount, grant, walletBalance } from '../src/wallet/ledger.js';

// A simple, faithful fake of S17's applyHostCommand (the real one lands in checkpoint 6).
vi.mock('../src/realtime/hostControls.js', () => ({
  applyHostCommand: (
    settings: GameSettings,
    status: GameStatus,
    cmd: TableHostCommand,
    actor: string,
    hostId: string,
  ): { settings: GameSettings; status: GameStatus; effects: HostEffect[] } | { error: string } => {
    if (actor !== hostId) return { error: 'Only the host can do that' };
    switch (cmd.kind) {
      case 'start':
        return status === 'open' ? { settings, status: 'running', effects: ['start'] } : { error: 'The game is not open' };
      case 'pause':
        return { settings, status: 'paused', effects: ['pause'] };
      case 'resume':
        return { settings, status: 'running', effects: ['resume'] };
      case 'end':
        return { settings, status: 'finished', effects: ['end'] };
      case 'kick':
        return { settings, status, effects: ['kick'] };
      case 'approveSeat':
        return { settings, status, effects: [cmd.approve ? 'approve' : 'reject'] };
      case 'updateSettings':
        return { settings: { ...settings, ...cmd.settings } as GameSettings, status, effects: [] };
    }
  },
}));

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
const hostOf = new Map<string, string>();
const managers: TableManager[] = [];

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
});

afterAll(async () => {
  for (const m of managers) m.shutdown();
  await db.cleanup();
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures

type User = Awaited<ReturnType<typeof makeUser>>;

const LEVEL_1: BlindLevel = { level: 1, smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none', durationMinutes: 60 };
const LEVEL_2: BlindLevel = { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, anteKind: 'none', durationMinutes: 60 };

/** Stored without turnSeconds / timeBankTopUpSeconds so the manager must apply the schema defaults. */
function cashSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'cash',
    maxSeats: 6,
    levels: [LEVEL_1],
    minBuyIn: 100,
    maxBuyIn: 1000,
    startingStack: 0,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    autoStart: false,
    showAllInEquity: true,
    timeBankSeconds: 0,
    ...overrides,
  };
}

function tournamentSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return cashSettings({ kind: 'tournament', levels: [LEVEL_1, LEVEL_2], minBuyIn: 0, maxBuyIn: 0, startingStack: 1000, rebuys: { allowed: true, untilLevel: 1 }, ...overrides });
}

async function makeGame(host: User, settings: Record<string, unknown>, invitees: User[], status: GameStatus = 'open'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, 'Test table', $2, now(), $3) returning id`,
    [host.id, JSON.stringify(settings), status],
  );
  const id = rows[0]!.id;
  for (const u of invitees) await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [id, u.id]);
  hostOf.set(id, host.id);
  return id;
}

async function users(n: number, chips = 100_000): Promise<User[]> {
  const out: User[] = [];
  for (let i = 0; i < n; i++) {
    const u = await makeUser(pool, `Player ${String.fromCharCode(65 + i)}`);
    if (chips > 0) await grant(pool, u.id, chips, 'test grant');
    out.push(u);
  }
  return out;
}

async function tableBalance(userId: string, gameId: string): Promise<number> {
  return balance(pool, await ensureAccount(pool, 'table', userId, gameId));
}

// ---------------------------------------------------------------------------------------------------------
// Harness: fake clock, recording emitters, automatic client seeds

interface Emit {
  i: number;
  at: number;
  target: string;
  room: boolean;
  event: ServerEventName;
  payload: unknown;
}

interface Harness {
  tm: TableManager;
  clock: ReturnType<typeof fakeClock>;
  emits: Emit[];
  errors: unknown[];
  records: HandRecord[];
  autoSeeds: boolean;
  /** gameId -> handNumber -> seeds sent */
  sentSeeds: Map<string, Map<number, string[]>>;
}

function harness(opts: Partial<TableManagerDeps> = {}): Harness {
  const clock = fakeClock();
  const h: Harness = {
    tm: undefined as unknown as TableManager, // set right below
    clock,
    emits: [],
    errors: [],
    records: [],
    autoSeeds: true,
    sentSeeds: new Map(),
  };
  const push = (target: string, room: boolean, event: ServerEventName, payload: unknown): void => {
    h.emits.push({ i: h.emits.length, at: clock.now(), target, room, event, payload });
  };
  h.tm = new TableManager({
    pool,
    clock: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    emitTo: (userId, event, payload) => push(userId, false, event, payload),
    emitRoom: (gameId, event, payload) => {
      push(gameId, true, event, payload);
      if (event === 'hand:commitment' && h.autoSeeds) sendSeeds(h, gameId, payload as HandCommitment);
    },
    seedWaitMs: 0,
    runoutPacingMs: 0,
    handDelayMs: 0,
    autoStartMs: 0,
    rebuyWaitMs: 0,
    logger: { info: () => undefined, error: (message, e) => h.errors.push({ message, e }) },
    ...opts,
  });
  h.tm.onHandEnded((_g, r) => h.records.push(r));
  managers.push(h.tm);
  return h;
}

function sendSeeds(h: Harness, gameId: string, c: HandCommitment): void {
  const view = h.tm.viewFor(gameId, hostOf.get(gameId)!);
  const perGame = h.sentSeeds.get(gameId) ?? new Map<number, string[]>();
  h.sentSeeds.set(gameId, perGame);
  const sent: string[] = [];
  for (const s of view.seats) {
    if (s.stack === 0) continue;
    const seed = newClientSeed();
    sent.push(seed);
    h.tm.setClientSeed(gameId, s.playerId, c.handNumber, seed);
  }
  perGame.set(c.handNumber, sent);
}

async function step(h: Harness, gameId: string, ms = 0): Promise<void> {
  await h.clock.advance(ms);
  await h.tm.whenIdle(gameId);
}

function handEventsFor(h: Harness, userId: string): HandEvent[] {
  return h.emits.filter((e) => !e.room && e.target === userId && e.event === 'hand:event').map((e) => (e.payload as HandEventMessage).event);
}

function roomPayloads<T>(h: Harness, event: ServerEventName): T[] {
  return h.emits.filter((e) => e.room && e.event === event).map((e) => e.payload as T);
}

function actor(h: Harness, gameId: string, players: User[]): { user: User; view: TableView } | null {
  for (const user of players) {
    const view = h.tm.viewFor(gameId, user.id);
    if (view.legal) return { user, view };
  }
  return null;
}

function randomAction(legal: LegalActions, rand: () => number): { kind: ActionKind; amount?: number } {
  const r = rand();
  const pick = (lo: number, hi: number): number => lo + Math.floor(rand() ** 3 * (hi - lo + 1));
  if ((legal.canBet || legal.canRaise) && r < 0.04) return { kind: 'allIn' };
  if (legal.canBet && r < 0.3) return { kind: 'bet', amount: pick(legal.minTo, legal.maxTo) };
  if (legal.canRaise && r < 0.2) return { kind: 'raise', amount: pick(legal.minTo, legal.maxTo) };
  if (legal.canCheck) return { kind: 'check' };
  if (r < 0.35) return { kind: 'fold' };
  return { kind: 'call' };
}

/** Plays random legal actions (advancing the clock when nobody can act) until `done()`. */
async function playRandom(
  h: Harness,
  gameId: string,
  players: User[],
  rand: () => number,
  done: () => boolean,
  between: () => Promise<void> = async () => undefined,
): Promise<void> {
  for (let i = 0; i < 500_000 && !done(); i++) {
    await h.tm.whenIdle(gameId);
    await between();
    if (done()) return;
    const a = actor(h, gameId, players);
    if (a) {
      const choice = randomAction(a.view.legal!, rand);
      await h.tm.act(gameId, a.user.id, a.view.handId!, choice.kind, choice.amount);
      continue;
    }
    await step(h, gameId, 50);
  }
  if (!done()) throw new Error('playRandom did not finish');
}

/** Acts for `who` (must be their turn) after letting the table settle. */
async function actAs(h: Harness, gameId: string, who: User, kind: ActionKind, amount?: number): Promise<void> {
  await h.tm.whenIdle(gameId);
  const view = h.tm.viewFor(gameId, who.id);
  expect(view.legal, `${who.displayName} should be to act`).not.toBeNull();
  await h.tm.act(gameId, who.id, view.handId!, kind, amount);
}

async function waitForHand(h: Harness, gameId: string, viewer: string): Promise<TableView> {
  for (let i = 0; i < 1000; i++) {
    await h.tm.whenIdle(gameId);
    const v = h.tm.viewFor(gameId, viewer);
    if (v.handId !== null && v.toAct !== null) return v;
    await step(h, gameId, 10);
  }
  throw new Error('no hand started');
}

/** Folds or checks for whoever is to act until the current hand ends. */
async function finishHand(h: Harness, gameId: string, players: User[]): Promise<void> {
  const target = h.records.length + 1;
  for (let i = 0; i < 1000 && h.records.length < target; i++) {
    await h.tm.whenIdle(gameId);
    const a = actor(h, gameId, players);
    if (a) await h.tm.act(gameId, a.user.id, a.view.handId!, a.view.legal!.canCheck ? 'check' : 'fold');
    else await step(h, gameId, 10);
  }
  await h.tm.whenIdle(gameId);
  expect(h.records.length).toBe(target);
}

async function setupCash(n: number, settings: Record<string, unknown> = {}, opts: Partial<TableManagerDeps> = {}, stack = 500) {
  const players = await users(n);
  const host = players[0]!;
  const gameId = await makeGame(host, cashSettings(settings), players.slice(1));
  const h = harness(opts);
  for (const [i, p] of players.entries()) {
    await h.tm.join(gameId, p.id);
    await h.tm.sit(gameId, p.id, i, stack, newClientSeed());
  }
  return { h, gameId, players, host };
}

function dealOrderOf(started: Extract<HandEvent, { type: 'handStarted' }>, maxSeats: number): SeatIndex[] {
  const dist = (s: SeatIndex): number => (s - started.buttonSeat + maxSeats) % maxSeats || maxSeats;
  return started.seats.map((s) => s.seat).sort((a, b) => dist(a) - dist(b));
}

function holePositionsOf(started: Extract<HandEvent, { type: 'handStarted' }>, maxSeats: number): Map<SeatIndex, number[]> {
  const pos = dealPositions(started.seats.length);
  return new Map(dealOrderOf(started, maxSeats).map((seat, k) => [seat, pos.hole[k]!]));
}

// ---------------------------------------------------------------------------------------------------------

describe('redact', () => {
  it('hides other seats hole cards and passes everything else through', () => {
    const deal: HandEvent = { type: 'dealHole', seat: 2, cards: [10, 20] };
    expect(redact(deal, 2)).toEqual(deal);
    expect(redact(deal, 1)).toEqual({ type: 'dealHole', seat: 2, cards: [] });
    expect(redact(deal, null)).toEqual({ type: 'dealHole', seat: 2, cards: [] });
    expect(deal.cards).toEqual([10, 20]); // not mutated
    const show: HandEvent = { type: 'showCards', seat: 2, cards: [10, 20], handName: 'Pair of Aces' };
    expect(redact(show, null)).toBe(show);
    const street: HandEvent = { type: 'street', street: 'flop', cards: [1, 2, 3] };
    expect(redact(street, 0)).toBe(street);
  });
});

describe('TableManager', () => {
  it('plays 200 random hands of a cash game with chips conserved in the ledger', { timeout: 180_000 }, async () => {
    const players = await users(3);
    const host = players[0]!;
    const initial = await Promise.all(players.map((p) => walletBalance(pool, p.id)));
    const gameId = await makeGame(host, cashSettings(), players.slice(1));
    const h = harness();
    let boughtIn = 0;
    for (const [i, p] of players.entries()) {
      await h.tm.join(gameId, p.id);
      await h.tm.sit(gameId, p.id, i, 500, newClientSeed());
      boughtIn += 500;
    }
    await h.tm.host(gameId, host.id, { kind: 'start' });
    const rand = mulberry32(20261124);
    let checked = 0;
    await playRandom(h, gameId, players, rand, () => h.records.length >= 200, async () => {
      if (h.records.length > checked) {
        checked = h.records.length;
        const view = h.tm.viewFor(gameId, host.id);
        expect(view.handId).toBeNull();
        expect(view.seats.reduce((s, x) => s + x.stack, 0)).toBe(boughtIn);
        for (const s of view.seats) expect(await tableBalance(s.playerId, gameId)).toBe(s.stack);
        // Busted players were unseated; they buy in again at a free seat.
        for (const p of players) {
          if (view.seats.some((s) => s.playerId === p.id)) continue;
          const free = [0, 1, 2, 3, 4, 5].find((seat) => !h.tm.viewFor(gameId, host.id).seats.some((s) => s.seat === seat))!;
          await h.tm.sit(gameId, p.id, free, 500, newClientSeed());
          boughtIn += 500;
        }
      }
    });
    await h.tm.whenIdle(gameId);
    const seated = h.tm.viewFor(gameId, host.id).seats.map((s) => s.playerId);
    for (const p of players) {
      if (seated.includes(p.id)) await h.tm.leave(gameId, p.id);
      else await expect(h.tm.leave(gameId, p.id)).rejects.toMatchObject({ code: 'not_seated' });
    }
    expect(h.tm.viewFor(gameId, host.id).seats).toEqual([]);
    let total = 0;
    for (const p of players) {
      expect(await tableBalance(p.id, gameId)).toBe(0);
      total += await walletBalance(pool, p.id);
    }
    expect(total).toBe(initial.reduce((a, b) => a + b, 0));
    const sum = await pool.query<{ s: number }>('select coalesce(sum(amount), 0)::bigint as s from ledger_entries');
    expect(sum.rows[0]!.s).toBe(0);
    const hands = await pool.query<{ n: number }>('select count(*)::int as n from hands where game_id = $1', [gameId]);
    expect(hands.rows[0]!.n).toBe(h.records.length);
    expect(h.records.length).toBe(200);
    const unbalanced = await pool.query(
      `select p.hand_id from hand_players p join hands x on x.id = p.hand_id where x.game_id = $1 group by p.hand_id having sum(p.net) <> 0`,
      [gameId],
    );
    expect(unbalanced.rowCount).toBe(0);
    const seeds = await pool.query<{ n: number }>(
      'select count(*)::int as n from hand_seeds s join hands x on x.id = s.hand_id where x.game_id = $1',
      [gameId],
    );
    expect(seeds.rows[0]!.n).toBe(200);
    expect(h.errors).toEqual([]);
  });

  it('only lets the host and invited users join or sit', async () => {
    const [host, invited, stranger] = await users(3);
    const gameId = await makeGame(host!, cashSettings(), [invited!]);
    const h = harness();
    await expect(h.tm.join(gameId, stranger!.id)).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 });
    await expect(h.tm.sit(gameId, stranger!.id, 0, 500, newClientSeed())).rejects.toMatchObject({ code: 'forbidden' });
    const view = await h.tm.join(gameId, invited!.id);
    expect(view.gameId).toBe(gameId);
    expect(() => h.tm.viewFor(gameId, stranger!.id)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    await expect(h.tm.join(gameId, stranger!.id)).rejects.toMatchObject({ code: 'forbidden' });
    await h.tm.sit(gameId, invited!.id, 0, 500, newClientSeed());
    expect(h.tm.viewFor(gameId, invited!.id).mySeat).toBe(0);
    await expect(h.tm.join(gameId, host!.id)).resolves.toMatchObject({ status: 'waiting' });
    await expect(h.tm.join('00000000-0000-4000-8000-000000000000', host!.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects double seats, taken seats and bad buy-ins', async () => {
    const [host, a] = await users(2);
    const gameId = await makeGame(host!, cashSettings(), [a!]);
    const h = harness();
    await h.tm.sit(gameId, a!.id, 1, 500, newClientSeed());
    await expect(h.tm.sit(gameId, a!.id, 2, 500, newClientSeed())).rejects.toMatchObject({ code: 'already_seated' });
    await expect(h.tm.sit(gameId, host!.id, 1, 500, newClientSeed())).rejects.toMatchObject({ code: 'seat_taken' });
    await expect(h.tm.sit(gameId, host!.id, 2, 99, newClientSeed())).rejects.toMatchObject({ code: 'bad_buy_in' });
    await expect(h.tm.sit(gameId, host!.id, 2, 1001, newClientSeed())).rejects.toMatchObject({ code: 'bad_buy_in' });
    const broke = await makeUser(pool, 'Broke');
    await grant(pool, broke.id, 150, 'small');
    await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [gameId, broke.id]);
    await expect(h.tm.sit(gameId, broke.id, 3, 200, newClientSeed())).rejects.toMatchObject({ code: 'not_enough_chips' });
    expect(await walletBalance(pool, broke.id)).toBe(150);
    await h.tm.sit(gameId, broke.id, 3, 150, newClientSeed());
    expect(await walletBalance(pool, broke.id)).toBe(0);
    expect(await tableBalance(broke.id, gameId)).toBe(150);
  });

  it('never shows a spectator hole cards and sends card proofs only to entitled viewers', { timeout: 120_000 }, async () => {
    const all = await users(4);
    const host = all[0]!;
    const players = all.slice(1);
    const gameId = await makeGame(host, cashSettings(), players);
    const h = harness();
    await h.tm.join(gameId, host.id);
    for (const [i, p] of players.entries()) {
      await h.tm.join(gameId, p.id);
      await h.tm.sit(gameId, p.id, i * 2, 300, newClientSeed());
    }
    await h.tm.host(gameId, host.id, { kind: 'start' });
    const rand = mulberry32(7);
    await playRandom(h, gameId, players, rand, () => h.records.length >= 40, async () => {
      for (const p of players) {
        const v = h.tm.viewFor(gameId, host.id);
        if (!v.seats.some((s) => s.playerId === p.id)) {
          const free = [0, 1, 2, 3, 4, 5].find((seat) => !v.seats.some((s) => s.seat === seat))!;
          await h.tm.sit(gameId, p.id, free, 300, newClientSeed());
        }
      }
    });

    const spectatorEvents = handEventsFor(h, host.id);
    expect(spectatorEvents.filter((e) => e.type === 'dealHole').length).toBeGreaterThan(100);
    for (const e of spectatorEvents) if (e.type === 'dealHole') expect(e.cards).toEqual([]);

    let showdowns = 0;
    for (const viewer of all) {
      let started: Extract<HandEvent, { type: 'handStarted' }> | null = null;
      let allowed = new Set<number>();
      let ownPositions: number[] = [];
      let ownProofs = new Set<number>();
      let byseat = new Map<SeatIndex, number[]>();
      const closeHand = (): void => {
        if (started && ownPositions.length > 0) expect(ownProofs.size).toBe(2);
      };
      for (const e of handEventsFor(h, viewer.id)) {
        if (e.type === 'handStarted') {
          closeHand();
          started = e;
          byseat = holePositionsOf(e, 6);
          const mine = e.seats.find((s) => s.playerId === viewer.id);
          ownPositions = mine ? byseat.get(mine.seat)! : [];
          ownProofs = new Set();
          allowed = new Set([...ownPositions, ...dealPositions(e.seats.length).board]);
        } else if (e.type === 'dealHole') {
          const mine = started!.seats.find((s) => s.seat === e.seat)?.playerId === viewer.id;
          expect(e.cards.length).toBe(mine ? 2 : 0);
        } else if (e.type === 'showCards') {
          for (const p of byseat.get(e.seat)!) allowed.add(p);
          if (viewer === host) showdowns++;
        } else if (e.type === 'cardProof') {
          expect(allowed.has(e.position), `proof for position ${e.position} sent to ${viewer.displayName}`).toBe(true);
          expect(verifyCard(started!.cardCommitments[e.position]!, e.salt, e.position, e.card)).toBe(true);
          if (ownPositions.includes(e.position)) ownProofs.add(e.position);
        }
      }
      closeHand();
    }
    expect(showdowns).toBeGreaterThan(0);
  });

  it('switches to the time bank, then checks or folds on timeout', async () => {
    const { h, gameId, players } = await setupCash(2, { turnSeconds: 5, timeBankSeconds: 10 });
    const [a, b] = players as [User, User];
    const clocks = (): TableClock[] => roomPayloads<TableClock>(h, 'table:clock');
    const actions = (): Extract<HandEvent, { type: 'action' }>[] =>
      handEventsFor(h, a.id).filter((e): e is Extract<HandEvent, { type: 'action' }> => e.type === 'action');
    await h.tm.host(gameId, a.id, { kind: 'start' });
    await waitForHand(h, gameId, a.id);
    // Hand 1: A is the button (small blind) and must act facing the big blind.
    const t0 = h.clock.now();
    expect(clocks().at(-1)).toMatchObject({ seat: 0, deadline: t0 + 5000, timeBankMs: 10_000, usingTimeBank: false });
    expect(h.tm.viewFor(gameId, a.id).deadline).toBe(t0 + 5000);
    await step(h, gameId, 4999);
    expect(clocks().some((c) => c.usingTimeBank)).toBe(false);
    await step(h, gameId, 1);
    expect(clocks().at(-1)).toMatchObject({ seat: 0, deadline: t0 + 15_000, timeBankMs: 10_000, usingTimeBank: true });
    expect(actions()).toEqual([]);
    await step(h, gameId, 9999);
    expect(actions()).toEqual([]);
    await step(h, gameId, 1);
    expect(actions().at(-1)).toMatchObject({ seat: 0, kind: 'fold', auto: 'timeout' });

    // Hand 2: B is the button. B calls; A (bank now 0) can check and is checked right after the turn timer.
    await waitForHand(h, gameId, a.id);
    await actAs(h, gameId, b, 'call');
    const t1 = h.clock.now();
    expect(clocks().at(-1)).toMatchObject({ seat: 0, deadline: t1 + 5000, timeBankMs: 0, usingTimeBank: false });
    await step(h, gameId, 4999);
    expect(actions().at(-1)).toMatchObject({ seat: 1, kind: 'call' });
    await step(h, gameId, 1);
    expect(actions().at(-1)).toMatchObject({ seat: 0, kind: 'check', auto: 'timeout' });
    // Flop: A acts first and is checked after 5 s again; B uses the bank and is then checked too.
    await step(h, gameId, 5000);
    expect(actions().at(-1)).toMatchObject({ seat: 0, kind: 'check', auto: 'timeout' });
    expect(clocks().at(-1)).toMatchObject({ seat: 1, timeBankMs: 10_000, usingTimeBank: false });
    await step(h, gameId, 5000);
    expect(clocks().at(-1)).toMatchObject({ seat: 1, usingTimeBank: true });
    await step(h, gameId, 10_000);
    expect(actions().at(-1)).toMatchObject({ seat: 1, kind: 'check', auto: 'timeout' });
    // Turn: A is checked after 5 s; B's bank is empty now, so B is checked right after the turn timer.
    await step(h, gameId, 5000);
    expect(actions().at(-1)).toMatchObject({ seat: 0, kind: 'check', auto: 'timeout' });
    expect(clocks().at(-1)).toMatchObject({ seat: 1, timeBankMs: 0, usingTimeBank: false });
    await step(h, gameId, 4999);
    expect(actions().at(-1)).toMatchObject({ seat: 0, kind: 'check' });
    await step(h, gameId, 1);
    expect(actions().at(-1)).toMatchObject({ seat: 1, kind: 'check', auto: 'timeout' });
    expect(h.errors).toEqual([]);
  });

  it('applies a mid-hand settings change from the next hand', async () => {
    const { h, gameId, players, host } = await setupCash(2);
    await h.tm.host(gameId, host.id, { kind: 'start' });
    await waitForHand(h, gameId, host.id);
    const bigger: BlindLevel = { ...LEVEL_1, smallBlind: 20, bigBlind: 40 };
    await h.tm.host(gameId, host.id, { kind: 'updateSettings', settings: { levels: [bigger] } });
    const stored = await pool.query<{ settings: GameSettings }>('select settings from games where id = $1', [gameId]);
    expect(stored.rows[0]!.settings.levels[0]!.bigBlind).toBe(40);
    const view = h.tm.viewFor(gameId, host.id);
    expect(view.handId).not.toBeNull();
    expect(view.settings.levels[0]!.bigBlind).toBe(10);
    // The current hand keeps its stakes: the next raise minimum is still based on the 10 big blind.
    const a = actor(h, gameId, players)!;
    expect(a.view.legal!.minTo).toBe(20);
    await finishHand(h, gameId, players);
    await waitForHand(h, gameId, host.id);
    const started = handEventsFor(h, host.id).filter((e) => e.type === 'handStarted');
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ stakes: { smallBlind: 5, bigBlind: 10 } });
    expect(started[1]).toMatchObject({ stakes: { smallBlind: 20, bigBlind: 40 } });
  });

  it('applies a settings change at once while no hand is in progress', async () => {
    const [host, b] = await users(2);
    const gameId = await makeGame(host!, cashSettings(), [b!]);
    const h = harness();
    await h.tm.join(gameId, host!.id);
    await h.tm.host(gameId, host!.id, { kind: 'updateSettings', settings: { minBuyIn: 300 } });
    expect(h.tm.viewFor(gameId, host!.id).settings.minBuyIn).toBe(300);
    await expect(h.tm.sit(gameId, b!.id, 1, 200, newClientSeed())).rejects.toMatchObject({ code: 'bad_buy_in' });
    await h.tm.sit(gameId, b!.id, 1, 300, newClientSeed());
    await h.tm.host(gameId, host!.id, { kind: 'updateSettings', settings: { seatApproval: true } });
    await h.tm.sit(gameId, host!.id, 0, 300, newClientSeed()); // the host is never queued
    const late = (await users(1))[0]!;
    await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [gameId, late.id]);
    await h.tm.sit(gameId, late.id, 2, 300, newClientSeed());
    expect(h.tm.viewFor(gameId, host!.id).seatRequests).toEqual([{ playerId: late.id, name: late.displayName }]);
  });

  it('commits to every deck before the seeds are collected, and every deck verifies', { timeout: 60_000 }, async () => {
    const { h, gameId, players, host } = await setupCash(3, {}, {}, 400);
    await h.tm.host(gameId, host.id, { kind: 'start' });
    await playRandom(h, gameId, players, mulberry32(99), () => h.records.length >= 25, async () => {
      for (const p of players) {
        const v = h.tm.viewFor(gameId, host.id);
        if (!v.seats.some((s) => s.playerId === p.id)) {
          const free = [0, 1, 2, 3, 4, 5].find((seat) => !v.seats.some((s) => s.seat === seat))!;
          await h.tm.sit(gameId, p.id, free, 400, newClientSeed());
        }
      }
    });
    const commitments = h.emits.filter((e) => e.room && e.event === 'hand:commitment');
    const sent = h.sentSeeds.get(gameId)!;
    for (const [n, record] of h.records.entries()) {
      const { rows } = await pool.query<{ server_seed: string; salt_key: string }>('select server_seed, salt_key from hand_seeds where hand_id = $1', [record.handId]);
      const seeds = rows[0]!;
      const started = record.events[0] as Extract<HandEvent, { type: 'handStarted' }>;
      const ended = record.events.at(-1) as Extract<HandEvent, { type: 'handEnded' }>;
      expect(started.type).toBe('handStarted');
      expect(ended.type).toBe('handEnded');
      // The commitment announced before this hand's seeds were collected.
      const startIndex = h.emits.findIndex(
        (e) => e.event === 'hand:event' && (e.payload as HandEventMessage).event.type === 'handStarted' && ((e.payload as HandEventMessage).event as { handId: string }).handId === record.handId,
      );
      const announced = commitments.filter((e) => e.i < startIndex && (e.payload as HandCommitment).handNumber === record.handNumber).at(-1)!;
      const commitment = (announced.payload as HandCommitment).commitment;
      expect(started.commitment).toBe(commitment);
      expect(commit(seeds.server_seed)).toBe(commitment);
      const deck = deckFromSeeds(seeds.server_seed, ended.clientSeeds, record.handNumber);
      expect(verifyDeck(commitment, seeds.server_seed, ended.clientSeeds, record.handNumber, deck)).toBe(true);
      expect(started.cardCommitments).toEqual(cardCommitments(deck, seeds.salt_key));
      // Cards in the record are the deck's cards at the deal positions.
      const holes = holePositionsOf(started, 6);
      for (const [seat, positions] of holes) expect(record.hole[seat]).toEqual(positions.map((p) => deck[p]));
      const boardPositions = dealPositions(started.seats.length).board;
      expect(record.board).toEqual(boardPositions.slice(0, record.board.length).map((p) => deck[p]));
      // The players' client seeds were used.
      expect(ended.clientSeeds).toEqual([...sent.get(record.handNumber)!].sort());
      expect(ended.clientSeeds.length).toBe(started.seats.length);
      const next = h.records[n + 1];
      if (next) expect((next.events[0] as Extract<HandEvent, { type: 'handStarted' }>).commitment).toBe(ended.nextCommitment);
    }
    expect(h.records.length).toBe(25);
  });

  it('shows both hands and paces an all-in runout with equity before each street', async () => {
    const { h, gameId, players, host } = await setupCash(2, {}, { runoutPacingMs: 1000 });
    const [a, b] = players as [User, User];
    await h.tm.host(gameId, host.id, { kind: 'start' });
    await waitForHand(h, gameId, a.id);
    await actAs(h, gameId, a, 'allIn');
    await actAs(h, gameId, b, 'call');
    for (let i = 0; i < 5 && h.records.length === 0; i++) await step(h, gameId, 1000);
    expect(h.records).toHaveLength(1);
    const stream = h.emits.filter((e) => !e.room && e.target === b.id && e.event === 'hand:event');
    const ev = (e: Emit): HandEvent => (e.payload as HandEventMessage).event;
    const calls = stream.findIndex((e) => { const x = ev(e); return x.type === 'action' && x.kind === 'call'; });
    const after = stream.slice(calls + 1).filter((e) => !['cardProof', 'potsFormed'].includes(ev(e).type));
    expect(after.slice(0, 2).map((e) => ev(e))).toEqual([
      expect.objectContaining({ type: 'showCards', seat: 0, handName: '' }),
      expect.objectContaining({ type: 'showCards', seat: 1, handName: '' }),
    ]);
    const sequence = after.map((e) => { const x = ev(e); return x.type === 'equity' ? `equity:${x.street}` : x.type === 'street' ? `street:${x.street}` : null; }).filter((x) => x !== null);
    expect(sequence).toEqual(['equity:flop', 'street:flop', 'equity:turn', 'street:turn', 'equity:river', 'street:river']);
    const streetTimes = after.filter((e) => ev(e).type === 'street').map((e) => e.at);
    const showAt = after[0]!.at;
    expect(streetTimes).toEqual([showAt + 1000, showAt + 2000, showAt + 3000]);
    for (const e of after) {
      const x = ev(e);
      if (x.type !== 'equity') continue;
      expect(x.equities.map((q) => q.seat)).toEqual([0, 1]);
      const p = x.equities[0]!;
      const q = x.equities[1]!;
      for (const v of [p.win, p.tie, q.win, q.tie]) expect(v).toBeGreaterThanOrEqual(0);
      expect(p.tie).toBeCloseTo(q.tie, 12);
      expect(p.win + q.win + p.tie).toBeCloseTo(1, 9);
      // Before the river the equity is exact over the 44 remaining cards.
      if (x.street === 'river') expect(Math.abs(p.win * 44 - Math.round(p.win * 44))).toBeLessThan(1e-9);
    }
    // Both hands were proven to everyone right after the runout show.
    const started = h.records[0]!.events[0] as Extract<HandEvent, { type: 'handStarted' }>;
    const holes = holePositionsOf(started, 6);
    const proofsToB = stream.map(ev).filter((x) => x.type === 'cardProof').map((x) => (x as { position: number }).position);
    for (const p of holes.get(0)!) expect(proofsToB).toContain(p);
    expect(h.records[0]!.events.filter((x) => x.type === 'equity')).toHaveLength(3);
  });

  it('starts only on start or auto-start, pauses after the hand, resumes, and ends with results', { timeout: 60_000 }, async () => {
    // Manual start
    {
      const { h, gameId, players, host } = await setupCash(2);
      await step(h, gameId, 60_000);
      expect(roomPayloads(h, 'hand:commitment')).toEqual([]);
      expect(h.tm.viewFor(gameId, host.id).status).toBe('waiting');
      await expect(h.tm.host(gameId, players[1]!.id, { kind: 'start' })).rejects.toMatchObject({ code: 'forbidden' });
      await h.tm.host(gameId, host.id, { kind: 'start' });
      await waitForHand(h, gameId, host.id);
      expect(roomPayloads<TableStatusMessage>(h, 'table:status').at(-1)).toMatchObject({ status: 'running' });
      const db1 = await pool.query<{ status: string }>('select status from games where id = $1', [gameId]);
      expect(db1.rows[0]!.status).toBe('running');
      await expect(h.tm.host(gameId, host.id, { kind: 'start' })).rejects.toMatchObject({ code: 'bad_state' });

      // Pause mid-hand: the hand plays out, then nothing new starts.
      await h.tm.host(gameId, host.id, { kind: 'pause' });
      expect(h.tm.viewFor(gameId, host.id).status).toBe('running');
      await finishHand(h, gameId, players);
      await step(h, gameId, 60_000);
      expect(h.tm.viewFor(gameId, host.id)).toMatchObject({ status: 'paused', handId: null });
      expect(handEventsFor(h, host.id).filter((e) => e.type === 'handStarted')).toHaveLength(1);
      const db2 = await pool.query<{ status: string }>('select status from games where id = $1', [gameId]);
      expect(db2.rows[0]!.status).toBe('paused');
      await h.tm.host(gameId, host.id, { kind: 'resume' });
      await waitForHand(h, gameId, host.id);
      expect(handEventsFor(h, host.id).filter((e) => e.type === 'handStarted')).toHaveLength(2);

      // End mid-hand: after the hand everyone is cashed out and results go out.
      await h.tm.host(gameId, host.id, { kind: 'end' });
      expect(roomPayloads(h, 'table:results')).toEqual([]);
      await finishHand(h, gameId, players);
      const results = roomPayloads<TableResults>(h, 'table:results');
      expect(results).toHaveLength(1);
      const entries = results[0]!.results;
      expect(entries.map((r) => r.userId).sort()).toEqual(players.map((p) => p.id).sort());
      expect(entries.every((r) => r.prize === 0)).toBe(true);
      const nets = await pool.query<{ user_id: string; net: number }>(
        'select p.user_id, sum(p.net)::bigint as net from hand_players p join hands x on x.id = p.hand_id where x.game_id = $1 group by p.user_id',
        [gameId],
      );
      const netOf = new Map(nets.rows.map((r) => [r.user_id, r.net]));
      for (const r of entries) {
        const better = entries.filter((o) => netOf.get(o.userId)! > netOf.get(r.userId)!).length;
        expect(r.place).toBe(better + 1);
      }
      expect(roomPayloads<TableStatusMessage>(h, 'table:status').at(-1)).toMatchObject({ status: 'finished' });
      const db3 = await pool.query<{ status: string }>('select status from games where id = $1', [gameId]);
      expect(db3.rows[0]!.status).toBe('finished');
      let wallets = 0;
      for (const p of players) {
        expect(await tableBalance(p.id, gameId)).toBe(0);
        wallets += await walletBalance(pool, p.id);
      }
      expect(wallets).toBe(200_000);
      expect(h.tm.viewFor(gameId, host.id).seats).toEqual([]);
      await expect(h.tm.results(gameId)).resolves.toEqual(entries);
      await expect(h.tm.sit(gameId, players[0]!.id, 0, 500, newClientSeed())).rejects.toMatchObject({ code: 'closed' });
    }
    // Auto-start after the second player sits
    {
      const players = await users(2);
      const gameId = await makeGame(players[0]!, cashSettings({ autoStart: true }), [players[1]!]);
      const h = harness({ autoStartMs: 3000 });
      await h.tm.sit(gameId, players[0]!.id, 0, 500, newClientSeed());
      await step(h, gameId, 10_000);
      expect(h.tm.viewFor(gameId, players[0]!.id).status).toBe('waiting');
      await h.tm.sit(gameId, players[1]!.id, 1, 500, newClientSeed());
      await step(h, gameId, 2999);
      expect(h.tm.viewFor(gameId, players[0]!.id).status).toBe('waiting');
      await step(h, gameId, 1);
      expect(h.tm.viewFor(gameId, players[0]!.id).status).toBe('running');
      await waitForHand(h, gameId, players[0]!.id);
    }
    // Auto-start is cancelled when seats drop below two
    {
      const players = await users(2);
      const gameId = await makeGame(players[0]!, cashSettings({ autoStart: true }), [players[1]!]);
      const h = harness({ autoStartMs: 3000 });
      await h.tm.sit(gameId, players[0]!.id, 0, 500, newClientSeed());
      await h.tm.sit(gameId, players[1]!.id, 1, 500, newClientSeed());
      await step(h, gameId, 1000);
      await h.tm.leave(gameId, players[1]!.id);
      await step(h, gameId, 10_000);
      expect(h.tm.viewFor(gameId, players[0]!.id).status).toBe('waiting');
    }
  });

  it('queues seat requests for the host to approve or reject', async () => {
    const [host, b, c] = await users(3);
    const gameId = await makeGame(host!, cashSettings({ seatApproval: true }), [b!, c!]);
    const h = harness();
    await h.tm.join(gameId, host!.id);
    await h.tm.sit(gameId, host!.id, 0, 500, newClientSeed()); // the host is never queued
    await h.tm.sit(gameId, b!.id, 1, 500, newClientSeed());
    expect(h.tm.viewFor(gameId, b!.id).mySeat).toBeNull();
    expect(await walletBalance(pool, b!.id)).toBe(100_000);
    const hostView = h.tm.viewFor(gameId, host!.id);
    expect(hostView.seatRequests).toEqual([{ playerId: b!.id, name: b!.displayName }]);
    expect(h.tm.viewFor(gameId, b!.id).seatRequests).toEqual([]);
    expect(h.tm.pendingSeatRequests(gameId)).toEqual([{ playerId: b!.id, name: b!.displayName }]);
    const pushed = h.emits.filter((e) => !e.room && e.target === host!.id && e.event === 'table:view');
    expect((pushed.at(-1)!.payload as TableView).seatRequests).toHaveLength(1);
    const notes = await pool.query<{ kind: string }>('select kind from notifications where user_id = $1', [host!.id]);
    expect(notes.rows.map((r) => r.kind)).toContain('seatRequest');

    await expect(h.tm.host(gameId, b!.id, { kind: 'approveSeat', playerId: b!.id, approve: true })).rejects.toMatchObject({ code: 'forbidden' });
    await h.tm.host(gameId, host!.id, { kind: 'approveSeat', playerId: b!.id, approve: true });
    expect(h.tm.viewFor(gameId, b!.id).mySeat).toBe(1);
    expect(await tableBalance(b!.id, gameId)).toBe(500);

    await h.tm.sit(gameId, c!.id, 2, 500, newClientSeed());
    expect(h.tm.viewFor(gameId, host!.id).seatRequests).toEqual([{ playerId: c!.id, name: c!.displayName }]);
    await h.tm.host(gameId, host!.id, { kind: 'approveSeat', playerId: c!.id, approve: false });
    expect(h.tm.viewFor(gameId, host!.id).seatRequests).toEqual([]);
    expect(h.tm.viewFor(gameId, c!.id).mySeat).toBeNull();
    expect(await walletBalance(pool, c!.id)).toBe(100_000);
  });

  it('folds a kicked cash player at their next turn and cashes them out after the hand', async () => {
    const { h, gameId, players, host } = await setupCash(3);
    const [a, b] = players as [User, User, User];
    await h.tm.host(gameId, host.id, { kind: 'start' });
    const view = await waitForHand(h, gameId, a.id);
    expect(view).toMatchObject({ buttonSeat: 0, toAct: 0 }); // A is button and first to act 3-handed; B posted the small blind
    await h.tm.host(gameId, host.id, { kind: 'kick', playerId: b.id });
    expect(h.tm.viewFor(gameId, b.id).mySeat).toBe(1); // still seated during the hand
    await actAs(h, gameId, a, 'raise', 40);
    await h.tm.whenIdle(gameId);
    const bActs = handEventsFor(h, a.id).filter((e) => e.type === 'action' && e.seat === 1);
    expect(bActs).toEqual([expect.objectContaining({ kind: 'fold', auto: 'timeout' })]);
    await finishHand(h, gameId, players);
    expect(h.tm.viewFor(gameId, host.id).seats.map((s) => s.playerId)).not.toContain(b.id);
    expect(await tableBalance(b.id, gameId)).toBe(0);
    expect(await walletBalance(pool, b.id)).toBe(100_000 - 5);
  });

  it('runs a tournament through the controller: levels, rebuys, eliminations and results', { timeout: 60_000 }, async () => {
    const [host, b] = await users(2);
    const gameId = await makeGame(host!, tournamentSettings(), [b!]);
    let controller: FakeTournament | null = null;
    const h = harness({
      rebuyWaitMs: 5000,
      tournamentFactory: (args) => {
        controller = new FakeTournament(args);
        return controller;
      },
    });
    const players = [host!, b!];
    await h.tm.join(gameId, host!.id);
    await expect(h.tm.sit(gameId, b!.id, 1, 999, newClientSeed())).rejects.toMatchObject({ code: 'bad_buy_in' });
    await h.tm.sit(gameId, host!.id, 0, 1000, newClientSeed());
    await h.tm.sit(gameId, b!.id, 1, 1000, newClientSeed());
    await h.tm.host(gameId, host!.id, { kind: 'start' });
    const c = (): FakeTournament => controller!;
    expect(c().args.settings.startingStack).toBe(1000);
    const late = (await users(1))[0]!;
    await pool.query('insert into game_invites (game_id, user_id) values ($1, $2)', [gameId, late.id]);
    await expect(h.tm.sit(gameId, late.id, 2, 1000, newClientSeed())).rejects.toMatchObject({ code: 'bad_state' });
    await expect(h.tm.rebuy(gameId, b!.id)).rejects.toMatchObject({ code: 'bad_state' });
    await expect(h.tm.host(gameId, host!.id, { kind: 'end' })).rejects.toMatchObject({ code: 'bad_state' });

    /** Plays all-in hands until someone busts; returns the busted user. */
    const bustSomeone = async (): Promise<User> => {
      for (let i = 0; i < 50; i++) {
        await waitForHand(h, gameId, host!.id);
        const before = h.records.length;
        while (h.records.length === before) {
          const a = actor(h, gameId, players);
          if (a) await h.tm.act(gameId, a.user.id, a.view.handId!, a.view.legal!.canBet || a.view.legal!.canRaise ? 'allIn' : 'call');
          else await step(h, gameId, 10);
        }
        await h.tm.whenIdle(gameId);
        const ended = h.records.at(-1)!.events.at(-1) as Extract<HandEvent, { type: 'handEnded' }>;
        const busted = ended.stacks.find((s) => s.stack === 0);
        if (busted) return players[busted.seat]!;
      }
      throw new Error('nobody busted');
    };

    await waitForHand(h, gameId, host!.id);
    expect(handEventsFor(h, host!.id).find((e) => e.type === 'handStarted')).toMatchObject({ stakes: { smallBlind: 5, bigBlind: 10 } });
    const loser = await bustSomeone();
    // The busted player may rebuy inside the window.
    expect(c().calls).toHaveLength(h.records.length - 1);
    await h.tm.rebuy(gameId, loser.id);
    await h.tm.whenIdle(gameId);
    expect(c().calls.at(-1)!.find((s) => s.userId === loser.id)).toMatchObject({ endStack: 1000 });
    expect(h.tm.viewFor(gameId, loser.id).seats.find((s) => s.playerId === loser.id)!.stack).toBe(1000);
    expect(await tableBalance(loser.id, gameId)).toBe(1000);

    // A new level: stakes come from levelFor and table:status announces it.
    c().levelIndex = 1;
    c().rebuyAllowed = false;
    await step(h, gameId, 10);
    await waitForHand(h, gameId, host!.id);
    expect(handEventsFor(h, host!.id).filter((e) => e.type === 'handStarted').at(-1)).toMatchObject({ stakes: { smallBlind: 50, bigBlind: 100 } });
    expect(roomPayloads<TableStatusMessage>(h, 'table:status').at(-1)).toMatchObject({ status: 'running', level: { level: 2 } });

    const out = await bustSomeone();
    await h.tm.whenIdle(gameId);
    const winner = players.find((p) => p.id !== out.id)!;
    expect(h.tm.viewFor(gameId, host!.id).seats.map((s) => s.playerId)).toEqual([winner.id]);
    expect(roomPayloads<TableStatusMessage>(h, 'table:status').at(-1)).toMatchObject({ status: 'finished' });
    const results = roomPayloads<TableResults>(h, 'table:results');
    expect(results).toHaveLength(1);
    expect(results[0]!.results).toEqual([
      expect.objectContaining({ userId: winner.id, place: 1 }),
      expect.objectContaining({ userId: out.id, place: 2 }),
    ]);
  });

  it('gives each viewer only their own cards and legal actions', async () => {
    const all = await users(3);
    const host = all[0]!;
    const [a, b] = [all[1]!, all[2]!];
    const gameId = await makeGame(host, cashSettings(), [a, b]);
    const h = harness();
    await h.tm.join(gameId, host.id);
    await h.tm.sit(gameId, a.id, 0, 500, newClientSeed());
    await h.tm.sit(gameId, b.id, 1, 500, newClientSeed());
    await h.tm.host(gameId, host.id, { kind: 'start' });
    await waitForHand(h, gameId, host.id);
    const va = h.tm.viewFor(gameId, a.id);
    const vb = h.tm.viewFor(gameId, b.id);
    const vh = h.tm.viewFor(gameId, host.id);
    expect(va.myHole).toHaveLength(2);
    expect(vb.myHole).toHaveLength(2);
    expect(vh.myHole).toEqual([]);
    expect(vh.mySeat).toBeNull();
    expect(va.seats[0]!.cardsVisible).toEqual(va.myHole);
    expect(va.seats[1]!.cardsVisible).toBeNull();
    expect(vb.seats[0]!.cardsVisible).toBeNull();
    expect(vh.seats.every((s) => s.cardsVisible === null && s.hasCards)).toBe(true);
    expect(va.toAct).toBe(0);
    expect(va.legal).toMatchObject({ seat: 0, canFold: true, callAmount: 5 });
    expect(va.deadline).not.toBeNull();
    expect(vb.legal).toBeNull();
    expect(vh.legal).toBeNull();
    // The deadline is public: other players and spectators can draw the countdown.
    expect(vb.deadline).toBe(va.deadline);
    expect(vh.deadline).toBe(va.deadline);
    expect(vh.toAct).toBe(0);
    expect(va.seats.map((s) => s.bet)).toEqual([5, 10]);
    expect(va.commitment).toMatch(/^[0-9a-f]{64}$/);
    await expect(h.tm.act(gameId, a.id, '00000000-0000-4000-8000-000000000000', 'call')).rejects.toMatchObject({ code: 'stale_hand' });
    await expect(h.tm.act(gameId, b.id, va.handId!, 'call')).rejects.toMatchObject({ code: 'not_your_turn' });
    await expect(h.tm.act(gameId, a.id, va.handId!, 'check')).rejects.toMatchObject({ code: 'illegal_action' });
    await expect(h.tm.act(gameId, host.id, va.handId!, 'call')).rejects.toMatchObject({ code: 'not_seated' });
    await h.tm.act(gameId, a.id, va.handId!, 'call');
    expect(h.tm.viewFor(gameId, b.id).legal).toMatchObject({ seat: 1, canCheck: true });
    expect(h.tm.viewFor(gameId, a.id).legal).toBeNull();
  });

  it('flags players whose latest sessions share a public IP when they sit', async () => {
    const [host, b, c] = await users(3);
    const gameId = await makeGame(host!, cashSettings(), [b!, c!]);
    const session = async (userId: string, ip: string, device: string, ageMin: number): Promise<void> => {
      await pool.query(
        `insert into sessions (id, user_id, ip, device_id, created_at, expires_at) values ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval, now() + interval '1 day')`,
        [`${userId}-${ip}-${device}`, userId, ip, device, ageMin],
      );
    };
    await session(host!.id, '127.0.0.1', 'dev-host', 1);
    await session(b!.id, '198.51.100.1', 'dev-b-old', 60);
    await session(b!.id, '203.0.113.7', 'dev-b', 1);
    await session(c!.id, '203.0.113.7', 'dev-c', 1);
    const h = harness();
    await h.tm.sit(gameId, host!.id, 0, 500, newClientSeed());
    await h.tm.sit(gameId, b!.id, 1, 500, newClientSeed());
    expect((await pool.query('select 1 from integrity_flags where game_id = $1', [gameId])).rowCount).toBe(0);
    await h.tm.sit(gameId, c!.id, 2, 500, newClientSeed());
    const flags = await pool.query<{ kind: string; players: string[] }>('select kind, players from integrity_flags where game_id = $1', [gameId]);
    expect(flags.rows).toEqual([{ kind: 'sharedIp', players: [b!.id, c!.id].sort() }]);
    const notes = await pool.query<{ kind: string }>(`select kind from notifications where user_id = $1 and kind = 'integrityFlag'`, [host!.id]);
    expect(notes.rowCount).toBe(1);
  });

  it('keeps the table usable when storing a hand fails', async () => {
    const { h, gameId, players, host } = await setupCash(2);
    await h.tm.host(gameId, host.id, { kind: 'start' });
    await waitForHand(h, gameId, host.id);
    await pool.query('alter table hand_seeds rename to hand_seeds_off');
    try {
      await finishHand(h, gameId, players);
    } finally {
      await pool.query('alter table hand_seeds_off rename to hand_seeds');
    }
    expect(h.errors).toHaveLength(1);
    expect(JSON.stringify(h.errors)).not.toMatch(/[0-9a-f]{64}/);
    await waitForHand(h, gameId, host.id);
    await finishHand(h, gameId, players);
    expect(h.errors).toHaveLength(1);
    const hands = await pool.query<{ n: number }>('select count(*)::int as n from hands where game_id = $1', [gameId]);
    expect(hands.rows[0]!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

class FakeTournament implements TournamentControllerLike {
  levelIndex = 0;
  rebuyAllowed = true;
  calls: { userId: string; startStack: number; endStack: number }[][] = [];
  private out: string[] = [];
  constructor(public args: TournamentFactoryArgs) {}

  levelFor(): BlindLevel {
    return this.args.settings.levels[this.levelIndex]!;
  }

  nextLevelAt(now: number): number | null {
    return this.levelIndex < this.args.settings.levels.length - 1 ? now + 60_000 : null;
  }

  canRebuy(): boolean {
    return this.rebuyAllowed;
  }

  async rebuy(userId: string): Promise<number> {
    await buyIn(this.args.pool, userId, this.args.gameId, 1000);
    return 1000;
  }

  async onHandEnded(stacks: { userId: string; startStack: number; endStack: number }[]): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }> {
    this.calls.push(stacks);
    const busted = stacks.filter((s) => s.endStack === 0);
    const alive = stacks.length - busted.length;
    this.out.unshift(...busted.map((s) => s.userId));
    if (alive <= 1) this.winner = stacks.find((s) => s.endStack > 0)?.userId ?? null;
    return { eliminated: busted.map((s) => ({ userId: s.userId, place: alive + 1 })), finished: alive <= 1 };
  }

  private winner: string | null = null;

  async results(): Promise<ResultEntry[]> {
    const order = [...(this.winner ? [this.winner] : []), ...this.out];
    return order.map((userId, i) => ({ userId, name: '', place: i + 1, prize: i === 0 ? 2000 : 0 }));
  }
}
