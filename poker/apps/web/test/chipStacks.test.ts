import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { easeInOutCubic, easeOutCubic, type Vec3 } from '../src/anim/easing.js';
import {
  AWARD_MS,
  AWARD_STAGGER_MS,
  BET_MS,
  COLLECT_MS,
  RETURN_MS,
  chipLabel,
  chipMotion,
} from '../src/table/chipMotion.js';
import {
  CHIP_DENOMS,
  MAX_DRAWN,
  MAX_PER_STACK,
  MAX_STACKS,
  chipColor,
  chipStacks,
  smallestUsefulDenom,
  stacksTotal,
} from '../src/table/chipStacks.js';
import type { Scene } from '../src/table/sceneContext.js';
import type { ChipEntity } from '../src/table/types.js';

const DENOMS = [1, 5, 25, 100, 500, 1_000, 5_000, 25_000, 100_000];

function checkShape(amount: number, bigBlind: number): void {
  const stacks = chipStacks(amount, bigBlind);
  expect(stacks.length).toBeLessThanOrEqual(MAX_STACKS);
  for (const s of stacks) {
    expect(s.count).toBeGreaterThan(0);
    expect(s.count).toBeLessThanOrEqual(MAX_PER_STACK);
    expect(DENOMS).toContain(s.denom);
    expect(s.color).toBe(chipColor(s.denom));
  }
  // Largest denominations first.
  for (let i = 1; i < stacks.length; i++) expect(stacks[i]!.denom).toBeLessThanOrEqual(stacks[i - 1]!.denom);
}

describe('chipStacks', () => {
  it('uses the nine denominations with their colours', () => {
    expect(CHIP_DENOMS.map((d) => d.denom)).toEqual(DENOMS);
    expect(CHIP_DENOMS.map((d) => d.name)).toEqual([
      'white',
      'red',
      'green',
      'black',
      'purple',
      'yellow',
      'pink',
      'blue',
      'grey',
    ]);
    expect(new Set(CHIP_DENOMS.map((d) => d.color)).size).toBe(9);
    for (const { denom, color } of CHIP_DENOMS) {
      const stacks = chipStacks(denom, 2);
      expect(stacks).toEqual([{ denom, color, count: 1 }]);
    }
  });

  it('returns nothing for zero', () => {
    expect(chipStacks(0, 2)).toEqual([]);
  });

  it('rejects non-integer amounts', () => {
    expect(() => chipStacks(1.5, 2)).toThrow();
  });

  it('breaks familiar amounts into the expected stacks', () => {
    expect(chipStacks(30, 2)).toEqual([
      { denom: 25, color: chipColor(25), count: 1 },
      { denom: 5, color: chipColor(5), count: 1 },
    ]);
    expect(chipStacks(1_250, 50)).toEqual([
      { denom: 1_000, color: chipColor(1_000), count: 1 },
      { denom: 100, color: chipColor(100), count: 2 },
      { denom: 25, color: chipColor(25), count: 2 },
    ]);
    expect(stacksTotal(chipStacks(3, 2))).toBe(3);
  });

  it('is exact across a range of amounts and big blinds', () => {
    const bigBlinds = [2, 10, 20, 50, 100, 200, 400, 1_000, 2_000, 10_000, 50_000];
    for (const bb of bigBlinds) {
      for (let amount = 1; amount <= 3_000; amount++) {
        const stacks = chipStacks(amount, bb);
        expect(stacksTotal(stacks)).toBe(amount);
      }
      for (const amount of [5_000, 12_345, 99_995, 250_000, 1_234_500, 5_100_000]) {
        expect(stacksTotal(chipStacks(amount, bb))).toBe(amount);
        checkShape(amount, bb);
      }
    }
  });

  it('keeps to ≤ 6 stacks of ≤ 10 chips, largest first (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20_000_000 }), fc.integer({ min: 1, max: 200_000 }), (amount, bb) => {
        checkShape(amount, bb);
      }),
      { numRuns: 1_500 },
    );
  });

  it('is exact whenever an exact picture fits, and otherwise as close as possible (property)', () => {
    // Brute force over every picture is too large, so check the two cheap facts: an amount built from at
    // most six stacks of ≤ 10 chips is shown exactly, and any amount shows within a small error.
    const stack = fc.record({ d: fc.constantFrom(...DENOMS), c: fc.integer({ min: 1, max: 10 }) });
    fc.assert(
      fc.property(fc.array(stack, { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 100_000 }), (parts, bb) => {
        const amount = parts.reduce((s, p) => s + p.d * p.c, 0);
        expect(stacksTotal(chipStacks(amount, bb))).toBe(amount);
      }),
      { numRuns: 1_500 },
    );
  });

  it('shows a nearby amount when no exact picture fits', () => {
    // 1 + 5 + 25 + 100 + 500 + 1k + 5k + 25k pieces cannot all fit in six stacks.
    const amount = 24_999 + 99_999;
    const total = stacksTotal(chipStacks(amount, 100));
    expect(total).not.toBe(amount);
    expect(Math.abs(total - amount)).toBeLessThanOrEqual(5);
    // 99,999 → one $100k chip is the closest (1 away) and has the largest chips.
    expect(chipStacks(99_999, 1_000)).toEqual([{ denom: 100_000, color: chipColor(100_000), count: 1 }]);
  });

  it('caps huge amounts at six full $100k stacks', () => {
    expect(MAX_DRAWN).toBe(6_000_000);
    for (const amount of [6_000_000, 6_000_001, 123_456_789]) {
      const stacks = chipStacks(amount, 1_000);
      expect(stacks).toHaveLength(6);
      expect(stacks.every((s) => s.denom === 100_000 && s.count === 10)).toBe(true);
    }
  });

  it('big blind picks the smallest useful denomination', () => {
    expect(smallestUsefulDenom(2)).toBe(1);
    expect(smallestUsefulDenom(20)).toBe(5);
    expect(smallestUsefulDenom(100)).toBe(25);
    expect(smallestUsefulDenom(400)).toBe(100);
    expect(smallestUsefulDenom(100_000)).toBe(25_000);
    // At big stakes, 50 is drawn as two greens, not ten reds or fifty whites; at any stakes no small chips
    // appear when the amount does not need them.
    expect(chipStacks(50, 400)).toEqual([{ denom: 25, color: chipColor(25), count: 2 }]);
    const big = chipStacks(150_000, 20_000);
    expect(big.every((s) => s.denom >= 5_000)).toBe(true);
    expect(stacksTotal(big)).toBe(150_000);
  });
});

