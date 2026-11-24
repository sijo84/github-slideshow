/**
 * No-Limit Texas Hold'em hand state machine.
 *
 * All functions are pure: they never mutate the state they are given and return a fresh state plus the
 * events produced. `HandState` is plain JSON (numbers, strings, booleans, arrays, null).
 *
 * Rules implemented (see Robert's Rules of Poker §3, §6 and TDA Rules 20, 43):
 * - Deal order and deck positions follow `dealPositions` (hole cards round by round starting left of the
 *   button, then burn, flop x3, burn, turn, burn, river).
 * - Forced bets come from `forcedBets`: antes are dead money (they go into the pot but do not count toward
 *   the street contribution); blinds count. Preflop the amount to match is always the full big blind, even
 *   if the big blind posted short.
 * - The min bet is the big blind. The min raise increment is the largest full bet/raise increment of the
 *   street (preflop it starts at the big blind). An all-in for less than a full raise does not reopen
 *   raising for players who already acted; raising reopens for such a player only after a full raise, or
 *   when several short all-ins together raise the bet by at least the min raise increment over the amount
 *   that player last acted on (TDA cumulative rule). Going all-in is always allowed, even below the minimum,
 *   as long as raising is open to the player (or the all-in is just a call).
 * - When every other remaining player is all-in, a player only has to act if they have not yet matched the
 *   largest of those all-in amounts, and may then only call or fold (a raise could never be called).
 * - Uncalled chips (the top street contribution above the second highest) are returned before pots form.
 * - When betting is closed and at most one remaining player is not all-in, the hand enters the all-in
 *   runout: `toAct` is null and the caller deals the remaining streets one at a time with `advance`.
 *
 * Showdown simplification: the engine never asks players whether to show or muck. At showdown it walks the
 * showdown order (the last aggressor of the river first, otherwise the first remaining seat left of the
 * button, then clockwise) and automatically SHOWS a hand if it is the first to show or if it wins or ties at
 * least one pot (including a pot it is the only one eligible for); every other hand is automatically MUCKED.
 */
import { blindSeats, forcedBets } from './blinds.js';
import { evaluate7, type HandValue } from './evaluator.js';
import { buildPots, splitPot } from './pots.js';
import type { Card, Chips, HandConfig, HandEvent, LegalActions, PlayerAction, Pot, SeatIndex, SeatInput, Stakes } from './types.js';

type BettingStreet = 'preflop' | 'flop' | 'turn' | 'river';

export interface HandPlayer {
  seat: SeatIndex;
  playerId: string;
  stack: Chips;
  /** contribution on the current street (blinds included, antes excluded) */
  street: Chips;
  /** total contribution to the pot this hand (antes included), after uncalled returns */
  total: Chips;
  /** part of `total` that is a big-blind ante: dead money that always goes into the main pot */
  deadAnte: Chips;
  folded: boolean;
  allIn: boolean;
  /** has acted voluntarily on this street */
  acted: boolean;
  /** the street's highest bet right after this player last acted */
  actedFacing: Chips;
  /** the street's full-raise counter right after this player last acted */
  actedRaiseCount: number;
  hole: Card[];
}

