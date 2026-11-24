import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards.js';
import {
  advance,
  allInRunout,
  applyAction,
  board,
  dealPositions,
  holeCards,
  IllegalActionError,
  isComplete,
  legalActions,
  startHand,
  timeoutAction,
  toAct,
  type HandState,
} from '../src/hand.js';
import type { ActionKind, AnteKind, Card, HandConfig, HandEvent, SeatIndex } from '../src/types.js';

/** Places the chosen hole cards (per deal-order index) and board cards at their `dealPositions`, fills the rest. */
function buildDeck(n: number, hole: Card[][], boardCards: Card[]): Card[] {
  const pos = dealPositions(n);
  const deck: (Card | undefined)[] = new Array<Card | undefined>(52).fill(undefined);
  const used = new Set<Card>();
  const place = (p: number, c: Card): void => {
    if (used.has(c)) throw new Error(`card ${c} used twice`);
    used.add(c);
    deck[p] = c;
  };
  hole.forEach((cards, k) => cards.forEach((c, r) => place(pos.hole[k]![r]!, c)));
  boardCards.forEach((c, i) => place(pos.board[i]!, c));
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  return deck.map((c) => (c === undefined ? rest.shift()! : c));
}

interface Setup {
  stacks: number[]; // by seat 0..n-1
  button?: SeatIndex;
  sb?: number;
  bb?: number;
  ante?: number;
  anteKind?: AnteKind;
  hole?: Record<SeatIndex, string>; // by seat
  board?: string;
}

interface Game {
  state: HandState;
  events: HandEvent[];
  last: HandEvent[];
}

function dealOrder(seats: SeatIndex[], button: SeatIndex, maxSeats: number): SeatIndex[] {
  const d = (s: SeatIndex): number => ((s - button - 1 + maxSeats) % maxSeats);
  return [...seats].sort((a, b) => d(a) - d(b));
}

function setup(s: Setup): Game {
  const n = s.stacks.length;
  const seats = s.stacks.map((stack, seat) => ({ seat, playerId: `p${seat}`, stack }));
  const button = s.button ?? 0;
  const order = dealOrder(seats.map((x) => x.seat), button, 9);
  const hole = order.map((seat) => (s.hole?.[seat] !== undefined ? parseCards(s.hole[seat]) : []));
  const cfg: HandConfig = {
    handId: 'h1',
    handNumber: 1,
    maxSeats: 9,
    buttonSeat: button,
    stakes: { smallBlind: s.sb ?? 1, bigBlind: s.bb ?? 2, ante: s.ante ?? 0, anteKind: s.anteKind ?? 'none' },
    seats,
    deck: buildDeck(n, hole, s.board !== undefined ? parseCards(s.board) : []),
  };
  const r = startHand(cfg);
  return { state: r.state, events: [...r.events], last: r.events };
}

function act(g: Game, seat: SeatIndex, kind: ActionKind, amount?: number): HandEvent[] {
  const r = applyAction(g.state, amount === undefined ? { seat, kind } : { seat, kind, amount });
  g.state = r.state;
  g.events.push(...r.events);
  g.last = r.events;
  return r.events;
}

function adv(g: Game): HandEvent[] {
  const r = advance(g.state);
  g.state = r.state;
  g.events.push(...r.events);
  g.last = r.events;
  return r.events;
}

function finalStacks(g: Game): Record<SeatIndex, number> {
  const e = g.events.find((x) => x.type === 'handEnded');
  if (e?.type !== 'handEnded') throw new Error('hand not ended');
  return Object.fromEntries(e.stacks.map((s) => [s.seat, s.stack]));
}

function ofType<T extends HandEvent['type']>(events: HandEvent[], type: T): Extract<HandEvent, { type: T }>[] {
  return events.filter((e): e is Extract<HandEvent, { type: T }> => e.type === type);
}

function checkDown(g: Game): void {
  while (!isComplete(g.state)) {
    const seat = toAct(g.state);
    if (seat === null) throw new Error('no one to act');
    act(g, seat, 'check');
  }
}

const C = (s: string): Card[] => parseCards(s);

