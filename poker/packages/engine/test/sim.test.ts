import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  advance,
  allInRunout,
  applyAction,
  board,
  IllegalActionError,
  isComplete,
  legalActions,
  startHand,
  toAct,
  type HandState,
} from '../src/hand.js';
import type { AnteKind, Card, HandEvent, PlayerAction, SeatIndex } from '../src/types.js';

/** Small deterministic PRNG for action choices (seeded from fast-check). */
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

/** Fisher-Yates driven by fast-check generated keys. */
function shuffle(keys: number[]): Card[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = (keys[51 - i] ?? 0) % (i + 1);
    const t = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = t;
  }
  return deck;
}

const handArb = fc.record({
  seats: fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7, 8], { minLength: 2, maxLength: 9 }),
  stacks: fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 9, maxLength: 9 }),
  buttonPick: fc.nat({ max: 8 }),
  bigBlind: fc.integer({ min: 1, max: 400 }),
  sbPick: fc.nat(),
  antePick: fc.nat(),
  anteKind: fc.constantFrom<AnteKind>('none', 'every', 'bigBlind'),
  shuffleKeys: fc.array(fc.nat({ max: 0x7fffffff }), { minLength: 51, maxLength: 51 }),
  actionSeed: fc.nat({ max: 0x7fffffff }),
  shortStackBias: fc.boolean(),
});

type HandInput = typeof handArb extends fc.Arbitrary<infer T> ? T : never;

function chipsInPlay(state: HandState): number {
  return state.players.reduce((sum, p) => sum + p.stack + (isComplete(state) ? 0 : p.total), 0);
}

function expectIllegal(state: HandState, action: PlayerAction): void {
  expect(() => applyAction(state, action), JSON.stringify(action)).toThrow(IllegalActionError);
}

