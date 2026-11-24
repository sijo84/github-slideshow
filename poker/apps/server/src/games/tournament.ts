/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { BlindLevel } from '@poker/engine';
import type { GameSettings, ResultEntry } from '@poker/protocol';
import type { Pool } from 'pg';

export interface TournamentControllerLike {
  levelFor(now: number): BlindLevel;
  /** When the current level ends (ms epoch), or null on the last level. */
  nextLevelAt(now: number): number | null;
  onHandEnded(
    stacks: { userId: string; startStack: number; endStack: number }[],
    now: number,
  ): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }>;
  canRebuy(userId: string, now: number): boolean;
  /** Chips added to the stack. */
  rebuy(userId: string, now: number): Promise<number>;
  results(): Promise<ResultEntry[]>;
}

export class TournamentController implements TournamentControllerLike {
  constructor(deps: { pool: Pool; gameId: string; settings: GameSettings; startedAtMs: number; pausedMs: () => number }) {}

  levelFor(now: number): BlindLevel {
    throw new Error('not implemented');
  }

  nextLevelAt(now: number): number | null {
    throw new Error('not implemented');
  }

  async onHandEnded(
    stacks: { userId: string; startStack: number; endStack: number }[],
    now: number,
  ): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }> {
    throw new Error('not implemented');
  }

  canRebuy(userId: string, now: number): boolean {
    throw new Error('not implemented');
  }

  async rebuy(userId: string, now: number): Promise<number> {
    throw new Error('not implemented');
  }

  async results(): Promise<ResultEntry[]> {
    throw new Error('not implemented');
  }
}

/** finishOrder: best first; an inner array is a tie. */
export function prizes(
  prizePool: number,
  payouts: number[],
  finishOrder: string[][],
): { userId: string; place: number; prize: number }[] {
  throw new Error('not implemented');
}