describe('dealPositions', () => {
  it('n = 2', () => {
    expect(dealPositions(2)).toEqual({ hole: [[0, 2], [1, 3]], burns: [4, 8, 10], board: [5, 6, 7, 9, 11] });
  });
  it('n = 3', () => {
    expect(dealPositions(3)).toEqual({ hole: [[0, 3], [1, 4], [2, 5]], burns: [6, 10, 12], board: [7, 8, 9, 11, 13] });
  });
  it('n = 9', () => {
    const p = dealPositions(9);
    expect(p.hole).toEqual(Array.from({ length: 9 }, (_, k) => [k, 9 + k]));
    expect(p.burns).toEqual([18, 22, 24]);
    expect(p.board).toEqual([19, 20, 21, 23, 25]);
  });
  it('dealt cards come from those deck positions (3 players, button seat 4)', () => {
    const deck = Array.from({ length: 52 }, (_, i) => 51 - i);
    const { state } = startHand({
      handId: 'x', handNumber: 1, maxSeats: 6, buttonSeat: 4,
      stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' },
      seats: [{ seat: 1, playerId: 'a', stack: 100 }, { seat: 4, playerId: 'b', stack: 100 }, { seat: 5, playerId: 'c', stack: 100 }],
      deck,
    });
    // deal order: 5, 1, 4 (button last)
    expect(holeCards(state)).toEqual({ 5: [deck[0], deck[3]], 1: [deck[1], deck[4]], 4: [deck[2], deck[5]] });
    let s = state;
    // seat 5 = SB, seat 1 = BB, seat 4 (button) acts first
    s = applyAction(s, { seat: 4, kind: 'call' }).state;
    s = applyAction(s, { seat: 5, kind: 'call' }).state;
    s = applyAction(s, { seat: 1, kind: 'check' }).state;
    expect(board(s)).toEqual([deck[7], deck[8], deck[9]]);
    for (const seat of [5, 1, 4]) s = applyAction(s, { seat, kind: 'check' }).state;
    expect(board(s)).toEqual([deck[7], deck[8], deck[9], deck[11]]);
    for (const seat of [5, 1, 4]) s = applyAction(s, { seat, kind: 'check' }).state;
    expect(board(s)).toEqual([deck[7], deck[8], deck[9], deck[11], deck[13]]);
  });
  it('heads-up: the big blind is dealt first, the button last', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const { state } = startHand({
      handId: 'x', handNumber: 1, maxSeats: 9, buttonSeat: 3,
      stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' },
      seats: [{ seat: 3, playerId: 'a', stack: 100 }, { seat: 7, playerId: 'b', stack: 100 }],
      deck,
    });
    expect(holeCards(state)).toEqual({ 7: [0, 2], 3: [1, 3] });
  });
});

