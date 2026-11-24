/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Card } from './types.js';

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export function rankOf(c: Card): number {
  throw new Error('not implemented');
}

export function suitOf(c: Card): number {
  throw new Error('not implemented');
}

/** "As" -> 51, throws on bad input */
export function parseCard(s: string): Card {
  throw new Error('not implemented');
}

/** 51 -> "As" */
export function formatCard(c: Card): string {
  throw new Error('not implemented');
}

/** "As Kd" or "AsKd" */
export function parseCards(s: string): Card[] {
  throw new Error('not implemented');
}

/** [0..51] */
export function fullDeck(): Card[] {
  throw new Error('not implemented');
}