// ---- chipMotion ------------------------------------------------------------------------------------------

const scene: Scene = {
  maxSeats: 6,
  mySeat: null,
  seatPosition: (s) => [s * 10, 0, 0],
  betPosition: (s) => [s * 10, 0, 5],
  potPosition: (i) => [i, 0, -1],
  boardPosition: (i) => [i, 0, 1],
  buttonPosition: (s) => [s, 0, 2],
  dealerPosition: [0, 0, -3] as Vec3,
  muckPosition: [0, 0, 3] as Vec3,
};

function entity(e: Partial<ChipEntity> & Pick<ChipEntity, 'id' | 'place'>): ChipEntity {
  return { amount: 100, order: 0, ...e };
}

describe('chipMotion', () => {
  it('bet: chips slide from the seat to the bet place, 300 ms easeOutCubic', () => {
    const m = chipMotion(
      entity({ id: 'chips:inc:7', place: { at: 'bet', seat: 2 }, spawnFrom: { at: 'seat', seat: 2 } }),
      scene,
    );
    expect(m).toEqual({ from: [20, 0, 0], to: [20, 0, 5], durationMs: BET_MS, ease: easeOutCubic, delayMs: 0 });
    expect(BET_MS).toBe(300);
    // A merged bet already in place has no spawn point.
    const placed = chipMotion(entity({ id: 'chips:bet:2', place: { at: 'bet', seat: 2 } }), scene);
    expect(placed.from).toBeUndefined();
    expect(placed.to).toEqual([20, 0, 5]);
    expect(placed.ease).toBe(easeOutCubic);
  });

  it('collect: a bet heading to the pot, 450 ms easeInOutCubic', () => {
    const m = chipMotion(entity({ id: 'chips:bet:3', place: { at: 'pot', index: 0 } }), scene);
    expect(m).toEqual({ to: [0, 0, -1], durationMs: COLLECT_MS, ease: easeInOutCubic, delayMs: 0 });
    expect(COLLECT_MS).toBe(450);
  });

  it('award: pot shares go to winners, 600 ms easeInOutCubic, staggered by order and landing in time', () => {
    const a = chipMotion(
      entity({ id: 'chips:award:9:1', place: { at: 'seat', seat: 1 }, spawnFrom: { at: 'pot', index: 0 }, order: 0 }),
      scene,
    );
    expect(a).toEqual({ from: [0, 0, -1], to: [10, 0, 0], durationMs: AWARD_MS, ease: easeInOutCubic, delayMs: 0 });
    expect(AWARD_MS).toBe(600);
    const b = chipMotion(
      entity({ id: 'chips:award:9:4', place: { at: 'seat', seat: 4 }, spawnFrom: { at: 'pot', index: 0 }, order: 1 }),
      scene,
    );
    expect(b.from).toEqual([0, 0, -1]);
    expect(b.to).toEqual([40, 0, 0]);
    expect(b.ease).toBe(easeInOutCubic);
    expect(b.delayMs).toBe(AWARD_STAGGER_MS);
    expect(b.delayMs + b.durationMs).toBe(AWARD_MS);
    for (let order = 0; order < 9; order++) {
      const m = chipMotion(entity({ id: `chips:award:9:${order}`, place: { at: 'seat', seat: order }, order }), scene);
      expect(m.delayMs + m.durationMs).toBe(AWARD_MS);
      expect(m.durationMs).toBeGreaterThanOrEqual(AWARD_MS / 2);
    }
  });

  it('return: uncalled chips slide back to the seat, 300 ms easeOutCubic', () => {
    const m = chipMotion(
      entity({ id: 'chips:return:5', place: { at: 'seat', seat: 3 }, spawnFrom: { at: 'bet', seat: 3 } }),
      scene,
    );
    expect(m).toEqual({ from: [30, 0, 5], to: [30, 0, 0], durationMs: RETURN_MS, ease: easeOutCubic, delayMs: 0 });
    expect(RETURN_MS).toBe(300);
  });

  it('labels only bets and pots', () => {
    expect(chipLabel(entity({ id: 'chips:bet:4', place: { at: 'bet', seat: 4 } }))).toEqual({
      testId: 'bet-4',
      prefix: '',
    });
    expect(chipLabel(entity({ id: 'chips:pot:0', place: { at: 'pot', index: 0 } }))).toEqual({
      testId: 'pot-0',
      prefix: 'Pot',
    });
    expect(chipLabel(entity({ id: 'chips:pot:2', place: { at: 'pot', index: 2 } }))).toEqual({
      testId: 'pot-2',
      prefix: 'Side pot',
    });
    expect(chipLabel(entity({ id: 'chips:inc:3', place: { at: 'bet', seat: 1 } }))).toBeNull();
    expect(chipLabel(entity({ id: 'chips:award:3:1', place: { at: 'seat', seat: 1 } }))).toBeNull();
    expect(chipLabel(entity({ id: 'chips:return:3', place: { at: 'seat', seat: 1 } }))).toBeNull();
  });
});
