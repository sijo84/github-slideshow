import {
  advance,
  allInRunout,
  applyAction,
  cardCommitments,
  cardSalt,
  commit,
  dealPositions,
  formatCard,
  parseCards,
  startHand,
  type Card,
  type HandConfig,
  type HandEvent,
  type HandState,
  type PlayerAction,
  type SeatIndex,
} from '@poker/engine';
import type { GameSettings, SeatView, TableView } from '@poker/protocol';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { __resetForTests, __setRafForTests } from '../src/anim/tween.js';
import { TableStoreProvider } from '../src/table/storeContext.js';
import { VERIFIED_TEXT, VERIFY_FAILED_TEXT } from '../src/table/steps.js';
import { DEAL_STAGGER_MS, STEP_MS, type AnimStep, type StepKind, type TableState } from '../src/table/types.js';
import { catchUpFactor, connectTable, createTableStore, startDirector, useDirector } from '../src/table/useTableStore.js';

// ---------------------------------------------------------------------------------------------------------
// Socket mock (connectTable)

const sock = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const handlers = new Map<string, Set<Handler>>();
  const rejoin = new Set<(view: unknown) => void>();
  const state = {
    handlers,
    rejoin,
    emitted: [] as { event: string; payload: unknown }[],
    joinResult: null as null | { view: unknown } | { error: Error },
    joined: [] as string[],
    left: [] as string[],
    socket: {
      on(event: string, h: Handler) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(h);
      },
      off(event: string, h: Handler) {
        handlers.get(event)?.delete(h);
      },
      emit(event: string, payload: unknown) {
        state.emitted.push({ event, payload });
      },
    },
    fire(event: string, payload: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    listenerCount(): number {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
  };
  return state;
});

vi.mock('../src/api/socket.js', () => ({
  getSocket: () => sock.socket,
  joinTable: (gameId: string) => {
    sock.joined.push(gameId);
    const r = sock.joinResult;
    if (r && 'error' in r) return Promise.reject(r.error);
    return Promise.resolve(r?.view);
  },
  leaveTableRoom: (gameId: string) => {
    sock.left.push(gameId);
  },
  onRejoin: (l: (view: unknown) => void) => {
    sock.rejoin.add(l);
    return () => sock.rejoin.delete(l);
  },
}));

// ---------------------------------------------------------------------------------------------------------
// Fixtures: a real engine hand, served to one viewer like the server does

