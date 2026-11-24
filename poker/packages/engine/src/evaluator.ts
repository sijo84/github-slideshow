import type { Card } from './types.js';

export type HandCategory = 'highCard' | 'pair' | 'twoPair' | 'trips' | 'straight' | 'flush' | 'fullHouse' | 'quads' | 'straightFlush';

/** higher score wins; equal score = tie */
export interface HandValue { score: number; category: HandCategory; name: string }

const CATEGORIES: readonly HandCategory[] = [
  'highCard', 'pair', 'twoPair', 'trips', 'straight', 'flush', 'fullHouse', 'quads', 'straightFlush',
];

const B = 13;
const CATEGORY_WEIGHT = B ** 5; // 371293

const SINGULAR = ['Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

// Scratch buffer for rank counts (module-level to avoid allocation in the hot path).
const counts = new Int8Array(13);

/**
 * Fast internal scorer: returns category * 13^5 + tiebreak ranks in base 13.
 * Tiebreak ranks are ordered by (count desc, rank desc); straights use only the top card
 * (the wheel A-2-3-4-5 counts as five-high).
 */
function score5(a: Card, b: Card, c: Card, d: Card, e: Card): number {
  const ra = a >> 2, rb = b >> 2, rc = c >> 2, rd = d >> 2, re = e >> 2;
  const flush = (a & 3) === (b & 3) && (a & 3) === (c & 3) && (a & 3) === (d & 3) && (a & 3) === (e & 3);

  counts.fill(0);
  counts[ra]++; counts[rb]++; counts[rc]++; counts[rd]++; counts[re]++;

  // Collect distinct ranks grouped by count, each group in descending rank order.
  let quad = -1, trip = -1, pairHi = -1, pairLo = -1;
  let singles = 0; // up to 5 single ranks packed descending in base 13
  let nSingles = 0;
  let mask = 0;
  for (let r = 12; r >= 0; r--) {
    const n = counts[r]!;
    if (n === 0) continue;
    mask |= 1 << r;
    if (n === 1) { singles = singles * B + r; nSingles++; }
    else if (n === 2) { if (pairHi < 0) pairHi = r; else pairLo = r; }
    else if (n === 3) trip = r;
    else quad = r;
  }

  if (nSingles === 5) {
    // Straight detection.
    let top = -1;
    for (let hi = 12; hi >= 4; hi--) {
      const m = 0x1f << (hi - 4);
      if ((mask & m) === m) { top = hi; break; }
    }
    if (top < 0 && mask === 0x100f) top = 3; // wheel: A-2-3-4-5, five-high
    if (top >= 0) return (flush ? 8 : 4) * CATEGORY_WEIGHT + top;
    return (flush ? 5 : 0) * CATEGORY_WEIGHT + singles;
  }
  if (quad >= 0) return 7 * CATEGORY_WEIGHT + quad * B + singles;
  if (trip >= 0) {
    if (pairHi >= 0) return 6 * CATEGORY_WEIGHT + trip * B + pairHi;
    return 3 * CATEGORY_WEIGHT + trip * B * B + singles;
  }
  if (pairLo >= 0) return 2 * CATEGORY_WEIGHT + pairHi * B * B + pairLo * B + singles;
  return 1 * CATEGORY_WEIGHT + pairHi * B * B * B + singles;
}

/** Decode the tiebreak digits (most significant first) for a given count of digits. */
function digits(tiebreak: number, n: number): number[] {
  const out: number[] = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = tiebreak % B;
    tiebreak = Math.floor(tiebreak / B);
  }
  return out;
}

function handName(category: HandCategory, tiebreak: number): string {
  switch (category) {
    case 'highCard': return `High card, ${SINGULAR[digits(tiebreak, 5)[0]!]}`;
    case 'pair': return `Pair of ${PLURAL[digits(tiebreak, 4)[0]!]}`;
    case 'twoPair': {
      const [hi, lo] = digits(tiebreak, 3);
      return `Two pair, ${PLURAL[hi!]} and ${PLURAL[lo!]}`;
    }
    case 'trips': return `Three of a kind, ${PLURAL[digits(tiebreak, 3)[0]!]}`;
    case 'straight': return `Straight, ${SINGULAR[tiebreak]} high`;
    case 'flush': return `Flush, ${SINGULAR[digits(tiebreak, 5)[0]!]} high`;
    case 'fullHouse': {
      const [t, p] = digits(tiebreak, 2);
      return `Full house, ${PLURAL[t!]} over ${PLURAL[p!]}`;
    }
    case 'quads': return `Four of a kind, ${PLURAL[digits(tiebreak, 2)[0]!]}`;
    case 'straightFlush': return tiebreak === 12 ? 'Royal flush' : `Straight flush, ${SINGULAR[tiebreak]} high`;
  }
}

function toHandValue(score: number): HandValue {
  const category = CATEGORIES[Math.floor(score / CATEGORY_WEIGHT)]!;
  return { score, category, name: handName(category, score % CATEGORY_WEIGHT) };
}

function checkCards(cards: Card[]): void {
  const seen = new Set<number>();
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`invalid card: ${c}`);
    if (seen.has(c)) throw new Error(`duplicate card: ${c}`);
    seen.add(c);
  }
}

/** Exactly 5 cards; throws otherwise. */
export function evaluate5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`evaluate5 needs exactly 5 cards, got ${cards.length}`);
  checkCards(cards);
  return toHandValue(score5(cards[0]!, cards[1]!, cards[2]!, cards[3]!, cards[4]!));
}

/** best 5 of 5..7 cards */
export function evaluate7(cards: Card[]): HandValue {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error(`evaluate7 needs 5..7 cards, got ${n}`);
  checkCards(cards);
  let best = -1;
  for (let i = 0; i < n - 4; i++) {
    for (let j = i + 1; j < n - 3; j++) {
      for (let k = j + 1; k < n - 2; k++) {
        for (let l = k + 1; l < n - 1; l++) {
          for (let m = l + 1; m < n; m++) {
            const s = score5(cards[i]!, cards[j]!, cards[k]!, cards[l]!, cards[m]!);
            if (s > best) best = s;
          }
        }
      }
    }
  }
  return toHandValue(best);
}

/** >0 if a wins, 0 tie, <0 if b wins */
export function compare(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}
