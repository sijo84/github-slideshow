import { describe, expect, it } from 'vitest';
import { computeStats, type PlayerStats } from '../src/stats.js';
import type { ActionKind, HandEvent, HandRecord, SeatIndex } from '../src/types.js';

const HERO = 'hero';
const stakes = { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' as const };

let handCounter = 0;

/** Builds a record: handStarted from `seats`, then `body`, then handEnded from `endStacks`. */
function record(
  seats: [SeatIndex, string, number][],
  body: HandEvent[],
  endStacks: Record<SeatIndex, number>,
): HandRecord {
  handCounter++;
  const handId = `h${handCounter}`;
  const playerIds: Record<SeatIndex, string> = {};
  for (const [seat, id] of seats) playerIds[seat] = id;
  const events: HandEvent[] = [
    {
      type: 'handStarted', handId, handNumber: handCounter, buttonSeat: seats[0]?.[0] ?? 0, stakes,
      seats: seats.map(([seat, playerId, stack]) => ({ seat, playerId, stack })),
      commitment: 'c', cardCommitments: [],
    },
    ...body,
    {
      type: 'handEnded',
      stacks: Object.entries(endStacks).map(([seat, stack]) => ({ seat: Number(seat), stack })),
      clientSeeds: [], nextCommitment: 'n',
    },
  ];
  return {
    handId, gameId: 'g', handNumber: handCounter, startedAt: '', endedAt: '',
    events, hole: {}, playerIds, board: [],
  };
}

const sb = (seat: SeatIndex, amount = 1): HandEvent => ({ type: 'postBlind', seat, blind: 'small', amount });
const bb = (seat: SeatIndex, amount = 2): HandEvent => ({ type: 'postBlind', seat, blind: 'big', amount });
const act = (seat: SeatIndex, kind: ActionKind, amount = 0, stackAfter = 0): HandEvent =>
  ({ type: 'action', seat, kind, amount, stackAfter });
const flop: HandEvent = { type: 'street', street: 'flop', cards: [0, 1, 2] };
const turn: HandEvent = { type: 'street', street: 'turn', cards: [3] };
const river: HandEvent = { type: 'street', street: 'river', cards: [4] };
const show = (seat: SeatIndex): HandEvent => ({ type: 'showCards', seat, cards: [], handName: 'x' });
const muck = (seat: SeatIndex): HandEvent => ({ type: 'muck', seat });
const award = (seats: SeatIndex[], amounts: number[]): HandEvent =>
  ({ type: 'potAwarded', potIndex: 0, seats, amounts });

// R1: walk. Villain SB folds, hero BB wins uncontested. Hero +1.
const walk = record([[0, 'v1', 100], [1, HERO, 100]],
  [sb(0), bb(1), act(0, 'fold'), award([1], [3])],
  { 0: 99, 1: 101 });

// R2: hero limps, calls a raise, calls a flop bet, folds the turn. Hero -16.
const limpCall = record([[0, HERO, 100], [1, 'v1', 100]],
  [sb(0), bb(1), act(0, 'call', 2), act(1, 'raise', 6), act(0, 'call', 6),
    flop, act(1, 'bet', 10), act(0, 'call', 10),
    turn, act(1, 'bet', 20), act(0, 'fold'), award([1], [52])],
  { 0: 84, 1: 116 });

// R3: hero raises preflop; flop bet + re-raise, turn bet; wins at showdown. Hero +116.
const raiseWin = record([[0, HERO, 200], [1, 'v1', 200]],
  [sb(0), bb(1), act(0, 'raise', 6), act(1, 'call', 6),
    flop, act(1, 'check'), act(0, 'bet', 8), act(1, 'raise', 24), act(0, 'raise', 60), act(1, 'call', 60),
    turn, act(1, 'check'), act(0, 'bet', 50), act(1, 'call', 50),
    river, act(1, 'check'), act(0, 'check'),
    show(0), muck(1), award([0], [232])],
  { 0: 316, 1: 84 });

// R4: hero 3-bets all-in preflop from the BB, gets called, loses at showdown. Hero -100.
const threeBetAllInLose = record([[0, 'v1', 100], [1, 'v2', 100], [2, HERO, 100]],
  [sb(1), bb(2), act(0, 'raise', 6), act(1, 'fold'), act(2, 'allIn', 100), act(0, 'call', 100),
    flop, turn, river, show(2), show(0), award([0], [201])],
  { 0: 201, 1: 99, 2: 0 });

// R5: hero calls all-in (short) preflop, wins at showdown. Hero +50.
const callAllInWin = record([[0, 'v1', 200], [1, HERO, 50]],
  [sb(0), bb(1), act(0, 'raise', 80), act(1, 'allIn', 50),
    { type: 'uncalledReturned', seat: 0, amount: 30 },
    flop, turn, river, show(1), show(0), award([1], [100])],
  { 0: 150, 1: 100 });

// R6: hero not present.
const absent = record([[0, 'v1', 100], [1, 'v2', 100]],
  [sb(0), bb(1), act(0, 'raise', 6), act(1, 'call', 6), flop, show(0), show(1), award([0], [12])],
  { 0: 106, 1: 94 });

// R7: villain limps, hero checks the BB, check down; hero loses at showdown. Hero -2.
const bbCheckLose = record([[0, 'v1', 100], [1, HERO, 100]],
  [sb(0), bb(1), act(0, 'call', 2), act(1, 'check'),
    flop, act(1, 'check'), act(0, 'check'), turn, act(1, 'check'), act(0, 'check'),
    river, act(1, 'check'), act(0, 'check'), show(1), show(0), award([0], [4])],
  { 0: 102, 1: 98 });

const ZERO: PlayerStats = { hands: 0, vpip: 0, pfr: 0, af: 0, wtsd: 0, wonAtShowdown: 0, netChips: 0 };

describe('computeStats', () => {
  it('returns all zeros for empty input', () => {
    expect(computeStats([], HERO)).toEqual(ZERO);
  });

  it('ignores records without the player', () => {
    expect(computeStats([absent], HERO)).toEqual(ZERO);
  });

  it('a walk: one hand, no VPIP, no flop', () => {
    expect(computeStats([walk], HERO)).toEqual({ ...ZERO, hands: 1, netChips: 1 });
  });

  it('limp-call then fold on the turn: VPIP, saw flop, no showdown, one postflop call', () => {
    expect(computeStats([limpCall], HERO)).toEqual({ ...ZERO, hands: 1, vpip: 1, af: 0, netChips: -16 });
  });

  it('preflop raise with postflop bets/raises and zero calls: AF = bets + raises', () => {
    expect(computeStats([raiseWin], HERO)).toEqual({
      hands: 1, vpip: 1, pfr: 1, af: 3, wtsd: 1, wonAtShowdown: 1, netChips: 116,
    });
  });

  it('aggressive all-in preflop counts for VPIP and PFR; showdown lost', () => {
    expect(computeStats([threeBetAllInLose], HERO)).toEqual({
      hands: 1, vpip: 1, pfr: 1, af: 0, wtsd: 1, wonAtShowdown: 0, netChips: -100,
    });
  });

  it('calling all-in preflop counts for VPIP but not PFR; showdown won', () => {
    expect(computeStats([callAllInWin], HERO)).toEqual({
      hands: 1, vpip: 1, pfr: 0, af: 0, wtsd: 1, wonAtShowdown: 1, netChips: 50,
    });
  });

  it('checking the big blind is not VPIP', () => {
    expect(computeStats([bbCheckLose], HERO)).toEqual({
      hands: 1, vpip: 0, pfr: 0, af: 0, wtsd: 1, wonAtShowdown: 0, netChips: -2,
    });
  });

  it('aggregates over many records', () => {
    const all = [walk, limpCall, raiseWin, threeBetAllInLose, callAllInWin, absent, bbCheckLose];
    // hands 6; VPIP R2,R3,R4,R5; PFR R3,R4; AF 3 aggressive / 1 call;
    // saw flop R2,R3,R4,R5,R7 = 5; showdowns R3,R4,R5,R7 = 4; won R3,R5 = 2.
    expect(computeStats(all, HERO)).toEqual({
      hands: 6, vpip: 4 / 6, pfr: 2 / 6, af: 3, wtsd: 4 / 5, wonAtShowdown: 2 / 4, netChips: 49,
    });
  });

  it('computes stats for other players from the same records', () => {
    // v1 in R1,R2,R3,R4,R5,R6,R7 = 7 hands.
    const s = computeStats([walk, limpCall, raiseWin, threeBetAllInLose, callAllInWin, absent, bbCheckLose], 'v1');
    expect(s.hands).toBe(7);
    expect(s.netChips).toBe(-1 + 16 - 116 + 101 - 50 + 6 + 2);
  });
});
