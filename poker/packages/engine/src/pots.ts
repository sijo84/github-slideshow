/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Chips, Pot, SeatIndex } from './types.js';

export function buildPots(contrib: { seat: SeatIndex; total: Chips; folded: boolean }[]): Pot[] {
  throw new Error('not implemented');
}

export function splitPot(amount: Chips, winners: SeatIndex[], buttonSeat: SeatIndex, maxSeats: number): Chips[] {
  throw new Error('not implemented');
}