function playHand(input: HandInput): void {
  const seatList = [...input.seats].sort((a, b) => a - b);
  const seats = seatList.map((seat, i) => {
    let stack = input.stacks[i] ?? 1;
    if (input.shortStackBias) stack = 1 + (stack % (3 * input.bigBlind));
    return { seat, playerId: `p${seat}`, stack };
  });
  const initial = seats.reduce((s, x) => s + x.stack, 0);
  const smallBlind = 1 + (input.sbPick % input.bigBlind);
  const ante = input.anteKind === 'none' ? 0 : input.antePick % (input.bigBlind + 1);
  const button = seatList[input.buttonPick % seatList.length]!;
  const rand = mulberry32(input.actionSeed);
  const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

  const started = startHand({
    handId: 'sim', handNumber: 1, maxSeats: 9, buttonSeat: button,
    stakes: { smallBlind, bigBlind: input.bigBlind, ante, anteKind: input.anteKind },
    seats, deck: shuffle(input.shuffleKeys),
  });
  let state = started.state;
  const events: HandEvent[] = [...started.events];

  const check = (): void => {
    expect(chipsInPlay(state)).toBe(initial);
    for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
    const t = toAct(state);
    if (t === null) expect(isComplete(state) || allInRunout(state)).toBe(true);
    else expect(isComplete(state) || allInRunout(state)).toBe(false);
  };
  check();

  let steps = 0;
  while (!isComplete(state)) {
    if (++steps > 1000) throw new Error('hand did not complete');
    if (rand() < 0.1) state = JSON.parse(JSON.stringify(state)) as HandState;
    const seat: SeatIndex | null = toAct(state);
    if (seat === null) {
      expect(allInRunout(state)).toBe(true);
      const r = advance(state);
      state = r.state;
      events.push(...r.events);
      check();
      continue;
    }
    const legal = legalActions(state, seat);
    const me = state.players.find((p) => p.seat === seat)!;
    expect(legal.callAmount).toBeLessThanOrEqual(me.stack);
    const sizing = legal.canBet ? 'bet' : legal.canRaise ? 'raise' : null;

    // Out-of-bounds actions must throw.
    if (!legal.canCheck) expectIllegal(state, { seat, kind: 'check' });
    if (legal.canCheck) expectIllegal(state, { seat, kind: 'call' });
    if (!legal.canBet) expectIllegal(state, { seat, kind: 'bet', amount: Math.max(legal.minTo, input.bigBlind) });
    if (!legal.canRaise) expectIllegal(state, { seat, kind: 'raise', amount: me.street + me.stack });
    if (sizing !== null) {
      expect(legal.minTo).toBeLessThanOrEqual(legal.maxTo);
      expect(legal.maxTo).toBe(me.street + me.stack);
      expectIllegal(state, { seat, kind: sizing, amount: legal.maxTo + 1 });
      if (legal.minTo - 1 !== legal.maxTo) expectIllegal(state, { seat, kind: sizing, amount: legal.minTo - 1 });
    } else {
      expect(legal.minTo).toBe(0);
      expect(legal.maxTo).toBe(0);
      if (me.stack > legal.callAmount) expectIllegal(state, { seat, kind: 'allIn' });
    }
    // Another seat acting must throw.
    const other = state.players.find((p) => p.seat !== seat)!;
    expectIllegal(state, { seat: other.seat, kind: 'fold' });

    // Every action derived from legalActions must be accepted.
    const candidates: PlayerAction[] = [{ seat, kind: 'fold' }];
    if (legal.canCheck) candidates.push({ seat, kind: 'check' }, { seat, kind: 'check' }, { seat, kind: 'check' });
    if (legal.callAmount > 0) candidates.push({ seat, kind: 'call' }, { seat, kind: 'call' }, { seat, kind: 'call' });
    if (sizing !== null) {
      candidates.push(
        { seat, kind: sizing, amount: legal.minTo },
        { seat, kind: sizing, amount: legal.maxTo },
        { seat, kind: sizing, amount: randInt(legal.minTo, legal.maxTo) },
      );
    }
    if (sizing !== null || (legal.callAmount > 0 && legal.callAmount === me.stack)) candidates.push({ seat, kind: 'allIn' });
    for (const c of candidates) expect(() => applyAction(state, c), JSON.stringify(c)).not.toThrow();

    const chosen = candidates[randInt(0, candidates.length - 1)]!;
    const before = JSON.stringify(state);
    const r = applyAction(state, chosen);
    expect(JSON.stringify(state)).toBe(before);
    state = r.state;
    events.push(...r.events);
    check();
  }

  // End of hand.
  const ended = events.filter((e) => e.type === 'handEnded');
  expect(ended).toHaveLength(1);
  const last = ended[0]!;
  if (last.type === 'handEnded') {
    expect(last.stacks.reduce((s, x) => s + x.stack, 0)).toBe(initial);
    expect(last.stacks.map((s) => s.seat)).toEqual(seatList);
  }
  if (events.some((e) => e.type === 'showCards' || e.type === 'muck')) expect(board(state)).toHaveLength(5);

  // Chips put in == chips awarded + returned.
  const stack = new Map(seats.map((s) => [s.seat, s.stack]));
  let putIn = 0;
  let paidOut = 0;
  for (const e of events) {
    if (e.type === 'postAnte' || e.type === 'postBlind') {
      putIn += e.amount;
      stack.set(e.seat, stack.get(e.seat)! - e.amount);
    } else if (e.type === 'action') {
      putIn += stack.get(e.seat)! - e.stackAfter;
      stack.set(e.seat, e.stackAfter);
    } else if (e.type === 'uncalledReturned') {
      paidOut += e.amount;
      stack.set(e.seat, stack.get(e.seat)! + e.amount);
    } else if (e.type === 'potAwarded') {
      expect(e.amounts).toHaveLength(e.seats.length);
      paidOut += e.amounts.reduce((s, x) => s + x, 0);
    }
    expect(e.type).not.toBe('equity');
    expect(e.type).not.toBe('cardProof');
  }
  expect(paidOut).toBe(putIn);
}

describe('hand simulation', () => {
  it('random hands keep every invariant', () => {
    const handsPerRun = 10;
    fc.assert(
      fc.property(fc.array(handArb, { minLength: handsPerRun, maxLength: handsPerRun }), (hands) => {
        for (const h of hands) playHand(h);
      }),
      { numRuns: 220, seed: 20261124 },
    );
  }, 120_000);
});