describe('heads-up', () => {
  it('blinds, exact start events, button acts first preflop and the BB first postflop', () => {
    const g = setup({ stacks: [100, 100], button: 0, hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcQd' });
    expect(g.events).toEqual([
      {
        type: 'handStarted', handId: 'h1', handNumber: 1, buttonSeat: 0,
        stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' },
        seats: [{ seat: 0, playerId: 'p0', stack: 100 }, { seat: 1, playerId: 'p1', stack: 100 }],
        commitment: '', cardCommitments: [],
      },
      { type: 'postBlind', seat: 0, blind: 'small', amount: 1 },
      { type: 'postBlind', seat: 1, blind: 'big', amount: 2 },
      { type: 'dealHole', seat: 1, cards: C('KsKh') },
      { type: 'dealHole', seat: 0, cards: C('AsAh') },
      {
        type: 'toAct', seat: 0,
        legal: { seat: 0, canFold: true, canCheck: false, callAmount: 1, canBet: false, canRaise: true, minTo: 4, maxTo: 100 },
      },
    ]);
    act(g, 0, 'call');
    expect(g.last).toEqual([
      { type: 'action', seat: 0, kind: 'call', amount: 2, stackAfter: 98 },
      {
        type: 'toAct', seat: 1,
        legal: { seat: 1, canFold: true, canCheck: true, callAmount: 0, canBet: false, canRaise: true, minTo: 4, maxTo: 100 },
      },
    ]);
    act(g, 1, 'check');
    expect(g.last).toEqual([
      { type: 'action', seat: 1, kind: 'check', amount: 2, stackAfter: 98 },
      { type: 'potsFormed', pots: [{ amount: 4, eligible: [0, 1] }] },
      { type: 'street', street: 'flop', cards: C('2c7d9h') },
      {
        type: 'toAct', seat: 1,
        legal: { seat: 1, canFold: true, canCheck: true, callAmount: 0, canBet: true, canRaise: false, minTo: 2, maxTo: 98 },
      },
    ]);
    act(g, 1, 'check');
    expect(toAct(g.state)).toBe(0);
    act(g, 0, 'check');
    expect(toAct(g.state)).toBe(1); // turn: BB first again
    checkDown(g);
    expect(finalStacks(g)).toEqual({ 0: 102, 1: 98 });
  });

  it('BB option: limped pot, BB raises and the button must respond', () => {
    const g = setup({ stacks: [100, 100] });
    act(g, 0, 'call');
    act(g, 1, 'raise', 6);
    expect(toAct(g.state)).toBe(0);
    expect(legalActions(g.state, 0)).toEqual({ seat: 0, canFold: true, canCheck: false, callAmount: 4, canBet: false, canRaise: true, minTo: 10, maxTo: 100 });
    act(g, 0, 'fold');
    expect(ofType(g.last, 'uncalledReturned')).toEqual([{ type: 'uncalledReturned', seat: 1, amount: 4 }]);
    expect(finalStacks(g)).toEqual({ 0: 98, 1: 102 });
  });

  it('a player all-in for less than the SB by posting goes straight to the runout', () => {
    const g = setup({ stacks: [1, 100], sb: 2, bb: 4, hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcQd' });
    expect(ofType(g.events, 'postBlind')).toEqual([
      { type: 'postBlind', seat: 0, blind: 'small', amount: 1 },
      { type: 'postBlind', seat: 1, blind: 'big', amount: 4 },
    ]);
    expect(ofType(g.events, 'toAct')).toEqual([]);
    expect(ofType(g.events, 'uncalledReturned')).toEqual([{ type: 'uncalledReturned', seat: 1, amount: 3 }]);
    expect(ofType(g.events, 'potsFormed')).toEqual([{ type: 'potsFormed', pots: [{ amount: 2, eligible: [0, 1] }] }]);
    expect(toAct(g.state)).toBeNull();
    expect(allInRunout(g.state)).toBe(true);
    adv(g);
    adv(g);
    adv(g);
    expect(isComplete(g.state)).toBe(true);
    expect(finalStacks(g)).toEqual({ 0: 2, 1: 99 });
  });

  it('BB posts all-in short and the SB has already matched: straight to the runout', () => {
    const g = setup({ stacks: [100, 1], hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcQd' });
    expect(toAct(g.state)).toBeNull();
    expect(allInRunout(g.state)).toBe(true);
    expect(ofType(g.events, 'uncalledReturned')).toEqual([]);
    adv(g); adv(g); adv(g);
    expect(finalStacks(g)).toEqual({ 0: 101, 1: 0 });
  });

  it('a player facing an all-in with the only chips left must still call or fold, and cannot raise', () => {
    const g = setup({ stacks: [50, 1000], hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcQd' });
    act(g, 0, 'allIn');
    expect(g.last[0]).toEqual({ type: 'action', seat: 0, kind: 'allIn', amount: 50, stackAfter: 0 });
    expect(legalActions(g.state, 1)).toEqual({ seat: 1, canFold: true, canCheck: false, callAmount: 48, canBet: false, canRaise: false, minTo: 0, maxTo: 0 });
    expect(() => act(g, 1, 'raise', 200)).toThrow(IllegalActionError);
    expect(() => act(g, 1, 'allIn')).toThrow(IllegalActionError);
    act(g, 1, 'call');
    expect(allInRunout(g.state)).toBe(true);
    adv(g); adv(g); adv(g);
    expect(finalStacks(g)).toEqual({ 0: 100, 1: 950 });
  });
});

describe('preflop betting', () => {
  it('BB option in a 3-way limped pot: BB checks, flop goes to the SB', () => {
    const g = setup({ stacks: [100, 100, 100] });
    expect(toAct(g.state)).toBe(0); // button is UTG 3-handed
    act(g, 0, 'call');
    act(g, 1, 'call');
    expect(legalActions(g.state, 2)).toMatchObject({ canCheck: true, canRaise: true, minTo: 4 });
    act(g, 2, 'check');
    expect(ofType(g.last, 'street')).toEqual([{ type: 'street', street: 'flop', cards: board(g.state) }]);
    expect(toAct(g.state)).toBe(1);
  });

  it('min-raise sizing: raise to 2x, re-raise by at least the last increment, under-raise rejected', () => {
    const g = setup({ stacks: [1000, 1000, 1000, 1000], bb: 10, sb: 5 });
    // button 0, SB 1, BB 2, UTG 3
    expect(legalActions(g.state, 3)).toMatchObject({ minTo: 20, maxTo: 1000 });
    expect(() => act(g, 3, 'raise', 19)).toThrow(IllegalActionError);
    act(g, 3, 'raise', 20);
    expect(legalActions(g.state, 0)).toMatchObject({ callAmount: 20, minTo: 30 });
    expect(() => act(g, 0, 'raise', 29)).toThrow(IllegalActionError);
    act(g, 0, 'raise', 50); // increment 30
    expect(legalActions(g.state, 1)).toMatchObject({ callAmount: 45, minTo: 80 });
    expect(() => act(g, 1, 'raise', 79)).toThrow(IllegalActionError);
    act(g, 1, 'raise', 80);
    expect(legalActions(g.state, 2)).toMatchObject({ callAmount: 70, minTo: 110 });
  });

  it('a raise "to" amount is compared with the street contribution, not the stack', () => {
    const g = setup({ stacks: [100, 100, 100] });
    act(g, 0, 'raise', 6);
    act(g, 1, 'raise', 10); // SB had 1 in, puts 9 more
    expect(ofType(g.last, 'action')[0]).toEqual({ type: 'action', seat: 1, kind: 'raise', amount: 10, stackAfter: 90 });
  });

  it('all fold preflop to the BB (BB walk): SB excess returned, BB wins the blinds', () => {
    const g = setup({ stacks: [100, 100, 100, 100] });
    act(g, 3, 'fold');
    act(g, 0, 'fold');
    act(g, 1, 'fold');
    expect(g.last).toEqual([
      { type: 'action', seat: 1, kind: 'fold', amount: 1, stackAfter: 99 },
      { type: 'uncalledReturned', seat: 2, amount: 1 },
      { type: 'potsFormed', pots: [{ amount: 2, eligible: [2] }] },
      { type: 'potAwarded', potIndex: 0, seats: [2], amounts: [2] },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 100 }, { seat: 1, stack: 99 }, { seat: 2, stack: 101 }, { seat: 3, stack: 100 }], clientSeeds: [], nextCommitment: '' },
    ]);
    expect(ofType(g.events, 'showCards')).toEqual([]);
    expect(isComplete(g.state)).toBe(true);
    expect(toAct(g.state)).toBeNull();
  });

  it('all fold to a raise: uncalled raise returned, no cards shown', () => {
    const g = setup({ stacks: [100, 100, 100] });
    act(g, 0, 'raise', 7);
    act(g, 1, 'fold');
    act(g, 2, 'fold');
    expect(ofType(g.last, 'uncalledReturned')).toEqual([{ type: 'uncalledReturned', seat: 0, amount: 5 }]);
    expect(ofType(g.last, 'potAwarded')).toEqual([{ type: 'potAwarded', potIndex: 0, seats: [0], amounts: [5] }]);
    expect(finalStacks(g)).toEqual({ 0: 103, 1: 99, 2: 98 });
  });

  it('player all-in by posting less than the BB: others still match the full BB, min raise based on BB', () => {
    const g = setup({ stacks: [100, 100, 1], hole: { 0: 'AsAh', 1: 'KsKh', 2: 'QsQh' }, board: '2c7d9hJcTd' });
    expect(ofType(g.events, 'postBlind')).toEqual([
      { type: 'postBlind', seat: 1, blind: 'small', amount: 1 },
      { type: 'postBlind', seat: 2, blind: 'big', amount: 1 },
    ]);
    expect(legalActions(g.state, 0)).toMatchObject({ callAmount: 2, minTo: 4 });
    act(g, 0, 'call');
    act(g, 1, 'call');
    // BB is all-in from the blind: no option, flop is dealt
    expect(ofType(g.last, 'potsFormed')).toEqual([{ type: 'potsFormed', pots: [{ amount: 3, eligible: [0, 1, 2] }, { amount: 2, eligible: [0, 1] }] }]);
    expect(board(g.state)).toHaveLength(3);
    expect(toAct(g.state)).toBe(1);
    checkDown(g);
    expect(finalStacks(g)).toEqual({ 0: 103, 1: 98, 2: 0 });
  });
});

describe('short all-ins and reopening', () => {
  // seats: 0 button, 1 SB, 2 BB, 3 UTG. Everybody limps, BB checks; postflop order 1, 2, 3, 0.
  function toFlop(stacks: number[]): Game {
    const g = setup({ stacks });
    act(g, 3, 'call');
    act(g, 0, 'call');
    act(g, 1, 'call');
    act(g, 2, 'check');
    return g;
  }

  it('A bets 100, B all-in 150 (short), C calls: A may only call or fold', () => {
    const g = toFlop([1000, 1000, 152, 1000]);
    act(g, 1, 'bet', 100);
    act(g, 2, 'allIn');
    expect(g.last[0]).toEqual({ type: 'action', seat: 2, kind: 'allIn', amount: 150, stackAfter: 0 });
    expect(legalActions(g.state, 3)).toMatchObject({ callAmount: 150, canRaise: true, minTo: 250 });
    act(g, 3, 'call');
    act(g, 0, 'fold');
    expect(legalActions(g.state, 1)).toEqual({ seat: 1, canFold: true, canCheck: false, callAmount: 50, canBet: false, canRaise: false, minTo: 0, maxTo: 0 });
    expect(() => act(g, 1, 'raise', 300)).toThrow(IllegalActionError);
    expect(() => act(g, 1, 'allIn')).toThrow(IllegalActionError);
    act(g, 1, 'call');
    expect(ofType(g.last, 'street')[0]?.street).toBe('turn');
  });

  it('two short all-ins that together are less than a full raise still do not reopen', () => {
    const g = toFlop([1000, 1000, 152, 182]);
    act(g, 1, 'bet', 100);
    act(g, 2, 'allIn'); // 150
    act(g, 3, 'allIn'); // 180, total raise 80 < 100
    act(g, 0, 'call');
    expect(legalActions(g.state, 1)).toMatchObject({ canRaise: false, callAmount: 80 });
    act(g, 1, 'call');
    expect(ofType(g.last, 'potsFormed')[0]?.pots).toEqual([
      { amount: 8 + 600, eligible: [0, 1, 2, 3] },
      { amount: 90, eligible: [0, 1, 3] },
    ]);
  });

  it('two short all-ins that together make a full raise reopen raising (TDA cumulative rule)', () => {
    const g = toFlop([1000, 1000, 152, 212]);
    act(g, 1, 'bet', 100);
    act(g, 2, 'allIn'); // 150
    act(g, 3, 'allIn'); // 210, total raise 110 >= 100
    act(g, 0, 'call');
    expect(legalActions(g.state, 1)).toMatchObject({ canRaise: true, callAmount: 110, minTo: 310 });
  });

  it('a full-raise all-in does reopen raising', () => {
    const g = toFlop([1000, 1000, 252, 1000]);
    act(g, 1, 'bet', 100);
    act(g, 2, 'allIn'); // 250, increment 150
    act(g, 3, 'call');
    act(g, 0, 'call');
    expect(legalActions(g.state, 1)).toEqual({ seat: 1, canFold: true, canCheck: false, callAmount: 150, canBet: false, canRaise: true, minTo: 400, maxTo: 998 });
    act(g, 1, 'raise', 400);
    expect(toAct(g.state)).toBe(3);
  });

  it('bet below the min bet is rejected, but an all-in below it is allowed', () => {
    const g = toFlop([1000, 1000, 3, 1000]);
    expect(() => act(g, 1, 'bet', 1)).toThrow(IllegalActionError);
    act(g, 1, 'check');
    expect(legalActions(g.state, 2)).toMatchObject({ canBet: true, minTo: 1, maxTo: 1 });
    act(g, 2, 'bet', 1); // all-in for 1 < BB
    expect(legalActions(g.state, 3)).toMatchObject({ callAmount: 1, canRaise: true, minTo: 3 });
  });
});

describe('pots and showdown', () => {
  it('three-way side pots with different all-in sizes', () => {
    const g = setup({
      stacks: [500, 100, 300],
      hole: { 0: 'QsQh', 1: 'AsAh', 2: 'KsKh' },
      board: '2c7d9hJc3d',
    });
    act(g, 0, 'allIn');
    act(g, 1, 'allIn');
    act(g, 2, 'allIn');
    expect(g.last).toEqual([
      { type: 'action', seat: 2, kind: 'allIn', amount: 300, stackAfter: 0 },
      { type: 'uncalledReturned', seat: 0, amount: 200 },
      { type: 'potsFormed', pots: [{ amount: 300, eligible: [0, 1, 2] }, { amount: 400, eligible: [0, 2] }] },
    ]);
    expect(allInRunout(g.state)).toBe(true);
    adv(g);
    adv(g);
    adv(g);
    expect(g.last).toEqual([
      { type: 'street', street: 'river', cards: C('3d') },
      { type: 'showCards', seat: 1, cards: C('AsAh'), handName: expect.any(String) },
      { type: 'showCards', seat: 2, cards: C('KsKh'), handName: expect.any(String) },
      { type: 'muck', seat: 0 },
      { type: 'potAwarded', potIndex: 0, seats: [1], amounts: [300], handName: expect.stringContaining('Aces') },
      { type: 'potAwarded', potIndex: 1, seats: [2], amounts: [400], handName: expect.stringContaining('Kings') },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 200 }, { seat: 1, stack: 300 }, { seat: 2, stack: 400 }], clientSeeds: [], nextCommitment: '' },
    ]);
  });

  it('split pot: odd chip goes to the first eligible seat left of the button', () => {
    const g = setup({ stacks: [100, 100, 100], board: 'AsKsQsJsTs' });
    act(g, 0, 'call');
    act(g, 1, 'fold');
    act(g, 2, 'check');
    checkDown(g);
    expect(ofType(g.events, 'potAwarded')).toEqual([
      { type: 'potAwarded', potIndex: 0, seats: [0, 2], amounts: [2, 3], handName: 'Royal flush' },
    ]);
    expect(finalStacks(g)).toEqual({ 0: 100, 1: 99, 2: 101 });
  });

  it('board plays: everybody ties and every hand is shown', () => {
    const g = setup({ stacks: [100, 100, 100], board: 'AsKsQsJsTs' });
    act(g, 0, 'call');
    act(g, 1, 'call');
    act(g, 2, 'check');
    checkDown(g);
    expect(ofType(g.events, 'showCards').map((e) => e.seat)).toEqual([1, 2, 0]);
    expect(ofType(g.events, 'potAwarded')).toEqual([
      { type: 'potAwarded', potIndex: 0, seats: [0, 1, 2], amounts: [2, 2, 2], handName: 'Royal flush' },
    ]);
  });

  it('showdown order: river aggressor shows first, the losing caller mucks', () => {
    const g = setup({ stacks: [100, 100, 100], hole: { 0: 'AsAh', 1: '3c4d', 2: 'KsKh' }, board: '2c7d9hJcQd' });
    act(g, 0, 'call');
    act(g, 1, 'fold');
    act(g, 2, 'check');
    act(g, 2, 'check'); act(g, 0, 'check'); // flop
    act(g, 2, 'check'); act(g, 0, 'check'); // turn
    act(g, 2, 'check');
    act(g, 0, 'bet', 10);
    act(g, 2, 'call');
    expect(g.last).toEqual([
      { type: 'action', seat: 2, kind: 'call', amount: 10, stackAfter: 88 },
      { type: 'potsFormed', pots: [{ amount: 25, eligible: [0, 2] }] },
      { type: 'showCards', seat: 0, cards: C('AsAh'), handName: expect.any(String) },
      { type: 'muck', seat: 2 },
      { type: 'potAwarded', potIndex: 0, seats: [0], amounts: [25], handName: expect.stringContaining('Aces') },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 113 }, { seat: 1, stack: 99 }, { seat: 2, stack: 88 }], clientSeeds: [], nextCommitment: '' },
    ]);
  });

  it('showdown order without river bet: first seat left of the button shows first; later loser mucks', () => {
    const g = setup({ stacks: [100, 100, 100], hole: { 0: '3c4d', 1: 'AsAh', 2: 'KsKh' }, board: '2c7d9hJcQd' });
    act(g, 0, 'call');
    act(g, 1, 'call');
    act(g, 2, 'check');
    checkDown(g);
    expect(g.events.filter((e) => e.type === 'showCards' || e.type === 'muck').map((e) => [e.type, e.type === 'muck' || e.type === 'showCards' ? e.seat : -1])).toEqual([
      ['showCards', 1],
      ['muck', 2],
      ['muck', 0],
    ]);
    expect(finalStacks(g)).toEqual({ 0: 98, 1: 104, 2: 98 });
  });

  it('first to show loses but is shown; the winner after shows too', () => {
    const g = setup({ stacks: [100, 100], hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcQd' });
    act(g, 0, 'call');
    act(g, 1, 'check');
    checkDown(g);
    expect(ofType(g.events, 'showCards').map((e) => e.seat)).toEqual([1, 0]);
    expect(finalStacks(g)).toEqual({ 0: 102, 1: 98 });
  });

  it('folded player chips stay in the pot', () => {
    const g = setup({ stacks: [100, 100, 100], hole: { 0: 'AsAh', 1: 'KsKh', 2: 'QsQh' }, board: '2c7d9hJc3d' });
    act(g, 0, 'raise', 6);
    act(g, 1, 'call');
    act(g, 2, 'fold');
    expect(ofType(g.last, 'potsFormed')).toEqual([{ type: 'potsFormed', pots: [{ amount: 14, eligible: [0, 1] }] }]);
    checkDown(g);
    expect(finalStacks(g)).toEqual({ 0: 108, 1: 94, 2: 98 });
  });

  it('uncalled bet returned postflop', () => {
    const g = setup({ stacks: [100, 100] });
    act(g, 0, 'call');
    act(g, 1, 'check');
    act(g, 1, 'bet', 10);
    act(g, 0, 'raise', 30);
    act(g, 1, 'fold');
    expect(g.last).toEqual([
      { type: 'action', seat: 1, kind: 'fold', amount: 10, stackAfter: 88 },
      { type: 'uncalledReturned', seat: 0, amount: 20 },
      { type: 'potsFormed', pots: [{ amount: 24, eligible: [0] }] },
      { type: 'potAwarded', potIndex: 0, seats: [0], amounts: [24] },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 112 }, { seat: 1, stack: 88 }], clientSeeds: [], nextCommitment: '' },
    ]);
  });
});

