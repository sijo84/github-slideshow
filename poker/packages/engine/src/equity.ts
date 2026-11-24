/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Card } from './types.js';

export function equityVsRandom(hole: Card[], board: Card[], opponents: number, iterations: number, rand?: () => number): { win: number; tie: number } {
  throw new Error('not implemented');
}

export function equityExact(holes: Card[][], board: Card[]): { win: number; tie: number }[] {
  throw new Error('not implemented');
}