/** Opaque to callers; JSON-serialisable. Players are stored in deal order (index 0 = first seat left of the button). */
export interface HandState {
  handId: string;
  handNumber: number;
  maxSeats: number;
  buttonSeat: SeatIndex;
  stakes: Stakes;
  players: HandPlayer[];
  /** the five board cards in deal order (server-side secret until dealt) */
  boardToCome: Card[];
  board: Card[];
  street: BettingStreet;
  /** highest amount to match this street */
  currentBet: Chips;
  /** min raise increment */
  minRaise: Chips;
  fullRaiseCount: number;
  lastAggressor: SeatIndex | null;
  toAct: SeatIndex | null;
  runout: boolean;
  complete: boolean;
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

/** Deal-order map (F10 / I-7). */
export function dealPositions(n: number): { hole: number[][]; burns: number[]; board: number[] } {
  if (!Number.isInteger(n) || n < 2 || n > 23) throw new Error(`dealPositions: invalid player count ${n}`);
  const hole = Array.from({ length: n }, (_, k) => [k, n + k]);
  const b = 2 * n;
  return { hole, burns: [b, b + 4, b + 6], board: [b + 1, b + 2, b + 3, b + 5, b + 7] };
}

// ---------------------------------------------------------------------------------------------------------
// helpers

function clockwiseDistance(from: SeatIndex, to: SeatIndex, maxSeats: number): number {
  const d = (((to - from) % maxSeats) + maxSeats) % maxSeats;
  return d === 0 ? maxSeats : d;
}

function clone(state: HandState): HandState {
  return JSON.parse(JSON.stringify(state)) as HandState;
}

function playerIndex(state: HandState, seat: SeatIndex): number {
  return state.players.findIndex((p) => p.seat === seat);
}

function player(state: HandState, i: number): HandPlayer {
  const p = state.players[i];
  if (p === undefined) throw new Error(`no player at index ${i}`);
  return p;
}

function othersLive(state: HandState, i: number): HandPlayer[] {
  return state.players.filter((q, j) => j !== i && !q.folded);
}

/** Amount player i has to match. */
function targetFor(state: HandState, i: number): Chips {
  const others = othersLive(state, i);
  if (others.length > 0 && others.every((q) => q.allIn)) return Math.max(...others.map((q) => q.street));
  return state.currentBet;
}

function needsToAct(state: HandState, i: number): boolean {
  const p = player(state, i);
  if (p.folded || p.allIn) return false;
  const others = othersLive(state, i);
  if (others.length === 0) return false;
  const target = targetFor(state, i);
  if (others.every((q) => q.allIn)) return p.street < target;
  return !p.acted || p.street < target;
}

function raiseOpen(state: HandState, p: HandPlayer): boolean {
  if (!p.acted) return true;
  if (state.fullRaiseCount > p.actedRaiseCount) return true;
  return state.currentBet - p.actedFacing >= state.minRaise;
}

function computeLegal(state: HandState, i: number): LegalActions {
  const p = player(state, i);
  const target = targetFor(state, i);
  const toCall = Math.max(0, target - p.street);
  const canCheck = toCall === 0;
  const callAmount = Math.min(toCall, p.stack);
  const othersWithChips = othersLive(state, i).some((q) => !q.allIn);
  const maxTo = p.stack + p.street;
  const canBet = state.currentBet === 0 && p.stack > 0 && othersWithChips;
  const canRaise = !canBet && state.currentBet > 0 && p.stack > callAmount && othersWithChips && raiseOpen(state, p);
  let minTo = 0;
  let max = 0;
  if (canBet) {
    minTo = Math.min(state.stakes.bigBlind, maxTo);
    max = maxTo;
  } else if (canRaise) {
    minTo = Math.min(state.currentBet + state.minRaise, maxTo);
    max = maxTo;
  }
  return { seat: p.seat, canFold: true, canCheck, callAmount: canCheck ? 0 : callAmount, canBet, canRaise, minTo, maxTo: max };
}

function nextToAct(state: HandState, fromIndex: number): number | null {
  const n = state.players.length;
  for (let d = 0; d < n; d++) {
    const i = (((fromIndex + d) % n) + n) % n;
    if (needsToAct(state, i)) return i;
  }
  return null;
}

function put(p: HandPlayer, amount: Chips): void {
  p.stack -= amount;
  p.street += amount;
  p.total += amount;
  if (p.stack === 0) p.allIn = true;
}

/**
 * Pots from total contributions. Every-player antes are posted by everyone, so they are layered like any
 * other contribution (a player all-in from the ante can still win the antes). A big-blind ante is posted by
 * one player for the whole table, so it is kept out of the layering and added to the main pot.
 */
function currentPots(state: HandState): Pot[] {
  const pots = buildPots(state.players.map((p) => ({ seat: p.seat, total: p.total - p.deadAnte, folded: p.folded })));
  const dead = state.players.reduce((sum, p) => sum + p.deadAnte, 0);
  if (dead > 0) {
    const main = pots[0];
    if (main === undefined) pots.push({ amount: dead, eligible: state.players.filter((p) => !p.folded).map((p) => p.seat).sort((a, b) => a - b) });
    else main.amount += dead;
  }
  return pots;
}

function emitToAct(state: HandState, events: HandEvent[], i: number | null): void {
  if (i === null) {
    state.toAct = null;
    return;
  }
  const p = player(state, i);
  state.toAct = p.seat;
  events.push({ type: 'toAct', seat: p.seat, legal: computeLegal(state, i) });
}

function handEnded(state: HandState, events: HandEvent[]): void {
  state.complete = true;
  state.runout = false;
  state.toAct = null;
  const stacks = [...state.players].sort((a, b) => a.seat - b.seat).map((p) => ({ seat: p.seat, stack: p.stack }));
  events.push({ type: 'handEnded', stacks, clientSeeds: [], nextCommitment: '' });
}

function resetStreet(state: HandState): void {
  for (const p of state.players) {
    p.street = 0;
    p.acted = false;
    p.actedFacing = 0;
    p.actedRaiseCount = 0;
  }
  state.currentBet = 0;
  state.minRaise = state.stakes.bigBlind;
  state.fullRaiseCount = 0;
  state.lastAggressor = null;
}

const NEXT_STREET: Record<BettingStreet, BettingStreet | null> = { preflop: 'flop', flop: 'turn', turn: 'river', river: null };

function dealStreet(state: HandState, events: HandEvent[]): void {
  const next = NEXT_STREET[state.street];
  if (next === null) throw new Error('no street after the river');
  const count = next === 'flop' ? 3 : 1;
  const cards = state.boardToCome.slice(state.board.length, state.board.length + count);
  state.board.push(...cards);
  state.street = next;
  resetStreet(state);
  events.push({ type: 'street', street: next, cards });
}

function awardFoldOut(state: HandState, events: HandEvent[]): void {
  const winner = state.players.find((p) => !p.folded);
  if (winner === undefined) throw new Error('no remaining player');
  currentPots(state).forEach((pot, potIndex) => {
    winner.stack += pot.amount;
    events.push({ type: 'potAwarded', potIndex, seats: [winner.seat], amounts: [pot.amount] });
  });
  handEnded(state, events);
}

function showdown(state: HandState, events: HandEvent[]): void {
  const n = state.players.length;
  let start = 0;
  if (state.street === 'river' && state.lastAggressor !== null) {
    const ai = playerIndex(state, state.lastAggressor);
    if (ai >= 0 && !player(state, ai).folded) start = ai;
  }
  const order: HandPlayer[] = [];
  for (let d = 0; d < n; d++) {
    const p = player(state, (start + d) % n);
    if (!p.folded) order.push(p);
  }
  const values = new Map<SeatIndex, HandValue>();
  for (const p of order) values.set(p.seat, evaluate7([...p.hole, ...state.board]));
  const valueOf = (seat: SeatIndex): HandValue => {
    const v = values.get(seat);
    if (v === undefined) throw new Error(`no hand value for seat ${seat}`);
    return v;
  };

  const pots = currentPots(state);
  const potWinners = pots.map((pot) => {
    const best = Math.max(...pot.eligible.map((s) => valueOf(s).score));
    return pot.eligible.filter((s) => valueOf(s).score === best).sort((a, b) => a - b);
  });
  const winning = new Set(potWinners.flat());

  order.forEach((p, k) => {
    if (k === 0 || winning.has(p.seat)) {
      events.push({ type: 'showCards', seat: p.seat, cards: [...p.hole], handName: valueOf(p.seat).name });
    } else {
      events.push({ type: 'muck', seat: p.seat });
    }
  });

  pots.forEach((pot, potIndex) => {
    const winners = potWinners[potIndex] ?? [];
    const amounts = splitPot(pot.amount, winners, state.buttonSeat, state.maxSeats);
    winners.forEach((s, k) => {
      const p = player(state, playerIndex(state, s));
      p.stack += amounts[k] ?? 0;
    });
    const first = winners[0];
    const ev: HandEvent = { type: 'potAwarded', potIndex, seats: winners, amounts };
    if (first !== undefined) ev.handName = valueOf(first).name;
    events.push(ev);
  });
  handEnded(state, events);
}

/** Called when no player needs to act on the current street. */
function endRound(state: HandState, events: HandEvent[]): void {
  state.toAct = null;
  // Uncalled bet: the top street contribution above the second highest goes back.
  const sorted = [...state.players].sort((a, b) => b.street - a.street);
  const top = sorted[0];
  const second = sorted[1];
  if (top !== undefined && second !== undefined && top.street > second.street) {
    const amount = top.street - second.street;
    top.stack += amount;
    top.street -= amount;
    top.total -= amount;
    if (top.stack > 0) top.allIn = false;
    events.push({ type: 'uncalledReturned', seat: top.seat, amount });
  }
  if (state.street === 'preflop' || state.players.some((p) => p.street > 0)) {
    events.push({ type: 'potsFormed', pots: currentPots(state) });
  }

  const live = state.players.filter((p) => !p.folded);
  if (live.length <= 1) {
    awardFoldOut(state, events);
    return;
  }
  if (state.street === 'river') {
    showdown(state, events);
    return;
  }
  const withChips = live.filter((p) => !p.allIn).length;
  if (withChips <= 1) {
    state.runout = true;
    return;
  }
  dealStreet(state, events);
  const first = nextToAct(state, 0);
  if (first === null) {
    // cannot happen: at least two players with chips must act on a new street
    endRound(state, events);
    return;
  }
  emitToAct(state, events, first);
}

// ---------------------------------------------------------------------------------------------------------
// public API

export function startHand(cfg: HandConfig): { state: HandState; events: HandEvent[] } {
  const { maxSeats, seats, deck, buttonSeat, stakes } = cfg;
  if (!Number.isInteger(maxSeats) || maxSeats < 2) throw new Error(`startHand: invalid maxSeats ${maxSeats}`);
  if (seats.length < 2 || seats.length > maxSeats) throw new Error(`startHand: need 2..${maxSeats} seats, got ${seats.length}`);
  const seen = new Set<SeatIndex>();
  for (const s of seats) {
    if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat >= maxSeats) throw new Error(`startHand: invalid seat ${s.seat}`);
    if (seen.has(s.seat)) throw new Error(`startHand: duplicate seat ${s.seat}`);
    seen.add(s.seat);
    if (!Number.isSafeInteger(s.stack) || s.stack <= 0) throw new Error(`startHand: seat ${s.seat} has invalid stack ${s.stack}`);
  }
  if (!seen.has(buttonSeat)) throw new Error(`startHand: button seat ${buttonSeat} is not dealt in`);
  if (deck.length !== 52 || new Set(deck).size !== 52 || deck.some((c) => !Number.isInteger(c) || c < 0 || c > 51)) {
    throw new Error('startHand: deck must be 52 distinct cards');
  }
  for (const k of ['smallBlind', 'bigBlind', 'ante'] as const) {
    if (!Number.isSafeInteger(stakes[k]) || stakes[k] < 0) throw new Error(`startHand: invalid ${k}`);
  }
  if (stakes.bigBlind < 1) throw new Error('startHand: big blind must be at least 1');