describe('antes', () => {
  it('anteKind none: no antes posted even with an ante amount', () => {
    const g = setup({ stacks: [100, 100, 100], ante: 1, anteKind: 'none' });
    expect(ofType(g.events, 'postAnte')).toEqual([]);
  });

  it('every-player antes are dead money and do not count toward the street', () => {
    const g = setup({ stacks: [100, 100, 100], ante: 1, anteKind: 'every' });
    expect(ofType(g.events, 'postAnte')).toEqual([
      { type: 'postAnte', seat: 1, amount: 1 },
      { type: 'postAnte', seat: 2, amount: 1 },
      { type: 'postAnte', seat: 0, amount: 1 },
    ]);
    expect(legalActions(g.state, 0)).toMatchObject({ callAmount: 2, minTo: 4, maxTo: 99 });
    act(g, 0, 'fold');
    act(g, 1, 'fold');
    expect(g.last).toEqual([
      { type: 'action', seat: 1, kind: 'fold', amount: 1, stackAfter: 98 },
      { type: 'uncalledReturned', seat: 2, amount: 1 },
      { type: 'potsFormed', pots: [{ amount: 5, eligible: [2] }] },
      { type: 'potAwarded', potIndex: 0, seats: [2], amounts: [5] },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 99 }, { seat: 1, stack: 98 }, { seat: 2, stack: 103 }], clientSeeds: [], nextCommitment: '' },
    ]);
  });

  it('big blind ante: posted by the BB before the blind, dead money', () => {
    const g = setup({ stacks: [100, 100, 100], ante: 2, anteKind: 'bigBlind' });
    expect(g.events.filter((e) => e.type === 'postAnte' || e.type === 'postBlind')).toEqual([
      { type: 'postAnte', seat: 2, amount: 2 },
      { type: 'postBlind', seat: 1, blind: 'small', amount: 1 },
      { type: 'postBlind', seat: 2, blind: 'big', amount: 2 },
    ]);
    act(g, 0, 'call');
    act(g, 1, 'call');
    expect(legalActions(g.state, 2)).toMatchObject({ canCheck: true, callAmount: 0, maxTo: 98 });
    act(g, 2, 'check');
    expect(ofType(g.last, 'potsFormed')).toEqual([{ type: 'potsFormed', pots: [{ amount: 8, eligible: [0, 1, 2] }] }]);
  });
});

