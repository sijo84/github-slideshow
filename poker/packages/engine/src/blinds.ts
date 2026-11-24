/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { BlindLevel, Chips, SeatIndex, SeatInput, Stakes } from './types.js';

export function nextButton(prevButton: SeatIndex | null, occupied: SeatIndex[], maxSeats: number): SeatIndex {
  throw new Error('not implemented');
}

export function blindSeats(
  button: SeatIndex,
  dealtIn: SeatIndex[],
  maxSeats: number,
): { sb: SeatIndex; bb: SeatIndex; firstToActPreflop: SeatIndex; firstToActPostflop: SeatIndex } {
  throw new Error('not implemented');
}

export function forcedBets(
  stakes: Stakes,
  button: SeatIndex,
  dealtIn: SeatInput[],
  maxSeats: number,
): { antes: { seat: SeatIndex; amount: Chips }[]; blinds: { seat: SeatIndex; blind: 'small' | 'big'; amount: Chips }[] } {
  throw new Error('not implemented');
}

export function levelAt(levels: BlindLevel[], startedAtMs: number, nowMs: number, pausedMs: number): { index: number; msLeft: number } {
  throw new Error('not implemented');
}

/** [] if valid */
export function validateLevels(levels: BlindLevel[]): string[] {
  throw new Error('not implemented');
}