  const n = seats.length;
  const ordered: SeatInput[] = [...seats].sort(
    (a, b) => clockwiseDistance(buttonSeat, a.seat, maxSeats) - clockwiseDistance(buttonSeat, b.seat, maxSeats),
  );
  const pos = dealPositions(n);
  const cardAt = (i: number): Card => {
    const c = deck[i];
    if (c === undefined) throw new Error(`deck position ${i} missing`);
    return c;
  };

  const state: HandState = {
    handId: cfg.handId,
    handNumber: cfg.handNumber,
    maxSeats,
    buttonSeat,
    stakes: { ...stakes },
    players: ordered.map((s, k) => ({
      seat: s.seat,
      playerId: s.playerId,
      stack: s.stack,
      street: 0,
      total: 0,
      deadAnte: 0,
      folded: false,
      allIn: false,
      acted: false,
      actedFacing: 0,
      actedRaiseCount: 0,
      hole: (pos.hole[k] ?? []).map(cardAt),
    })),
    boardToCome: pos.board.map(cardAt),
    board: [],
    street: 'preflop',
    currentBet: 0,
    minRaise: stakes.bigBlind,
    fullRaiseCount: 0,
    lastAggressor: null,
    toAct: null,
    runout: false,
    complete: false,
  };

  const events: HandEvent[] = [
    {
      type: 'handStarted',
      handId: cfg.handId,
      handNumber: cfg.handNumber,
      buttonSeat,
      stakes: { ...stakes },
      seats: seats.map((s) => ({ ...s })),
      commitment: '',
      cardCommitments: [],
    },
  ];

