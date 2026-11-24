/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Card, HandConfig, HandEvent, LegalActions, PlayerAction, SeatIndex } from './types.js';

/** Opaque to callers; JSON-serialisable. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- opaque until E7 defines it
export interface HandState {}

export class IllegalActionError extends Error {}

export function startHand(cfg: HandConfig): { state: HandState; events: HandEvent[] } {
  throw new Error('not implemented');
}

/** null when no decision is pending */
export function toAct(state: HandState): SeatIndex | null {
  throw new Error('not implemented');
}

export function legalActions(state: HandState, seat: SeatIndex): LegalActions {
  throw new Error('not implemented');
}

export function applyAction(state: HandState, action: PlayerAction): { state: HandState; events: HandEvent[] } {
  throw new Error('not implemented');
}

export function isComplete(state: HandState): boolean {
  throw new Error('not implemented');
}

export function holeCards(state: HandState): Record<SeatIndex, Card[]> {
  throw new Error('not implemented');
}

export function board(state: HandState): Card[] {
  throw new Error('not implemented');
}

/** true when every remaining player but at most one is all-in and betting is closed */
export function allInRunout(state: HandState): boolean {
  throw new Error('not implemented');
}

/** check if legal, else fold */
export function timeoutAction(state: HandState, seat: SeatIndex): PlayerAction {
  throw new Error('not implemented');
}

/** Deal-order map (F10 / I-7). */
export function dealPositions(n: number): { hole: number[][]; burns: number[]; board: number[] } {
  throw new Error('not implemented');
}