const GAME = '00000000-0000-4000-8000-0000000000aa';
const OTHER_GAME = '00000000-0000-4000-8000-0000000000bb';
const PID = ['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const NAMES = ['Ana', 'Bo', 'Cy'];
const ME: SeatIndex = 2;
const SERVER_SEED = 'f'.repeat(64);
const SALT_KEY = 'e'.repeat(64);
const MAX_SEATS = 6;
const STAKES = { smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none' as const };

const SETTINGS: GameSettings = {
  kind: 'cash',
  maxSeats: MAX_SEATS,
  levels: [{ level: 1, durationMinutes: 10, ...STAKES }],
  minBuyIn: 200,
  maxBuyIn: 3000,
  startingStack: 1000,
  turnSeconds: 20,
  timeBankSeconds: 60,
  timeBankTopUpSeconds: 10,
  rebuys: { allowed: false, untilLevel: 0 },
  payouts: [100],
  seatApproval: false,
  autoStart: true,
  showAllInEquity: true,
};

function seatView(seat: SeatIndex, stack: number, extra: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: PID[seat]!,
    name: NAMES[seat]!,
    avatarUrl: null,
    stack,
    bet: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    cardsVisible: null,
    hasCards: false,
    ...extra,
  };
}

function waitingView(stacks: number[] = [1000, 1000, 1000]): TableView {
  return {
    gameId: GAME,
    settings: SETTINGS,
    status: 'running',
    seats: stacks.map((s, i) => seatView(i, s)),
    board: [],
    pots: [],
    handId: null,
    handNumber: 0,
    buttonSeat: null,
    toAct: null,
    legal: null,
    deadline: null,
    mySeat: ME,
    myHole: [],
    commitment: null,
    chat: [],
    seatRequests: [],
  };
}

/** 52-card deck with the given cards at the given positions, the rest in order. */
function deckWith(at: Record<number, string>): Card[] {
  const fixed = new Map<number, Card>(Object.entries(at).map(([p, c]) => [Number(p), parseCards(c)[0]!]));
  const used = new Set(fixed.values());
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  return Array.from({ length: 52 }, (_, p) => fixed.get(p) ?? rest.shift()!);
}

function dealOrderOf(cfg: HandConfig): SeatIndex[] {
  const d = (s: SeatIndex) => ((s - cfg.buttonSeat - 1 + cfg.maxSeats) % cfg.maxSeats) + 1;
  return cfg.seats.map((s) => s.seat).sort((a, b) => d(a) - d(b));
}

interface Served {
  sent: HandEvent[];
  engine: HandEvent[];
  state: HandState;
  final: Record<number, number>;
  total: number;
}

/** Runs a real engine hand and returns what the server sends `viewer` (redacted, filled, with card proofs). */
function serveHand(cfg: HandConfig, actions: Omit<PlayerAction, never>[], viewer: SeatIndex | null): Served {
  const commits = cardCommitments(cfg.deck, SALT_KEY);
  const order = dealOrderOf(cfg);
  const pos = dealPositions(order.length);
  const holePos = (seat: SeatIndex) => pos.hole[order.indexOf(seat)]!;
  const sent: HandEvent[] = [];
  const engine: HandEvent[] = [];
  const proofsShown = new Set<SeatIndex>();
  let boardCount = 0;
  let clock = 1_000_000;
  const proof = (p: number): HandEvent => ({ type: 'cardProof', position: p, card: cfg.deck[p]!, salt: cardSalt(SALT_KEY, p) });
  const emit = (raw: HandEvent) => {
    let e = raw;
    if (e.type === 'handStarted') e = { ...e, commitment: commit(SERVER_SEED), cardCommitments: commits };
    if (e.type === 'toAct') e = { ...e, deadline: (clock += 20_000) };
    if (e.type === 'handEnded') e = { ...e, clientSeeds: ['0'.repeat(32)], nextCommitment: 'c'.repeat(64) };
    engine.push(e);
    sent.push(e.type === 'dealHole' && e.seat !== viewer ? { ...e, cards: [] } : e);
    if (e.type === 'dealHole' && e.seat === viewer) for (const p of holePos(e.seat)) sent.push(proof(p));
    if (e.type === 'street') for (const _c of e.cards) sent.push(proof(pos.board[boardCount++]!));
    if (e.type === 'showCards' && !proofsShown.has(e.seat)) {
      proofsShown.add(e.seat);
      for (const p of holePos(e.seat)) sent.push(proof(p));
    }
  };
  let { state, events } = startHand(cfg);
  events.forEach(emit);
  for (const a of actions) {
    ({ state, events } = applyAction(state, a));
    events.forEach(emit);
  }
  if (allInRunout(state)) {
    const live = state.players.filter((p) => !p.folded);
    for (const p of live) emit({ type: 'showCards', seat: p.seat, cards: [...p.hole], handName: '' });
    const streets = ['flop', 'turn', 'river'] as const;
    let i = state.board.length === 0 ? 0 : state.board.length - 2;
    while (allInRunout(state)) {
      emit({ type: 'equity', street: streets[i++]!, equities: live.map((p) => ({ seat: p.seat, win: 1 / live.length, tie: 0 })) });
      ({ state, events } = advance(state));
      events.forEach(emit);
    }
  }
  const final: Record<number, number> = {};
  for (const p of state.players) final[p.seat] = p.stack;
  return { sent, engine, state, final, total: cfg.seats.reduce((n, s) => n + s.stack, 0) };
}

/** Hand 1: a raise, a fold, a bet on the flop and a showdown (Ana's full house beats Cy's trips). */
function hand1(): Served {
  // order (button 0): seat 1, seat 2, seat 0 → hole positions seat1 0/3, seat2 1/4, seat0 2/5; board 7 8 9 11 13
  const deck = deckWith({ 0: '7s', 3: '2d', 1: 'As', 4: '4c', 2: 'Kh', 5: 'Kd', 7: 'Ks', 8: '4d', 9: '4h', 11: '9c', 13: '2s' });
  const cfg: HandConfig = {
    handId: '00000000-0000-4000-8000-000000000101',
    handNumber: 1,
    maxSeats: MAX_SEATS,
    buttonSeat: 0,
    stakes: STAKES,
    seats: [0, 1, 2].map((seat) => ({ seat, playerId: PID[seat]!, stack: 1000 })),
    deck,
  };
  return serveHand(
    cfg,
    [
      { seat: 0, kind: 'raise', amount: 30 },
      { seat: 1, kind: 'fold' },
      { seat: 2, kind: 'call' },
      { seat: 2, kind: 'check' },
      { seat: 0, kind: 'bet', amount: 50 },
      { seat: 2, kind: 'call' },
      { seat: 2, kind: 'check' },
      { seat: 0, kind: 'check' },
      { seat: 2, kind: 'check' },
      { seat: 0, kind: 'check' },
    ],
    ME,
  );
}

/** Hand 2: three all-ins of different sizes (main pot + side pot), runout with equities. */
function hand2(stacks: Record<number, number>): Served {
  // order (button 1): seat 2, seat 0, seat 1 → seat2 0/3, seat0 1/4, seat1 2/5
  const deck = deckWith({ 0: 'Ah', 3: 'Ad', 1: 'Kc', 4: 'Ks', 2: 'Qc', 5: 'Qd', 7: '2c', 8: '7d', 9: '9h', 11: '3s', 13: '5h' });
  const cfg: HandConfig = {
    handId: '00000000-0000-4000-8000-000000000102',
    handNumber: 2,
    maxSeats: MAX_SEATS,
    buttonSeat: 1,
    stakes: STAKES,
    seats: [0, 1, 2].map((seat) => ({ seat, playerId: PID[seat]!, stack: stacks[seat]! })),
    deck,
  };
  return serveHand(
    cfg,
    [
      { seat: 1, kind: 'allIn' },
      { seat: 2, kind: 'allIn' },
      { seat: 0, kind: 'call' },
    ],
    ME,
  );
}

/** Hand 3: heads-up, the button folds the small blind; the big blind's uncalled 5 comes back. */
function hand3(stacks: Record<number, number>): Served {
  const cfg: HandConfig = {
    handId: '00000000-0000-4000-8000-000000000103',
    handNumber: 3,
    maxSeats: MAX_SEATS,
    buttonSeat: 2,
    stakes: STAKES,
    seats: [0, 2].map((seat) => ({ seat, playerId: PID[seat]!, stack: stacks[seat]! })),
    deck: Array.from({ length: 52 }, (_, i) => i),
  };
  return serveHand(cfg, [{ seat: 2, kind: 'fold' }], ME);
}

function freshStore(view = waitingView()): StoreApi<TableState> {
  const store = createTableStore();
  store.getState().applyView(view);
  return store;
}

function feed(store: StoreApi<TableState>, events: HandEvent[]): void {
  for (const e of events) store.getState().applyEvent(e);
}

function numbers(s: TableState) {
  return {
    seats: s.seats.map((v) => ({ seat: v.seat, stack: v.stack, bet: v.bet, folded: v.folded, allIn: v.allIn, hasCards: v.hasCards })),
    board: s.board,
    pots: s.pots,
  };
}

function turnData(s: TableState) {
  return { toAct: s.toAct, legal: s.legal, deadline: s.deadline };
}

function chipTotal(s: TableState): number {
  return s.seats.reduce((n, v) => n + v.stack, 0) + s.chips.reduce((n, c) => n + c.amount, 0);
}

/** Begins and consumes every queued step, calling `check` after each consume. */
function playAll(store: StoreApi<TableState>, check?: (s: TableState, step: AnimStep) => void): AnimStep[] {
  const played: AnimStep[] = [];
  for (;;) {
    const head = store.getState().queue[0];
    if (!head) return played;
    store.getState().begin(head.id);
    const step = store.getState().playing!;
    store.getState().consume(head.id);
    played.push(step);
    check?.(store.getState(), step);
  }
}

const HAND1_KINDS: StepKind[] = [
  'newHand', 'bet', 'deal',
  'turn', 'bet', 'turn', 'fold', 'turn', 'bet', 'collect',
  'board', 'turn', 'action', 'turn', 'bet', 'turn', 'bet', 'collect',
  'board', 'turn', 'action', 'turn', 'action',
  'board', 'turn', 'action', 'turn', 'action',
  'flip', 'flip', 'award', 'handEnd',
];

afterEach(() => {
  cleanup();
  __resetForTests();
});

// ---------------------------------------------------------------------------------------------------------

describe('fixtures', () => {
  it('the engine hands cover a raise, a fold, a showdown, a side pot and an uncalled return', () => {
    const h1 = hand1();
    expect(h1.engine.some((e) => e.type === 'action' && e.kind === 'raise')).toBe(true);
    expect(h1.engine.some((e) => e.type === 'action' && e.kind === 'fold')).toBe(true);
    expect(h1.engine.filter((e) => e.type === 'showCards')).toHaveLength(2);
    const h2 = hand2(h1.final);
    const pots = h2.engine.find((e) => e.type === 'potsFormed');
    expect(pots?.type === 'potsFormed' && pots.pots.length).toBe(2);
    const h3 = hand3(h2.final);
    expect(h3.engine.some((e) => e.type === 'uncalledReturned')).toBe(true);
  });
});

describe('applyEvent → queue', () => {
  it('maps hand 1 to the expected steps in order, with the right durations; proofs are never queued', () => {
    const store = freshStore();
    feed(store, hand1().sent);
    const q = store.getState().queue;
    expect(q.map((s) => s.kind)).toEqual(HAND1_KINDS);
    expect(new Set(q.map((s) => s.id)).size).toBe(q.length);
    expect(q.every((s) => s.events.every((e) => e.type !== 'cardProof'))).toBe(true);
    // blinds batched, every dealHole batched
    expect(q[1]!.events.map((e) => e.type)).toEqual(['postBlind', 'postBlind']);
    expect(q[1]!.amount).toBe(15);
    expect(q[2]!.events.map((e) => e.type)).toEqual(['dealHole', 'dealHole', 'dealHole']);
    expect(q[2]!.durationMs).toBe(STEP_MS.deal + DEAL_STAGGER_MS * 5);
    expect(q[10]!.durationMs).toBe(STEP_MS.board + DEAL_STAGGER_MS * 2); // flop
    expect(q[18]!.durationMs).toBe(STEP_MS.board); // turn card
    expect(q[9]!.durationMs).toBe(STEP_MS.collect);
    for (const s of q) {
      if (s.kind !== 'deal' && s.kind !== 'board') expect(s.durationMs).toBe(STEP_MS[s.kind]);
    }
  });

  it('maps hand 2 (all-ins, runout) to the expected steps', () => {
    const store = freshStore();
    const h1 = hand1();
    feed(store, h1.sent);
    store.getState().flush();
    feed(store, hand2(h1.final).sent);
    expect(store.getState().queue.map((s) => s.kind)).toEqual([
      'newHand', 'bet', 'deal',
      'turn', 'bet', 'turn', 'bet', 'turn', 'bet', 'collect',
      'flip', 'flip', 'flip',
      'equity', 'board', 'equity', 'board', 'equity', 'board',
      'flip', 'flip', 'muck', 'award', 'award', 'handEnd',
    ]);
  });

  it('numbers on display do not change after applyEvent nor after begin, only on consume', () => {
    const store = freshStore();
    const before = numbers(store.getState());
    const turnBefore = turnData(store.getState());
    feed(store, hand1().sent);
    expect(numbers(store.getState())).toEqual(before);
    expect(turnData(store.getState())).toEqual(turnBefore);

    let changedOnConsume = 0;
    for (;;) {
      const s0 = store.getState();
      const head = s0.queue[0];
      if (!head) break;
      const n0 = numbers(s0);
      const t0 = turnData(s0);
      s0.begin(head.id);
      const s1 = store.getState();
      expect(s1.playing?.id).toBe(head.id);
      expect(numbers(s1)).toEqual(n0);
      const actionSeat = head.events[0]?.type === 'action' ? head.events[0].seat : null;
      if (actionSeat !== null && t0.toAct === actionSeat) {
        // exception: the acting seat's turn data is cleared when its action step begins
        expect(turnData(s1)).toEqual({ toAct: null, legal: null, deadline: null });
      } else {
        expect(turnData(s1)).toEqual(t0);
      }
      s1.consume(head.id);
      if (JSON.stringify(numbers(store.getState())) !== JSON.stringify(n0)) changedOnConsume++;
    }
    expect(changedOnConsume).toBeGreaterThan(10);
  });

  it('begin only acts on the head, consume only on the playing step', () => {
    const store = freshStore();
    feed(store, hand1().sent);
    const [a, b] = store.getState().queue;
    store.getState().begin(b!.id);
    expect(store.getState().playing).toBeNull();
    store.getState().consume(a!.id);
    expect(store.getState().handId).toBeNull();
    store.getState().begin(a!.id);
    expect(store.getState().playing?.id).toBe(a!.id);
    store.getState().begin(b!.id); // something is playing
    expect(store.getState().playing?.id).toBe(a!.id);
    store.getState().consume(b!.id);
    expect(store.getState().playing?.id).toBe(a!.id);
    store.getState().consume(a!.id);
    expect(store.getState().playing).toBeNull();
    expect(store.getState().handId).toBe('00000000-0000-4000-8000-000000000101');
  });
});

describe('playing the queue', () => {
  it('after flush the stacks equal the engine, bets are 0, chips are conserved at every consume', () => {
    const store = freshStore();
    const h1 = hand1();
    const h2 = hand2(h1.final);
    const h3 = hand3(h2.final);
    for (const h of [h1, h2, h3]) {
      feed(store, h.sent);
      const played = playAll(store, (s) => expect(chipTotal(s)).toBe(3000));
      expect(played.length).toBeGreaterThan(5);
      const s = store.getState();
      for (const [seat, stack] of Object.entries(h.final)) {
        expect(s.seats.find((v) => v.seat === Number(seat))?.stack).toBe(stack);
      }
      expect(s.seats.every((v) => v.bet === 0)).toBe(true);
      expect(s.chips).toEqual([]);
      expect(s.toAct).toBeNull();
    }
    expect(h1.final).toEqual({ 0: 1085, 1: 995, 2: 920 });
    expect(h2.final).toEqual({ 0: 240, 1: 0, 2: 2760 });
  });

  it('flush() begins and consumes everything queued, in order', () => {
    const store = freshStore();
    const h1 = hand1();
    feed(store, h1.sent);
    const head = store.getState().queue[0]!;
    store.getState().begin(head.id);
    store.getState().flush();
    const s = store.getState();
    expect(s.queue).toEqual([]);
    expect(s.playing).toBeNull();
    expect(s.board).toEqual(parseCards('Ks 4d 4h 9c 2s'));
    expect(s.seats.map((v) => v.stack)).toEqual([1085, 995, 920]);
    expect(s.myHole).toEqual(parseCards('As 4c'));
    expect(s.pots).toEqual([{ amount: 0, eligible: [0, 2] }]);
  });

  it('sets the turn data on the turn step (legal only for my turn) and applies a waiting clock then', () => {
    const store = freshStore();
    feed(store, hand1().sent);
    let s = store.getState();
    // play up to (and including) the first turn: seat 0 to act
    while (s.queue[0]!.kind !== 'turn') {
      s.begin(s.queue[0]!.id);
      s.consume(store.getState().playing!.id);
      s = store.getState();
    }
    s.applyClock({ gameId: GAME, seat: 0, deadline: 42, timeBankMs: 5000, usingTimeBank: false });
    expect(store.getState().deadline).toBeNull();
    const turn = store.getState().queue[0]!;
    store.getState().begin(turn.id);
    store.getState().consume(turn.id);
    s = store.getState();
    expect(s.toAct).toBe(0);
    expect(s.legal).toBeNull(); // not my turn
    expect(s.deadline).toBe(42);
    expect(s.timeBank).toEqual({ seat: 0, ms: 5000, using: false });
    // a clock for the seat on display applies at once
    s.applyClock({ gameId: GAME, seat: 0, deadline: 99, timeBankMs: 5000, usingTimeBank: true });
    expect(store.getState().deadline).toBe(99);
    expect(store.getState().timeBank).toEqual({ seat: 0, ms: 5000, using: true });
    // later: my turn carries legal actions
    store.getState().flush();
    const store2 = freshStore();
    const sent = hand1().sent;
    const firstMine = sent.findIndex((e) => e.type === 'toAct' && e.seat === ME);
    feed(store2, sent.slice(0, firstMine + 1));
    store2.getState().flush();
    expect(store2.getState().toAct).toBe(ME);
    expect(store2.getState().legal?.seat).toBe(ME);
  });

  it('with animate: false, applyEvent applies at once', () => {
    const store = freshStore();
    store.setState({ animate: false });
    const h1 = hand1();
    feed(store, h1.sent.slice(0, 5)); // handStarted + 2 blinds + Bo's and my dealHole
    const s = store.getState();
    expect(s.queue).toEqual([]);
    expect(s.playing).toBeNull();
    expect(s.handNumber).toBe(1);
    expect(s.seats.map((v) => v.bet)).toEqual([0, 5, 10]);
    expect(s.myHole).toEqual(parseCards('As 4c'));
    feed(store, h1.sent.slice(5));
    expect(store.getState().seats.map((v) => v.stack)).toEqual([1085, 995, 920]);
  });

  it('a collect with no bet chips out lasts 0 ms when it begins', () => {
    const store = freshStore();
    store.getState().applyEvent(hand1().sent[0]!);
    store.getState().flush();
    store.getState().applyEvent({ type: 'potsFormed', pots: [{ amount: 30, eligible: [0, 1] }] });
    expect(store.getState().queue[0]!.durationMs).toBe(0);
    const id = store.getState().queue[0]!.id;
    store.getState().begin(id);
    expect(store.getState().playing!.durationMs).toBe(0);
  });
});

describe('entities', () => {
  it('cards spawn from the deck in deal order, mine face up; fold sends them to the muck; newHand clears the hand', () => {
    const store = freshStore();
    const h1 = hand1();
    feed(store, h1.sent);
    const take = (kind: StepKind) => {
      for (;;) {
        const head = store.getState().queue[0]!;
        store.getState().begin(head.id);
        if (head.kind === kind) return head;
        store.getState().consume(head.id);
      }
    };
    take('deal');
    let s = store.getState();
    const hid = '00000000-0000-4000-8000-000000000101';
    const ordered = [...s.cards].sort((a, b) => a.order - b.order);
    expect(ordered.map((c) => c.id)).toEqual([
      `card:${hid}:1:0`, `card:${hid}:2:0`, `card:${hid}:0:0`,
      `card:${hid}:1:1`, `card:${hid}:2:1`, `card:${hid}:0:1`,
    ]);
    expect(s.cards.every((c) => c.spawnFrom?.at === 'deck' && c.place.at === 'seat' && !c.fading)).toBe(true);
    const mine = s.cards.filter((c) => c.place.at === 'seat' && c.place.seat === ME);
    expect(mine.map((c) => c.card)).toEqual(parseCards('As 4c'));
    expect(mine.every((c) => c.faceUp)).toBe(true);
    const others = s.cards.filter((c) => c.place.at === 'seat' && c.place.seat !== ME);
    expect(others.every((c) => c.card === null && !c.faceUp)).toBe(true);
    expect(s.seats.every((v) => !v.hasCards)).toBe(true); // set on consume
    store.getState().consume(store.getState().playing!.id);
    expect(store.getState().seats.every((v) => v.hasCards)).toBe(true);

    // bet chips: blinds are on their bet places
    s = store.getState();
    expect(s.chips.map((c) => [c.id, c.amount]).sort()).toEqual([
      ['chips:bet:1', 5],
      ['chips:bet:2', 10],
    ]);

    // Ana raises: an incoming stack spawns at her seat, heading to her bet
    store.getState().consume(take('turn').id);
    const raise = take('bet');
    const inc = store.getState().chips.find((c) => c.id.startsWith('chips:inc:'));
    expect(inc).toEqual({ id: `chips:inc:${raise.id}`, amount: 30, place: { at: 'bet', seat: 0 }, spawnFrom: { at: 'seat', seat: 0 }, order: 0 });
    store.getState().consume(raise.id);
    expect(store.getState().chips.find((c) => c.id === 'chips:bet:0')?.amount).toBe(30);
    expect(store.getState().chips.some((c) => c.id.startsWith('chips:inc:'))).toBe(false);

    store.getState().consume(take('turn').id);
    take('fold');
    s = store.getState();
    const bo = s.cards.filter((c) => c.id.startsWith(`card:${hid}:1:`));
    expect(bo.map((c) => c.place.at)).toEqual(['muck', 'muck']);
    expect(s.seats[1]!.folded).toBe(false);
    store.getState().consume(store.getState().playing!.id);
    expect(store.getState().seats[1]).toMatchObject({ folded: true, hasCards: false });

    // collect: bets go to pot 0 at begin, become chips:pot:0 at consume
    take('collect');
    expect(store.getState().chips.filter((c) => c.id.startsWith('chips:bet:')).every((c) => c.place.at === 'pot')).toBe(true);
    store.getState().consume(store.getState().playing!.id);
    expect(store.getState().chips).toEqual([{ id: 'chips:pot:0', amount: 65, place: { at: 'pot', index: 0 }, order: 0 }]);

    take('board');
    const board = store.getState().cards.filter((c) => c.place.at === 'board');
    expect(board.map((c) => c.card)).toEqual(parseCards('Ks 4d 4h'));
    expect(board.every((c) => c.faceUp && c.spawnFrom?.at === 'deck')).toBe(true);
    expect(board.map((c) => c.order)).toEqual([0, 1, 2]);
    store.getState().consume(store.getState().playing!.id);

    // showdown: Cy shows then Ana; the award spawns at the pot and heads to Ana
    take('flip');
    store.getState().consume(store.getState().playing!.id);
    take('flip');
    const ana = store.getState().cards.filter((c) => c.id.startsWith(`card:${hid}:0:`));
    expect(ana.map((c) => c.card)).toEqual(parseCards('Kh Kd'));
    expect(ana.every((c) => c.faceUp)).toBe(true);
    store.getState().consume(store.getState().playing!.id);
    expect(store.getState().seats[0]!.cardsVisible).toEqual(parseCards('Kh Kd'));
    const award = take('award');
    expect(store.getState().chips).toEqual([
      { id: `chips:award:${award.id}:0`, amount: 165, place: { at: 'seat', seat: 0 }, spawnFrom: { at: 'pot', index: 0 }, order: 0 },
    ]);
    store.getState().consume(award.id);
    store.getState().flush();
    expect(store.getState().cards).toHaveLength(11); // the finished hand stays on display

    // next hand: the old cards go to the muck (fading) at begin and are gone at consume
    const h2 = hand2(h1.final);
    feed(store, h2.sent);
    const nh = take('newHand');
    s = store.getState();
    expect(s.cards).toHaveLength(11);
    expect(s.cards.every((c) => c.place.at === 'muck' && c.fading)).toBe(true);
    store.getState().consume(nh.id);
    s = store.getState();
    expect(s.cards).toEqual([]);
    expect(s.chips).toEqual([]);
    expect(s.board).toEqual([]);
    expect(s.pots).toEqual([]);
    expect(s.handNumber).toBe(2);
    expect(s.buttonSeat).toBe(1);
    expect(s.verified).toBe('pending');
  });

  it('hand 2: side pot awards and the runout equities', () => {
    const store = freshStore();
    const h1 = hand1();
    feed(store, h1.sent);
    store.getState().flush();
    feed(store, hand2(h1.final).sent);
    const played = playAll(store, (s, step) => {
      if (step.kind === 'collect') {
        expect(s.pots.map((p) => p.amount)).toEqual([2760, 150]);
        expect(s.chips.map((c) => [c.id, c.amount])).toEqual([
          ['chips:pot:0', 2760],
          ['chips:pot:1', 150],
        ]);
      }
      if (step.kind === 'equity') expect(Object.keys(s.allInEquity ?? {}).sort()).toEqual(['0', '1', '2']);
    });
    expect(played.filter((p) => p.kind === 'award').map((p) => p.potIndex)).toEqual([0, 1]);
    const s = store.getState();
    expect(s.seats.map((v) => v.stack)).toEqual([240, 0, 2760]);
    expect(s.seats[1]!.hasCards).toBe(false); // mucked
    const log = s.handLog.map((l) => l.text);
    expect(log).toContain('Bo goes all-in for $995');
    expect(log).toContain('Cy goes all-in for $920');
    expect(log).toContain('Ana calls $985');
    expect(log.some((t) => t.startsWith('Cy wins $2,760 with '))).toBe(true);
    expect(log.some((t) => t.startsWith('Ana wins $150 from side pot 1 with '))).toBe(true);
    const thisHand = log.slice(log.indexOf('Hand #2'));
    expect(thisHand.filter((t) => t.startsWith('Cy shows '))).toHaveLength(1); // runout show + showdown show: one line
  });

  it('hand 3: the uncalled bet comes back as a return stack', () => {
    const store = freshStore(waitingView([240, 0, 2760]));
    const h3 = hand3({ 0: 240, 2: 2760 });
    feed(store, h3.sent);
    let ret: AnimStep | null = null;
    for (;;) {
      const head = store.getState().queue[0];
      if (!head) break;
      store.getState().begin(head.id);
      if (head.kind === 'return') {
        ret = head;
        expect(store.getState().chips.find((c) => c.id === `chips:return:${head.id}`)).toEqual({
          id: `chips:return:${head.id}`,
          amount: 5,
          place: { at: 'seat', seat: 0 },
          spawnFrom: { at: 'bet', seat: 0 },
          order: 0,
        });
      }
      store.getState().consume(head.id);
      expect(chipTotal(store.getState())).toBe(3000);
    }
    expect(ret).not.toBeNull();
    expect(store.getState().seats.map((v) => v.stack)).toEqual([245, 0, 2755]);
    expect(store.getState().handLog.map((l) => l.text)).toContain('$5 returned to Ana');
  });
});

describe('applyView', () => {
  it('mid-hand: the snapshot wins, the queue is dropped and entities appear in place (no spawnFrom)', () => {
    const store = freshStore();
    feed(store, hand1().sent.slice(0, 8));
    const hb = store.getState().queue[0]!;
    store.getState().begin(hb.id);
    expect(store.getState().queue.length).toBeGreaterThan(0);
    const handId = '00000000-0000-4000-8000-000000000101';
    const view: TableView = {
      ...waitingView(),
      handId,
      handNumber: 1,
      buttonSeat: 0,
      seats: [
        seatView(0, 920, { bet: 50, hasCards: true }),
        seatView(1, 995, { folded: true }),
        seatView(2, 970, { hasCards: true, cardsVisible: parseCards('As 4c') }),
      ],
      board: parseCards('Ks 4d 4h'),
      pots: [{ amount: 65, eligible: [0, 2] }],
      toAct: 2,
      legal: { seat: 2, canFold: true, canCheck: false, callAmount: 50, canBet: false, canRaise: true, minTo: 100, maxTo: 970 },
      deadline: 123,
      myHole: parseCards('As 4c'),
      commitment: 'a'.repeat(64),
      chat: [{ gameId: GAME, id: 'm1', playerId: PID[0]!, name: 'Ana', text: 'hi', at: 1 }],
    };
    store.getState().setMyEquity({ win: 0.5, tie: 0 });
    store.getState().applyView(view);
    const s = store.getState();
    expect(s.queue).toEqual([]);
    expect(s.playing).toBeNull();
    expect(s.handLog).toEqual([]);
    expect(s.myEquity).toBeNull();
    expect(s.commitment).toBe('a'.repeat(64));
    expect(s.chat).toHaveLength(1);
    expect(s.toAct).toBe(2);
    expect(s.cards.every((c) => c.spawnFrom === undefined)).toBe(true);
    expect(s.chips.every((c) => c.spawnFrom === undefined)).toBe(true);
    expect(s.cards.map((c) => [c.id, c.card, c.faceUp])).toEqual([
      [`card:${handId}:0:0`, null, false],
      [`card:${handId}:0:1`, null, false],
      [`card:${handId}:2:0`, parseCards('As')[0], true],
      [`card:${handId}:2:1`, parseCards('4c')[0], true],
      [`card:${handId}:board:0`, parseCards('Ks')[0], true],
      [`card:${handId}:board:1`, parseCards('4d')[0], true],
      [`card:${handId}:board:2`, parseCards('4h')[0], true],
    ]);
    expect(s.chips).toEqual([
      { id: 'chips:bet:0', amount: 50, place: { at: 'bet', seat: 0 }, order: 0 },
      { id: 'chips:pot:0', amount: 65, place: { at: 'pot', index: 0 }, order: 0 },
    ]);
    expect(s.level).toEqual(SETTINGS.levels[0]);
  });
});

describe('hand log and card verification', () => {
  function playHand1(sent: HandEvent[]): TableState {
    const store = freshStore();
    store.setState({ animate: false });
    feed(store, sent);
    return store.getState();
  }

  it('writes blinds, actions, streets, shown hands, awards and ✓ Cards verified', () => {
    const h1 = hand1();
    const s = playHand1(h1.sent);
    const award = h1.engine.find((e) => e.type === 'potAwarded');
    const handName = award?.type === 'potAwarded' ? award.handName : undefined;
    expect(handName).toMatch(/^Full house/);
    expect(s.handLog.map((l) => l.text)).toEqual([
      'Hand #1',
      'Bo posts small blind $5',
      'Cy posts big blind $10',
      'You are dealt As 4c',
      'Ana raises to $30',
      'Bo folds',
      'Cy calls $20',
      'Flop: Ks 4d 4h',
      'Cy checks',
      'Ana bets $50',
      'Cy calls $50',
      'Turn: 9c',
      'Cy checks',
      'Ana checks',
      'River: 2s',
      'Cy checks',
      'Ana checks',
      expect.stringMatching(/^Cy shows As 4c \(Three of a kind/),
      `Ana shows Kh Kd (${handName})`,
      `Ana wins $165 with ${handName}`,
      VERIFIED_TEXT,
    ]);
    expect(s.handLog.at(-1)).toMatchObject({ text: '✓ Cards verified', tone: 'good' });
    expect(s.handLog.slice(0, -1).every((l) => l.tone === 'info')).toBe(true);
    expect(new Set(s.handLog.map((l) => l.id)).size).toBe(s.handLog.length);
    expect(s.verified).toBe('ok');
    expect(formatCard(s.board[0]!)).toBe('Ks');
  });

  it('a tampered salt, card or position fails the verification', () => {
    const h1 = hand1();
    const firstProof = h1.sent.findIndex((e) => e.type === 'cardProof');
    const tamper = (f: (e: Extract<HandEvent, { type: 'cardProof' }>) => HandEvent, index = firstProof) =>
      h1.sent.map((e, i) => (i === index && e.type === 'cardProof' ? f(e) : e));

    for (const sent of [
      tamper((e) => ({ ...e, salt: '0'.repeat(64) })),
      tamper((e) => ({ ...e, card: (e.card + 1) % 52 })),
      // a burn position, correctly hashed, is not a card I was shown
      tamper((e) => ({ ...e, position: 6, card: e.card })),
    ]) {
      const s = playHand1(sent);
      expect(s.handLog.at(-1)).toMatchObject({ text: VERIFY_FAILED_TEXT, tone: 'bad' });
      expect(s.verified).toBe('failed');
    }
  });

  it('a proof that hashes right but for the wrong card fails (the card shown differs)', () => {
    const h1 = hand1();
    // the server claims a different card at my first hole position, with a matching commitment
    const s = playHand1(h1.sent.map((e) => (e.type === 'dealHole' && e.seat === ME ? { ...e, cards: parseCards('Qs 4c') } : e)));
    expect(s.verified).toBe('failed');
  });

  it('missing proofs for my own hole cards fail the verification', () => {
    const h1 = hand1();
    const myPositions = new Set([1, 4]);
    const s = playHand1(h1.sent.filter((e) => !(e.type === 'cardProof' && myPositions.has(e.position))));
    expect(s.handLog.at(-1)?.text).toBe(VERIFY_FAILED_TEXT);
  });

  it('caps the hand log at 200 lines', () => {
    const store = freshStore();
    store.setState({ animate: false });
    let stacks: Record<number, number> = { 0: 1000, 1: 1000, 2: 1000 };
    for (let i = 0; i < 12; i++) {
      const h = hand1();
      feed(store, h.sent);
      stacks = h.final;
    }
    expect(stacks[0]).toBe(1085);
    const log = store.getState().handLog;
    expect(log).toHaveLength(200);
    expect(log.at(-1)?.text).toBe(VERIFIED_TEXT);
  });
});

describe('applySeats', () => {
  const newcomer: SeatView = { ...seatView(3, 500), playerId: '00000000-0000-4000-8000-000000000003', name: 'Di' };

  it('without a hand on display, takes the server values', () => {
    const store = freshStore();
    store.getState().applySeats([seatView(0, 900), seatView(1, 1000, { connected: false }), newcomer]);
    const s = store.getState();
    expect(s.seats.map((v) => [v.seat, v.stack, v.connected])).toEqual([
      [0, 900, true],
      [1, 1000, false],
      [3, 500, true],
    ]);
  });

  it('while steps are queued, keeps the displayed numbers of unchanged players; joins, leaves and flags apply at once', () => {
    const store = freshStore();
    feed(store, hand1().sent);
    playAll(store);
    feed(store, hand2({ 0: 1085, 1: 995, 2: 920 }).sent);
    const someSteps = store.getState().queue.slice(0, 6);
    for (const st of someSteps) {
      store.getState().begin(st.id);
      store.getState().consume(st.id);
    }
    const shown = store.getState().seats;
    expect(shown[1]!.bet).toBeGreaterThan(0);
    const replaced: SeatView = { ...seatView(2, 50), playerId: '00000000-0000-4000-8000-000000000009', name: 'Ed' };
    store.getState().applySeats([
      seatView(0, 240, { connected: false, sittingOut: true }),
      seatView(1, 0),
      replaced,
      newcomer,
    ]);
    const s = store.getState();
    expect(s.seats.map((v) => v.seat)).toEqual([0, 1, 2, 3]);
    expect(s.seats[0]).toMatchObject({ stack: shown[0]!.stack, bet: shown[0]!.bet, hasCards: true, connected: false, sittingOut: true });
    expect(s.seats[1]).toMatchObject({ stack: shown[1]!.stack, bet: shown[1]!.bet, hasCards: true });
    expect(s.seats[2]).toEqual(replaced);
    expect(s.seats[3]).toEqual(newcomer);
  });

  it('after a finished hand, takes stacks from the server but keeps the cards on display', () => {
    const store = freshStore();
    feed(store, hand1().sent);
    store.getState().flush();
    store.getState().applySeats([seatView(0, 2000), seatView(1, 995), seatView(2, 920)]);
    const s = store.getState();
    expect(s.seats.map((v) => v.stack)).toEqual([2000, 995, 920]);
    expect(s.seats[0]!.hasCards).toBe(true);
    expect(s.seats[0]!.cardsVisible).toEqual(parseCards('Kh Kd'));
  });
});

describe('my seat from my player id', () => {
  it('seats arriving with my player id set mySeat; leaving clears it, myHole, legal and myEquity', () => {
    const store = createTableStore();
    store.setState({ myPlayerId: PID[2]! });
    store.getState().applyView({ ...waitingView(), seats: [seatView(0, 1000), seatView(1, 1000)], mySeat: null });
    expect(store.getState().myPlayerId).toBe(PID[2]);
    expect(store.getState().mySeat).toBeNull();
    store.getState().applySeats([seatView(0, 1000), seatView(1, 1000), seatView(2, 1000)]);
    expect(store.getState().mySeat).toBe(2);
    // my cards are mine once dealt
    store.setState({ animate: false });
    feed(store, hand1().sent.slice(0, 8));
    expect(store.getState().myHole).toEqual(parseCards('As 4c'));
    store.getState().setMyEquity({ win: 0.3, tie: 0 });
    store.setState({ legal: { seat: 2, canFold: true, canCheck: false, callAmount: 10, canBet: false, canRaise: true, minTo: 20, maxTo: 1000 } });
    store.getState().applySeats([seatView(0, 1000), seatView(1, 1000)]);
    const s = store.getState();
    expect(s).toMatchObject({ mySeat: null, myHole: [], legal: null, myEquity: null });
  });

  it('without a player id, applySeats leaves mySeat alone; applyView keeps the id; reset clears it', () => {
    const store = freshStore();
    store.getState().applySeats([seatView(0, 1000)]);
    expect(store.getState().mySeat).toBe(ME);
    store.setState({ myPlayerId: PID[0]! });
    store.getState().applyView(waitingView());
    expect(store.getState().myPlayerId).toBe(PID[0]);
    expect(store.getState().mySeat).toBe(ME); // the view's mySeat wins in applyView
    store.getState().reset();
    expect(store.getState().myPlayerId).toBeNull();
  });

  it('connectTable stores my player id before the join', () => {
    sock.joinResult = { view: { ...waitingView(), mySeat: null } };
    const store = createTableStore();
    const disconnect = connectTable(GAME, store, PID[1]!);
    expect(store.getState().myPlayerId).toBe(PID[1]);
    sock.fire('table:seats', { gameId: GAME, seats: [seatView(0, 1000), seatView(1, 900)] });
    expect(store.getState().mySeat).toBe(1);
    disconnect();
    expect(store.getState().myPlayerId).toBeNull();
  });

  it('setError(null) clears lastError', () => {
    const store = freshStore();
    store.getState().setError('boom');
    expect(store.getState().lastError).toBe('boom');
    store.getState().setError(null);
    expect(store.getState().lastError).toBeNull();
  });
});

describe('other actions', () => {
  it('status, commitment, results, chat cap, errors, equity, reset', () => {
    const store = freshStore();
    const s = store.getState();
    const level = { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, anteKind: 'every' as const, durationMinutes: 10 };
    s.applyStatus({ gameId: GAME, status: 'paused', level, nextLevelAt: 5000 });
    expect(store.getState()).toMatchObject({ status: 'paused', level, nextLevelAt: 5000 });
    s.applyStatus({ gameId: GAME, status: 'running' });
    expect(store.getState()).toMatchObject({ status: 'running', level, nextLevelAt: 5000 });
    s.applyCommitment({ gameId: GAME, handNumber: 4, commitment: 'b'.repeat(64) });
    expect(store.getState().commitment).toBe('b'.repeat(64));
    s.applyResults([{ userId: PID[0]!, name: 'Ana', place: 1, prize: 0 }]);
    expect(store.getState().results).toHaveLength(1);
    for (let i = 0; i < 205; i++) s.addChat({ gameId: GAME, id: String(i), playerId: PID[0]!, name: 'Ana', text: 'x' + i, at: i });
    expect(store.getState().chat).toHaveLength(200);
    expect(store.getState().chat[0]!.id).toBe('5');
    s.setChatError('slow down');
    s.setError('boom');
    s.setMyEquity({ win: 0.4, tie: 0.1 });
    expect(store.getState()).toMatchObject({ chatError: 'slow down', lastError: 'boom', myEquity: { win: 0.4, tie: 0.1 } });
    feed(store, hand1().sent);
    s.reset();
    const r = store.getState();
    expect(r.gameId).toBeNull();
    expect(r.queue).toEqual([]);
    expect(r.seats).toEqual([]);
    expect(r.chat).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Director with a fake rAF

describe('director', () => {
  let time = 0;
  let nextHandle = 1;
  const pending = new Map<number, (t: number) => void>();

  function frames(n: number, ms = 1): void {
    act(() => {
      for (let i = 0; i < n; i++) {
        time += ms;
        const cbs = [...pending.values()];
        pending.clear();
        for (const cb of cbs) cb(time);
      }
    });
  }

  beforeEach(() => {
    time = 1000;
    pending.clear();
    __setRafForTests(
      (cb) => {
        const h = nextHandle++;
        pending.set(h, cb);
        return h;
      },
      (h) => {
        pending.delete(h);
      },
      () => time,
    );
  });

  /** Records when each step begins and is consumed (fake time). */
  function timeline(store: StoreApi<TableState>) {
    const rows: { id: number; kind: StepKind; start: number; end: number | null }[] = [];
    let cur: number | null = null;
    store.subscribe((s) => {
      if (s.playing && s.playing.id !== cur) {
        if (cur !== null) rows.find((r) => r.id === cur)!.end ??= time;
        cur = s.playing.id;
        rows.push({ id: s.playing.id, kind: s.playing.kind, start: time, end: null });
      } else if (!s.playing && cur !== null) {
        rows.find((r) => r.id === cur)!.end = time;
        cur = null;
      }
    });
    return rows;
  }

  it('plays steps in order with their durations; 0 ms steps complete in the same tick', () => {
    const store = freshStore();
    const rows = timeline(store);
    const stop = startDirector(store);
    const sent = hand1().sent;
    // up to and including the first toAct
    const upTo = sent.findIndex((e) => e.type === 'toAct');
    feed(store, sent.slice(0, upTo + 1));
    expect(store.getState().playing?.kind).toBe('newHand');
    frames(2000);
    expect(rows.map((r) => r.kind)).toEqual(['newHand', 'bet', 'deal', 'turn']);
    const dur = rows.map((r) => r.end! - r.start);
    expect(dur[0]).toBeGreaterThanOrEqual(STEP_MS.newHand);
    expect(dur[0]).toBeLessThanOrEqual(STEP_MS.newHand + 1);
    expect(dur[1]).toBeGreaterThanOrEqual(STEP_MS.bet);
    expect(dur[1]).toBeLessThanOrEqual(STEP_MS.bet + 1);
    expect(dur[2]).toBeGreaterThanOrEqual(830);
    expect(dur[2]).toBeLessThanOrEqual(831);
    expect(dur[3]).toBe(0);
    expect(rows[3]!.start).toBe(rows[2]!.end);
    expect(store.getState().toAct).toBe(0);
    // steps begin back to back
    expect(rows[1]!.start).toBe(rows[0]!.end);
    expect(rows[2]!.start).toBe(rows[1]!.end);
    stop();
  });

  it('catch-up: more than 20 waiting → quarter duration, more than 8 → half', () => {
    expect(catchUpFactor(8)).toBe(1);
    expect(catchUpFactor(9)).toBe(0.5);
    expect(catchUpFactor(20)).toBe(0.5);
    expect(catchUpFactor(21)).toBe(0.25);
    const store = freshStore();
    feed(store, hand1().sent);
    const queued = store.getState().queue.map((s) => ({ id: s.id, ms: s.durationMs }));
    expect(queued).toHaveLength(32);
    const rows = timeline(store);
    const stop = startDirector(store);
    frames(6000);
    expect(store.getState().queue).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(queued.map((q) => q.id));
    rows.forEach((r, i) => {
      const waiting = 32 - i;
      const expected = queued[i]!.ms * catchUpFactor(waiting);
      const d = r.end! - r.start;
      expect(d).toBeGreaterThanOrEqual(expected);
      expect(d).toBeLessThanOrEqual(expected === 0 ? 0 : expected + 1);
    });
    expect(store.getState().seats.map((v) => v.stack)).toEqual([1085, 995, 920]);
    stop();
  });

  it('applyView drops the playing step; the director carries on with new steps', () => {
    const store = freshStore();
    const stop = startDirector(store);
    feed(store, hand1().sent);
    frames(100);
    expect(store.getState().playing?.kind).toBe('newHand');
    store.getState().applyView(waitingView());
    expect(store.getState().playing).toBeNull();
    feed(store, hand1().sent.slice(0, 1));
    expect(store.getState().playing?.kind).toBe('newHand');
    frames(400);
    expect(store.getState().handNumber).toBe(1);
    stop();
    feed(store, hand1().sent.slice(1, 3));
    frames(400);
    expect(store.getState().playing).toBeNull();
    expect(store.getState().queue).toHaveLength(1); // stopped: nothing plays
  });

  it('useDirector plays the context store and stops on unmount', () => {
    const store = freshStore();
    const { unmount } = renderHook(() => useDirector(), {
      wrapper: ({ children }) => TableStoreProvider({ store, children }),
    });
    feed(store, hand1().sent.slice(0, 1));
    expect(store.getState().playing?.kind).toBe('newHand');
    frames(400);
    expect(store.getState().handNumber).toBe(1);
    unmount();
    feed(store, hand1().sent.slice(1, 3));
    frames(400);
    expect(store.getState().queue).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// connectTable

describe('connectTable', () => {
  beforeEach(() => {
    sock.handlers.clear();
    sock.rejoin.clear();
    sock.emitted.length = 0;
    sock.joined.length = 0;
    sock.left.length = 0;
    sock.joinResult = null;
  });

  it('joins, applies the view, wires events filtered by game id, answers commitments with a client seed', async () => {
    sock.joinResult = { view: waitingView() };
    const store = createTableStore();
    const disconnect = connectTable(GAME, store);
    expect(sock.joined).toEqual([GAME]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().gameId).toBe(GAME);
    expect(store.getState().seats).toHaveLength(3);

    sock.fire('hand:commitment', { gameId: OTHER_GAME, handNumber: 1, commitment: 'd'.repeat(64) });
    expect(sock.emitted).toEqual([]);
    sock.fire('hand:commitment', { gameId: GAME, handNumber: 1, commitment: 'c'.repeat(64) });
    expect(store.getState().commitment).toBe('c'.repeat(64));
    expect(sock.emitted).toHaveLength(1);
    const seed = sock.emitted[0]!;
    expect(seed.event).toBe('table:clientSeed');
    expect(seed.payload).toMatchObject({ gameId: GAME, handNumber: 1 });
    expect((seed.payload as { clientSeed: string }).clientSeed).toMatch(/^[0-9a-f]{32}$/);

    const sent = hand1().sent;
    sock.fire('hand:event', { gameId: OTHER_GAME, event: sent[0] });
    expect(store.getState().queue).toEqual([]);
    sock.fire('hand:event', { gameId: GAME, event: sent[0] });
    expect(store.getState().queue.map((s) => s.kind)).toEqual(['newHand']);

    sock.fire('table:clock', { gameId: OTHER_GAME, seat: 0, deadline: 1, timeBankMs: 0, usingTimeBank: false });
    sock.fire('table:status', { gameId: GAME, status: 'paused' });
    expect(store.getState().status).toBe('paused');
    sock.fire('table:status', { gameId: OTHER_GAME, status: 'finished' });
    expect(store.getState().status).toBe('paused');
    sock.fire('table:seats', { gameId: GAME, seats: [seatView(0, 1000)] });
    expect(store.getState().seats).toHaveLength(1);
    sock.fire('table:results', { gameId: GAME, results: [{ userId: PID[0], name: 'Ana', place: 1, prize: 0 }] });
    expect(store.getState().results).toHaveLength(1);
    sock.fire('chat:message', { gameId: GAME, id: 'x', playerId: PID[0], name: 'Ana', text: 'hello', at: 1 });
    sock.fire('chat:message', { gameId: OTHER_GAME, id: 'y', playerId: PID[0], name: 'Ana', text: 'elsewhere', at: 1 });
    expect(store.getState().chat.map((m) => m.id)).toEqual(['x']);
    sock.fire('error', { code: 'rate_limited', message: 'Too fast' });
    sock.fire('error', { code: 'illegal_action', message: 'Nope' });
    expect(store.getState()).toMatchObject({ chatError: 'Too fast', lastError: 'Nope' });

    // a reconnect hands over the fresh view
    const fresh = { ...waitingView([10, 20, 30]) };
    for (const l of sock.rejoin) l(fresh);
    expect(store.getState().seats.map((v) => v.stack)).toEqual([10, 20, 30]);
    sock.fire('table:view', { ...waitingView([1, 2, 3]), gameId: OTHER_GAME });
    expect(store.getState().seats.map((v) => v.stack)).toEqual([10, 20, 30]);

    disconnect();
    expect(sock.listenerCount()).toBe(0);
    expect(sock.rejoin.size).toBe(0);
    expect(sock.left).toEqual([GAME]);
    expect(store.getState().gameId).toBeNull();
    sock.fire('hand:event', { gameId: GAME, event: sent[0] });
    expect(store.getState().queue).toEqual([]);
  });

  it('a failed join sets the error', async () => {
    sock.joinResult = { error: new Error('You are not invited') };
    const store = createTableStore();
    const disconnect = connectTable(GAME, store);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().lastError).toBe('You are not invited');
    disconnect();
  });
});
