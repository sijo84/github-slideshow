/**
 * Chip stacks (W7). Breaks an amount into physical chip stacks for the 3D table.
 *
 * Limits: at most MAX_STACKS stacks of at most MAX_PER_STACK chips each. Within those limits the total
 * shown is as close to the amount as possible, and exact whenever an exact picture exists. Among equally
 * close pictures the one with the most large chips wins ("largest denominations first", compared from the
 * largest denomination down). The big blind picks the smallest *useful* denomination: a picture that needs
 * no chip below it is preferred over one that does, so tiny chips only appear when the amount needs them
 * to be exact. A denomination may fill more than one stack (e.g. 15 × $5 = a stack of 10 and one of 5).
 *
 * Huge amounts: the most the limits can show is 6 × 10 × $100k = $6,000,000. Anything at or above that is
 * drawn as that cap (six full $100k stacks); the label next to the stack still shows the real amount.
 */
import type { Chips } from '@poker/engine';

export interface ChipStack {
  denom: number;
  color: string;
  count: number;
}

export const MAX_STACKS = 6;
export const MAX_PER_STACK = 10;

/** Denominations, smallest first, with their chip colours. */
export const CHIP_DENOMS: readonly { denom: number; color: string; name: string }[] = [
  { denom: 1, color: '#f4f1e8', name: 'white' },
  { denom: 5, color: '#c8312b', name: 'red' },
  { denom: 25, color: '#2f8f46', name: 'green' },
  { denom: 100, color: '#1b1b1d', name: 'black' },
  { denom: 500, color: '#6c3fa0', name: 'purple' },
  { denom: 1_000, color: '#e2b93b', name: 'yellow' },
  { denom: 5_000, color: '#e07ab0', name: 'pink' },
  { denom: 25_000, color: '#2f63c4', name: 'blue' },
  { denom: 100_000, color: '#8f969c', name: 'grey' },
];

const DENOMS_DESC = [...CHIP_DENOMS].reverse();

/** Largest amount the stack limits can draw. */
export const MAX_DRAWN = MAX_STACKS * MAX_PER_STACK * 100_000;

export function chipColor(denom: number): string {
  const d = CHIP_DENOMS.find((x) => x.denom === denom);
  if (!d) throw new Error(`Unknown chip denomination ${denom}`);
  return d.color;
}

/** Smallest useful denomination for a big blind: the largest one that is ≤ a quarter of the big blind
 *  (so a big blind is at least about four of the smallest chips), never below $1. */
export function smallestUsefulDenom(bigBlind: Chips): number {
  let best = 1;
  for (const { denom } of CHIP_DENOMS) if (denom * 4 <= bigBlind) best = denom;
  return best;
}

const stacksFor = (count: number): number => Math.ceil(count / MAX_PER_STACK);

/**
 * Exact search over `denoms` (largest first). Counts are tried from high to low at each level, so the first
 * exact picture found is the one with the most large chips. `failed` memoises (level, stacks left, rest).
 */
function exact(denoms: readonly number[], amount: number): number[] | null {
  const counts = new Array<number>(denoms.length).fill(0);
  const failed = new Set<string>();
  // Most the denominations from i down can hold in s stacks.
  const capFrom = (i: number, s: number): number => (i < denoms.length ? s * MAX_PER_STACK * denoms[i]! : 0);

  const go = (i: number, stacksLeft: number, rest: number): boolean => {
    if (rest === 0) return true;
    if (i >= denoms.length || stacksLeft === 0) return false;
    if (rest > capFrom(i, stacksLeft)) return false;
    const key = `${i}:${stacksLeft}:${rest}`;
    if (failed.has(key)) return false;
    const d = denoms[i]!;
    const hi = Math.min(Math.floor(rest / d), stacksLeft * MAX_PER_STACK);
    for (let c = hi; c >= 0; c--) {
      const left = stacksLeft - stacksFor(c);
      const r = rest - c * d;
      if (r > capFrom(i + 1, left)) break; // fewer chips here only leaves more for smaller ones
      counts[i] = c;
      if (go(i + 1, left, r)) return true;
    }
    counts[i] = 0;
    failed.add(key);
    return false;
  };

  return go(0, MAX_STACKS, amount) ? counts.slice() : null;
}

/** Closest (not exact) picture over all denominations: minimises |total − amount|, ties broken by the
 *  most large chips (the first one found, since counts are tried from high to low). */
function closest(denoms: readonly number[], amount: number): number[] {
  const counts = new Array<number>(denoms.length).fill(0);
  let best: number[] = counts.slice();
  let bestDiff = amount;
  const capFrom = (i: number, s: number): number => (i < denoms.length ? s * MAX_PER_STACK * denoms[i]! : 0);
  // States already explored: everything better than the best at that time was found then, and the best
  // only shrinks, so a second visit (from a prefix with fewer large chips) can find nothing to prefer.
  const seen = new Set<string>();

  const go = (i: number, stacksLeft: number, rest: number): void => {
    // rest ≤ 0: overshot (or exact); nothing more to add.
    const lower = rest <= 0 ? -rest : Math.max(0, rest - capFrom(i, stacksLeft));
    if (lower >= bestDiff) return;
    if (rest <= 0 || i >= denoms.length || stacksLeft === 0) {
      const diff = Math.abs(rest);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = counts.slice();
      }
      return;
    }
    const key = `${i}:${stacksLeft}:${rest}`;
    if (seen.has(key)) return;
    seen.add(key);
    const d = denoms[i]!;
    const hi = Math.min(Math.floor(rest / d) + 1, stacksLeft * MAX_PER_STACK);
    for (let c = hi; c >= 0; c--) {
      counts[i] = c;
      go(i + 1, stacksLeft - stacksFor(c), rest - c * d);
      if (rest - c * d > capFrom(i + 1, stacksLeft - stacksFor(c)) + bestDiff) break;
    }
    counts[i] = 0;
  };

  go(0, MAX_STACKS, amount);
  return best;
}

function toStacks(denoms: readonly number[], counts: readonly number[]): ChipStack[] {
  const out: ChipStack[] = [];
  denoms.forEach((denom, i) => {
    let c = counts[i] ?? 0;
    const color = chipColor(denom);
    while (c > 0) {
      const n = Math.min(c, MAX_PER_STACK);
      out.push({ denom, color, count: n });
      c -= n;
    }
  });
  return out;
}

/** Stacks for `amount`, largest denomination first; each entry is one stack of ≤ 10 chips. */
export function chipStacks(amount: Chips, bigBlind: Chips): ChipStack[] {
  if (!Number.isSafeInteger(amount)) throw new Error(`Chips must be a safe integer, got ${String(amount)}`);
  if (amount <= 0) return [];
  const all = DENOMS_DESC.map((d) => d.denom);
  if (amount >= MAX_DRAWN) {
    // Cap (see the file comment): six full stacks of the largest chip.
    return toStacks(all, all.map((_, i) => (i === 0 ? MAX_STACKS * MAX_PER_STACK : 0)));
  }
  const minDenom = smallestUsefulDenom(Number.isFinite(bigBlind) && bigBlind > 0 ? bigBlind : 1);
  const useful = all.filter((d) => d >= minDenom);
  if (useful.length < all.length && amount % minDenom === 0) {
    const counts = exact(useful, amount);
    if (counts) return toStacks(useful, counts);
  }
  const counts = exact(all, amount) ?? closest(all, amount);
  return toStacks(all, counts);
}

export function stacksTotal(stacks: readonly ChipStack[]): number {
  return stacks.reduce((s, x) => s + x.denom * x.count, 0);
}