  const forced = forcedBets(stakes, buttonSeat, seats, maxSeats);
  for (const a of forced.antes) {
    const p = player(state, playerIndex(state, a.seat));
    p.stack -= a.amount;
    p.total += a.amount;
    if (stakes.anteKind === 'bigBlind') p.deadAnte += a.amount;
    if (p.stack === 0) p.allIn = true;
    events.push({ type: 'postAnte', seat: a.seat, amount: a.amount });
  }
  for (const b of forced.blinds) {
    put(player(state, playerIndex(state, b.seat)), b.amount);
    events.push({ type: 'postBlind', seat: b.seat, blind: b.blind, amount: b.amount });
  }
  state.currentBet = Math.max(stakes.bigBlind, ...state.players.map((p) => p.street));

  for (const p of state.players) events.push({ type: 'dealHole', seat: p.seat, cards: [...p.hole] });

  const { firstToActPreflop } = blindSeats(buttonSeat, seats.map((s) => s.seat), maxSeats);
  const first = nextToAct(state, playerIndex(state, firstToActPreflop));
  if (first === null) endRound(state, events);
  else emitToAct(state, events, first);
  return { state, events };
}

/** null when no decision is pending */
export function toAct(state: HandState): SeatIndex | null {
  return state.complete || state.runout ? null : state.toAct;
}

