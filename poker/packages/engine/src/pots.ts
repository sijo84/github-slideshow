import type { Chips, Pot, SeatIndex } from './types.js';

export interface PotContribution { seat: SeatIndex; total: Chips; folded: boolean }

function sameSeats(a: SeatIndex[], b: SeatIndex[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Merges adjacent pots whose eligible sets are identical (eligible arrays must be sorted ascending). */
export function mergeAdjacentPots(pots: Pot[]): Pot[] {
  const out: Pot[] = [];
  for (const pot of pots) {
    const last = out[out.length - 1];
    if (last !== undefined && sameSeats(last.eligible, pot.eligible)) {
      last.amount += pot.amount;
    } else {
      out.push({ amount: pot.amount, eligible: [...pot.eligible] });
    }
  }
  return out;
}

/**
 * Builds the main pot and side pots (main pot first).
 *
 * Layers are cut at the distinct `total` values of non-folded contributors. Each layer takes
 * min(total, level) - min(total, previousLevel) from every contributor, folded or not; eligible seats are
 * the non-folded seats with total >= level, ascending. Chips a folded player put in above the highest
 * non-folded level are added to the last pot. Zero-amount pots are dropped and adjacent pots with
 * identical eligible sets are merged. A pot with a single eligible seat is still returned.
 *
 * Edge case: if every contributor folded (cannot happen in real play), all chips go into a single pot
 * with `eligible: []` (or no pot at all if nothing was contributed).
 */
export function buildPots(contrib: PotContribution[]): Pot[] {
  const grand = contrib.reduce((sum, c) => sum + c.total, 0);
  const live = contrib.filter((c) => !c.folded);
  if (live.length === 0) {
    return grand > 0 ? [{ amount: grand, eligible: [] }] : [];
  }

  const levels = [...new Set(live.map((c) => c.total))].sort((a, b) => a - b);
  const layers: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contrib) amount += Math.min(c.total, level) - Math.min(c.total, prev);
    const eligible = live.filter((c) => c.total >= level).map((c) => c.seat).sort((a, b) => a - b);
    layers.push({ amount, eligible });
    prev = level;
  }

  // Folded chips above the highest live level go into the last pot.
  const overflow = contrib.reduce((sum, c) => sum + Math.max(0, c.total - prev), 0);
  const top = layers[layers.length - 1];
  if (top !== undefined) top.amount += overflow;

  return mergeAdjacentPots(layers.filter((p) => p.amount > 0));
}

/**
 * Splits `amount` equally among `winners`. Odd chips go one each to winners in seat order starting
 * from the first seat clockwise after the button ((buttonSeat + 1) % maxSeats, wrapping around).
 * The result is parallel to `winners` in the order given.
 */
export function splitPot(amount: Chips, winners: SeatIndex[], buttonSeat: SeatIndex, maxSeats: number): Chips[] {
  const n = winners.length;
  if (n === 0) return [];
  const share = Math.floor(amount / n);
  let odd = amount - share * n;
  const shares = winners.map(() => share);
  const distance = (seat: SeatIndex): number => (((seat - buttonSeat - 1) % maxSeats) + maxSeats) % maxSeats;
  const order = winners.map((seat, i) => ({ seat, i })).sort((a, b) => distance(a.seat) - distance(b.seat));
  for (const { i } of order) {
    if (odd === 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    odd--;
  }
  return shares;
}
