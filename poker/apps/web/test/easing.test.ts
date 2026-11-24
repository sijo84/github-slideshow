import { describe, expect, it } from 'vitest';
import {
  EASE_OUT_BACK_OVERSHOOT,
  easeInOutCubic,
  easeInOutSine,
  easeOutBack,
  easeOutCubic,
  easeOutQuart,
  linear,
  type Ease,
} from '../src/anim/easing.js';

const N = 10_000;
const samples = (f: Ease): number[] => Array.from({ length: N + 1 }, (_, i) => f(i / N));

const all: Record<string, Ease> = {
  linear,
  easeInOutCubic,
  easeOutCubic,
  easeOutBack,
  easeOutQuart,
  easeInOutSine,
};
const monotonic: Record<string, Ease> = { linear, easeInOutCubic, easeOutCubic, easeOutQuart, easeInOutSine };

describe('easing', () => {
  for (const [name, f] of Object.entries(all)) {
    it(`${name}: f(0) = 0 and f(1) = 1 exactly, clamps outside [0, 1]`, () => {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      expect(f(-0.5)).toBe(0);
      expect(f(1.5)).toBe(1);
      expect(f(Number.NaN)).toBe(0);
    });
  }

  for (const [name, f] of Object.entries(monotonic)) {
    it(`${name}: monotonic non-decreasing and within [0, 1]`, () => {
      const s = samples(f);
      for (let i = 1; i < s.length; i++) {
        expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]!);
        expect(s[i]!).toBeGreaterThanOrEqual(0);
        expect(s[i]!).toBeLessThanOrEqual(1);
      }
    });
  }

  it('easeInOutCubic: near-zero slope at both ends, peak slope 1.5', () => {
    const h = 1e-4;
    expect(easeInOutCubic(h) / h).toBeLessThan(1e-6);
    expect((1 - easeInOutCubic(1 - h)) / h).toBeLessThan(1e-6);
    let maxSlope = 0;
    for (let i = 1; i <= N; i++) {
      maxSlope = Math.max(maxSlope, (easeInOutCubic(i / N) - easeInOutCubic((i - 1) / N)) * N);
    }
    expect(maxSlope).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(maxSlope).toBeGreaterThan(1.49);
  });

  it('easeOutBack: overshoots, but by at most 10%, and never dips below 0', () => {
    const s = samples(easeOutBack);
    const max = Math.max(...s);
    expect(max).toBeGreaterThan(1);
    expect(max - 1).toBeLessThanOrEqual(0.1);
    expect(max - 1).toBeCloseTo(EASE_OUT_BACK_OVERSHOOT, 6);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
    // rises monotonically to its peak, then settles monotonically to 1
    const peak = s.indexOf(max);
    for (let i = 1; i <= peak; i++) expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]!);
    for (let i = peak + 1; i < s.length; i++) expect(s[i]!).toBeLessThanOrEqual(s[i - 1]!);
  });
});