describe('all-in runout via advance', () => {
  it('preflop all-in: toAct null, allInRunout true, three advance calls', () => {
    const g = setup({ stacks: [100, 100], hole: { 0: 'AsAh', 1: 'KsKh' }, board: '2c7d9hJcKd' });
    act(g, 0, 'allIn');
    act(g, 1, 'call');
    expect(g.last).toEqual([
      { type: 'action', seat: 1, kind: 'call', amount: 100, stackAfter: 0 },
      { type: 'potsFormed', pots: [{ amount: 200, eligible: [0, 1] }] },
    ]);
    expect(toAct(g.state)).toBeNull();
    expect(allInRunout(g.state)).toBe(true);
    expect(isComplete(g.state)).toBe(false);
    expect(() => legalActions(g.state, 0)).toThrow(IllegalActionError);
    expect(adv(g)).toEqual([{ type: 'street', street: 'flop', cards: C('2c7d9h') }]);
    expect(allInRunout(g.state)).toBe(true);
    expect(adv(g)).toEqual([{ type: 'street', street: 'turn', cards: C('Jc') }]);
    expect(isComplete(g.state)).toBe(false);
    expect(adv(g)).toEqual([
      { type: 'street', street: 'river', cards: C('Kd') },
      { type: 'showCards', seat: 1, cards: C('KsKh'), handName: expect.stringContaining('Kings') },
      { type: 'muck', seat: 0 },
      { type: 'potAwarded', potIndex: 0, seats: [1], amounts: [200], handName: expect.stringContaining('Kings') },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 0 }, { seat: 1, stack: 200 }], clientSeeds: [], nextCommitment: '' },
    ]);
    expect(isComplete(g.state)).toBe(true);
    expect(allInRunout(g.state)).toBe(false);
    expect(() => advance(g.state)).toThrow(IllegalActionError);
  });

  it('advance throws when not in a runout', () => {
    const g = setup({ stacks: [100, 100] });
    expect(() => advance(g.state)).toThrow(IllegalActionError);
  });
});

