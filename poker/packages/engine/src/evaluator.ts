/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Card } from './types.js';

export type HandCategory = 'highCard' | 'pair' | 'twoPair' | 'trips' | 'straight' | 'flush' | 'fullHouse' | 'quads' | 'straightFlush';

/** higher score wins; equal score = tie */
export interface HandValue { score: number; category: HandCategory; name: string }

export function evaluate5(cards: Card[]): HandValue {
  throw new Error('not implemented');
}

/** best 5 of 5..7 cards */
export function evaluate7(cards: Card[]): HandValue {
  throw new Error('not implemented');
}

/** >0 if a wins */
export function compare(a: HandValue, b: HandValue): number {
  throw new Error('not implemented');
}
