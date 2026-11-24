import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildPots, mergeAdjacentPots, splitPot } from '../src/pots.js';

describe('buildPots', () => {
  it('3-way with two all-ins of different sizes', () => {
    expect(
      buildPots([
        { seat: 0, total: 100, folded: false },
        { seat: 1, total: 300, folded: false },
        { seat: 2, total: 500, folded: false },
      ]),
    ).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 400, eligible: [1, 2] },
      { amount: 200, eligible: [2] },
    ]);
  });

  it('folded player who contributed more than a short all-in', () => {
    // A all-in 50; B folded after putting in 200; C and D in for 400.
    expect(
      buildPots([
        { seat: 4, total: 400, folded: false },
        { seat: 1, total: 50, folded: false },
        { seat: 2, total: 200, folded: true },
        { seat: 3, total: 400, folded: false },
      ]),
    ).toEqual([
      { amount: 200, eligible: [1, 3, 4] },
      { amount: 150 + 350 + 350, eligible: [3, 4] },
    ]);
  });

  it('folded chips above the highest live level go into the last pot', () => {
    expect(
      buildPots([
        { seat: 0, total: 100, folded: false },
        { seat: 1, total: 300, folded: true },
        { seat: 2, total: 200, folded: false },
      ]),
    ).toEqual([
      { amount: 300, eligible: [0, 2] },
      { amount: 300, eligible: [2] },
    ]);
  });

  it('everyone equal gives one pot', () => {
    expect(
      buildPots([
        { seat: 0, total: 200, folded: false },
        { seat: 3, total: 200, folded: false },
        { seat: 5, total: 200, folded: false },
      ]),
    ).toEqual([{ amount: 600, eligible: [0, 3, 5] }]);
  });

  it('a folded player\'s level does not split a pot with an unchanged eligible set', () => {
    // Without merging/cutting only at live levels, 100..200 and 200..300 would be two [1,2] pots.
    expect(
      buildPots([
        { seat: 0, total: 100, folded: false },
        { seat: 1, total: 300, folded: false },
        { seat: 2, total: 300, folded: false },
        { seat: 3, total: 200, folded: true },
      ]),
    ).toEqual([
      { amount: 400, eligible: [0, 1, 2] },
      { amount: 500, eligible: [1, 2] },
    ]);
  });

  it('drops zero-amount layers', () => {
    expect(
      buildPots([
        { seat: 0, total: 0, folded: false },
        { seat: 1, total: 100, folded: false },
      ]),
    ).toEqual([{ amount: 100, eligible: [1] }]);
  });

  it('all folded: single pot with no eligible seats', () => {
    expect(
      buildPots([
        { seat: 0, total: 100, folded: true },
        { seat: 1, total: 50, folded: true },
      ]),
    ).toEqual([{ amount: 150, eligible: [] }]);
  });

  it('property: sum of pots equals sum of contributions', () => {
    const arb = fc
      .array(fc.record({ total: fc.integer({ min: 0, max: 10_000 }), folded: fc.boolean() }), {
        minLength: 2,
        maxLength: 9,
      })
      .filter((xs) => xs.some((x) => !x.folded));
    fc.assert(
      fc.property(arb, (xs) => {
        const contrib = xs.map((x, seat) => ({ seat, ...x }));
        const pots = buildPots(contrib);
        const total = contrib.reduce((s, c) => s + c.total, 0);
        expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(total);
        for (const p of pots) {
          expect(p.amount).toBeGreaterThan(0);
          expect(Number.isInteger(p.amount)).toBe(true);
          for (const seat of p.eligible) expect(contrib[seat]?.folded).toBe(false);
        }
        for (let i = 1; i < pots.length; i++) {
          expect(pots[i]?.eligible).not.toEqual(pots[i - 1]?.eligible);
        }
      }),
    );
  });
});

describe('mergeAdjacentPots', () => {
  it('merges two layers with identical eligible sets into one pot', () => {
    expect(
      mergeAdjacentPots([
        { amount: 300, eligible: [0, 1, 2] },
        { amount: 100, eligible: [1, 2] },
        { amount: 200, eligible: [1, 2] },
        { amount: 50, eligible: [2] },
      ]),
    ).toEqual([
      { amount: 300, eligible: [0, 1, 2] },
      { amount: 300, eligible: [1, 2] },
      { amount: 50, eligible: [2] },
    ]);
  });
});

describe('splitPot', () => {
  it('gives the odd chip to the first winner left of the button', () => {
    expect(splitPot(101, [2, 5], 3, 9)).toEqual([50, 51]);
  });

  it('wraps around past the last seat', () => {
    // Button on 7 of 9: order is 8, 0, 1, ... so seat 0 precedes seat 5.
    expect(splitPot(101, [5, 0], 7, 9)).toEqual([50, 51]);
    // Button on the last seat: seat 0 is first.
    expect(splitPot(11, [4, 0], 8, 9)).toEqual([5, 6]);
  });

  it('3-way split with 2 odd chips', () => {
    // Button 4 of 6: order 5, 0, 1, ... → seats 5 and 1 get the odd chips, seat 3 does not.
    expect(splitPot(101, [1, 3, 5], 4, 6)).toEqual([34, 33, 34]);
  });

  it('even split has no odd chips', () => {
    expect(splitPot(100, [0, 1], 0, 2)).toEqual([50, 50]);
  });

  it('property: shares sum to amount and differ by at most 1', () => {
    const arb = fc.integer({ min: 2, max: 9 }).chain((maxSeats) =>
      fc.record({
        maxSeats: fc.constant(maxSeats),
        amount: fc.integer({ min: 0, max: 100_000 }),
        button: fc.integer({ min: 0, max: maxSeats - 1 }),
        winners: fc.uniqueArray(fc.integer({ min: 0, max: maxSeats - 1 }), { minLength: 1, maxLength: maxSeats }),
      }),
    );
    fc.assert(
      fc.property(arb, ({ maxSeats, amount, button, winners }) => {
        const shares = splitPot(amount, winners, button, maxSeats);
        expect(shares).toHaveLength(winners.length);
        expect(shares.reduce((s, x) => s + x, 0)).toBe(amount);
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
        for (const x of shares) expect(Number.isInteger(x)).toBe(true);
      }),
    );
  });
});