describe('purity, serialisation, errors', () => {
  it('state survives a JSON round trip mid-hand', () => {
    const g = setup({ stacks: [100, 100, 100], hole: { 0: 'AsAh', 1: 'KsKh', 2: 'QsQh' }, board: '2c7d9hJc3d' });
    act(g, 0, 'raise', 6);
    act(g, 1, 'call');
    const copy = JSON.parse(JSON.stringify(g.state)) as HandState;
    const a = applyAction(g.state, { seat: 2, kind: 'call' });
    const b = applyAction(copy, { seat: 2, kind: 'call' });
    expect(b).toEqual(a);
    expect(legalActions(copy, 2)).toEqual(legalActions(g.state, 2));
    expect(toAct(copy)).toBe(toAct(g.state));
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });

  it('applyAction does not mutate its input', () => {
    const g = setup({ stacks: [100, 100] });
    const before = JSON.stringify(g.state);
    applyAction(g.state, { seat: 0, kind: 'raise', amount: 10 });
    applyAction(g.state, { seat: 0, kind: 'fold' });
    expect(JSON.stringify(g.state)).toBe(before);
    const r = applyAction(g.state, { seat: 0, kind: 'allIn' });
    const r2 = applyAction(r.state, { seat: 1, kind: 'call' });
    const s2 = JSON.stringify(r2.state);
    advance(r2.state);
    expect(JSON.stringify(r2.state)).toBe(s2);
  });

  it('illegal actions throw IllegalActionError', () => {
    const g = setup({ stacks: [100, 100, 100] });
    expect(() => act(g, 1, 'call')).toThrow(IllegalActionError); // wrong seat
    expect(() => legalActions(g.state, 1)).toThrow(IllegalActionError);
    expect(() => act(g, 0, 'check')).toThrow(IllegalActionError); // facing the BB
    expect(() => act(g, 0, 'bet', 4)).toThrow(IllegalActionError); // cannot bet preflop
    expect(() => act(g, 0, 'raise', 101)).toThrow(IllegalActionError); // above stack
    expect(() => act(g, 0, 'raise', 3)).toThrow(IllegalActionError); // under-raise
    expect(() => act(g, 0, 'raise')).toThrow(IllegalActionError); // no amount
    expect(() => act(g, 0, 'raise', 4.5)).toThrow(IllegalActionError);
    act(g, 0, 'call');
    act(g, 1, 'call');
    expect(() => act(g, 2, 'call')).toThrow(IllegalActionError); // nothing to call
    act(g, 2, 'check');
    expect(() => act(g, 1, 'bet', 1)).toThrow(IllegalActionError); // below min bet
    expect(() => act(g, 1, 'bet', 99)).toThrow(IllegalActionError); // above stack (98)
    act(g, 1, 'bet', 10);
    act(g, 2, 'fold');
    act(g, 0, 'fold');
    expect(isComplete(g.state)).toBe(true);
    expect(() => act(g, 0, 'check')).toThrow(IllegalActionError); // after completion
  });

  it('timeoutAction: check when legal, else fold', () => {
    const g = setup({ stacks: [100, 100] });
    expect(timeoutAction(g.state, 0)).toEqual({ seat: 0, kind: 'fold' });
    act(g, 0, 'call');
    expect(timeoutAction(g.state, 1)).toEqual({ seat: 1, kind: 'check' });
    expect(() => timeoutAction(g.state, 0)).toThrow(IllegalActionError);
  });

  it('startHand validates its config', () => {
    const base: HandConfig = {
      handId: 'h', handNumber: 1, maxSeats: 6, buttonSeat: 0,
      stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' },
      seats: [{ seat: 0, playerId: 'a', stack: 100 }, { seat: 1, playerId: 'b', stack: 100 }],
      deck: Array.from({ length: 52 }, (_, i) => i),
    };
    expect(() => startHand(base)).not.toThrow();
    expect(() => startHand({ ...base, seats: [base.seats[0]!] })).toThrow();
    expect(() => startHand({ ...base, seats: [base.seats[0]!, { ...base.seats[1]!, seat: 0 }] })).toThrow();
    expect(() => startHand({ ...base, seats: [base.seats[0]!, { ...base.seats[1]!, stack: 0 }] })).toThrow();
    expect(() => startHand({ ...base, deck: [...base.deck.slice(0, 51), 0] })).toThrow();
    expect(() => startHand({ ...base, deck: base.deck.slice(0, 51) })).toThrow();
    expect(() => startHand({ ...base, buttonSeat: 3 })).toThrow();
    expect(() => startHand({ ...base, seats: Array.from({ length: 7 }, (_, i) => ({ seat: i % 6, playerId: `${i}`, stack: 10 })) })).toThrow();
  });
});
