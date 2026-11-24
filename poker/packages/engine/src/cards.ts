import type { Card } from './types.js';

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export function rankOf(c: Card): number {
  return c >> 2;
}

export function suitOf(c: Card): number {
  return c & 3;
}

/** "As" -> 51, throws on bad input */
export function parseCard(s: string): Card {
  if (s.length !== 2) throw new Error(`invalid card: "${s}"`);
  const rank = RANKS.indexOf(s.charAt(0).toUpperCase());
  const suit = SUITS.indexOf(s.charAt(1).toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`invalid card: "${s}"`);
  return (rank << 2) | suit;
}

/** 51 -> "As" */
export function formatCard(c: Card): string {
  if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`invalid card: ${c}`);
  return RANKS.charAt(rankOf(c)) + SUITS.charAt(suitOf(c));
}

/** "As Kd" or "AsKd" */
export function parseCards(s: string): Card[] {
  const out: Card[] = [];
  for (const token of s.trim().split(/\s+/)) {
    if (token === '') continue;
    if (token.length % 2 !== 0) throw new Error(`invalid cards: "${s}"`);
    for (let i = 0; i < token.length; i += 2) out.push(parseCard(token.slice(i, i + 2)));
  }
  return out;
}

/** [0..51] */
export function fullDeck(): Card[] {
  return Array.from({ length: 52 }, (_, i) => i);
}