export function legalActions(state: HandState, seat: SeatIndex): LegalActions {
  const pending = toAct(state);
  if (pending === null || pending !== seat) throw new IllegalActionError(`it is not seat ${seat}'s turn`);
  return computeLegal(state, playerIndex(state, seat));
}

export function applyAction(input: HandState, action: PlayerAction): { state: HandState; events: HandEvent[] } {
  if (input.complete) throw new IllegalActionError('the hand is complete');
  const legal = legalActions(input, action.seat);
  const state = clone(input);
  const i = playerIndex(state, action.seat);
  const p = player(state, i);
  const events: HandEvent[] = [];

  const raiseTo = (to: Chips): void => {
    const increment = to - state.currentBet;
    if (increment >= state.minRaise) {
      state.minRaise = increment;
      state.fullRaiseCount++;
    }
    put(p, to - p.street);
    state.currentBet = to;
    state.lastAggressor = p.seat;
  };
  const checkTo = (allowed: boolean, what: string): Chips => {
    if (!allowed) throw new IllegalActionError(`seat ${p.seat} cannot ${what} now`);
    const to = action.amount;
    if (to === undefined || !Number.isSafeInteger(to)) throw new IllegalActionError(`${what} needs an integer amount`);
    if (to !== legal.maxTo && (to < legal.minTo || to > legal.maxTo)) {
      throw new IllegalActionError(`${what} to ${to} is outside ${legal.minTo}..${legal.maxTo}`);
    }
    return to;
  };

  let kind = action.kind;
  switch (action.kind) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      if (!legal.canCheck) throw new IllegalActionError(`seat ${p.seat} cannot check facing a bet`);
      break;
    case 'call':
      if (legal.callAmount === 0) throw new IllegalActionError(`seat ${p.seat} has nothing to call`);
      put(p, legal.callAmount);
      break;
    case 'bet':
      raiseTo(checkTo(legal.canBet, 'bet'));
      break;
    case 'raise':
      raiseTo(checkTo(legal.canRaise, 'raise'));
      break;
    case 'allIn': {
      const to = p.stack + p.street;
      if (p.stack <= legal.callAmount && !legal.canCheck) put(p, p.stack);
      else if (legal.canBet || legal.canRaise) raiseTo(to);
      else throw new IllegalActionError(`seat ${p.seat} cannot go all-in now`);
      kind = 'allIn';
      break;
    }
    default:
      throw new IllegalActionError(`unknown action kind`);
  }
  p.acted = true;
  p.actedFacing = state.currentBet;
  p.actedRaiseCount = state.fullRaiseCount;
  events.push({ type: 'action', seat: p.seat, kind, amount: p.street, stackAfter: p.stack });

  if (state.players.filter((q) => !q.folded).length <= 1) {
    endRound(state, events);
    return { state, events };
  }
  const next = nextToAct(state, i + 1);
  if (next === null) endRound(state, events);
  else emitToAct(state, events, next);
  return { state, events };
}

/** During an all-in runout, deals the next street (and after the river finishes the hand). */
export function advance(input: HandState): { state: HandState; events: HandEvent[] } {
  if (!allInRunout(input)) throw new IllegalActionError('advance is only allowed during an all-in runout');
  const state = clone(input);
  const events: HandEvent[] = [];
  dealStreet(state, events);
  if (state.street === 'river') showdown(state, events);
  return { state, events };
}

export function isComplete(state: HandState): boolean {
  return state.complete;
}

export function holeCards(state: HandState): Record<SeatIndex, Card[]> {
  const out: Record<SeatIndex, Card[]> = {};
  for (const p of state.players) out[p.seat] = [...p.hole];
  return out;
}

export function board(state: HandState): Card[] {
  return [...state.board];
}

/** true when every remaining player but at most one is all-in and betting is closed, and the hand is not complete */
export function allInRunout(state: HandState): boolean {
  return state.runout && !state.complete;
}

/** check if legal, else fold */
export function timeoutAction(state: HandState, seat: SeatIndex): PlayerAction {
  const legal = legalActions(state, seat);
  return legal.canCheck ? { seat, kind: 'check' } : { seat, kind: 'fold' };
}
