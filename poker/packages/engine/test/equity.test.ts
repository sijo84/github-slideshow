import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards.js';
import { evaluate7 } from '../src/evaluator.js';
import { equityExact, equityVsRandom, mulberry32 } from '../src/equity.js';
import type { Card } from '../src/types.js';

const c = parseCards;

function remaining(dealt: Card[]): Card[] {
  const out: Card[] = [];
  for (let x = 0; x < 52; x++) if (!dealt.includes(x)) out.push(x);
  return out;
}

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('equityExact preflop', () => {
  it('AsAh vs KsKh: aces win about 82%', () => {
    const [aa, kk] = equityExact([c('As Ah'), c('Ks Kh')], [], mulberry32(7));
    expect(aa!.win).toBeGreaterThan(0.81);
    expect(aa!.win).toBeLessThan(0.83);
    expect(kk!.win).toBeGreaterThan(0.16);
    expect(kk!.win).toBeLessThan(0.18);
  });

  it('AhKh vs 2c2d is a coin flip', () => {
    const [ak, deuces] = equityExact([c('Ah Kh'), c('2c 2d')], [], mulberry32(11));
    expect(Math.abs(ak!.win - 0.5)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(deuces!.win - 0.49)).toBeLessThanOrEqual(0.02);
  });

  it('is deterministic without rand and with the same seed', () => {
    const hands = [c('Qs Js'), c('9h 9d')];
    expect(equityExact(hands, [])).toEqual(equityExact(hands, []));
    expect(equityExact(hands, [], mulberry32(3))).toEqual(equityExact(hands, [], mulberry32(3)));
  });
});

describe('equityExact postflop', () => {
  it('flop: matches an independent brute force exactly (As Ks vs Qh Qd on Qs 7h 2c)', () => {
    const holes = [c('As Ks'), c('Qh Qd')];
    const board = c('Qs 7h 2c');
    const rest = remaining([...holes.flat(), ...board]);
    expect(rest.length).toBe(45);
    let win0 = 0;
    let win1 = 0;
    let ties = 0;
    let n = 0;
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const full = [...board, rest[i]!, rest[j]!];
        const s0 = evaluate7([...holes[0]!, ...full]).score;
        const s1 = evaluate7([...holes[1]!, ...full]).score;
        if (s0 > s1) win0++;
        else if (s1 > s0) win1++;
        else ties++;
        n++;
      }
    }
    expect(n).toBe(990);
    const res = equityExact(holes, board);
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({ win: win0 / n, tie: ties / n });
    expect(res[1]).toEqual({ win: win1 / n, tie: ties / n });
  });

  it('3-way flop: sum(win) + P(any tie) === 1', () => {
    const holes = [c('Ah Kd'), c('Tc 9c'), c('8s 8d')];
    const board = c('Jc 8c 2h');
    const rest = remaining([...holes.flat(), ...board]);
    let anyTie = 0;
    let n = 0;
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        const full = [...board, rest[i]!, rest[j]!];
        const scores = holes.map((h) => evaluate7([...h, ...full]).score);
        const best = Math.max(...scores);
        if (scores.filter((s) => s === best).length > 1) anyTie++;
        n++;
      }
    }
    const res = equityExact(holes, board);
    const sumWin = res.reduce((acc, r) => acc + r.win, 0);
    expect(Math.abs(sumWin + anyTie / n - 1)).toBeLessThan(1e-9);
  });

  it('turn: enumerates the 44 river cards', () => {
    const res = equityExact([c('As Ks'), c('Qh Qd')], c('Qs 7h 2c 3d'));
    for (const r of res) {
      const k = r.win * 44;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
    expect(res[0]!.win + res[1]!.win + res[0]!.tie).toBeCloseTo(1, 12);
  });

  it('river: results are 0 or 1', () => {
    const [a, b] = equityExact([c('As Ks'), c('Qh Qd')], c('Qs 7h 2c 3d 9s'));
    expect(a).toEqual({ win: 0, tie: 0 });
    expect(b).toEqual({ win: 1, tie: 0 });
    const [x, y] = equityExact([c('2c 3d'), c('2d 3c')], c('As Ks Qs Js 9h'));
    expect(x).toEqual({ win: 0, tie: 1 });
    expect(y).toEqual({ win: 0, tie: 1 });
  });

  it('is fast on the flop', () => {
    const t0 = performance.now();
    equityExact([c('As Ks'), c('Qh Qd'), c('Jc Tc'), c('8s 8d')], c('Qs 7h 2c'));
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('equityVsRandom', () => {
  it('AsAh vs one random hand wins about 85%', () => {
    const t0 = performance.now();
    const r = equityVsRandom(c('As Ah'), [], 1, 20_000, mulberry32(5));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(Math.abs(r.win - 0.85)).toBeLessThanOrEqual(0.02);
    expect(r.tie).toBeGreaterThanOrEqual(0);
    expect(r.win + r.tie).toBeLessThanOrEqual(1);
  });

  it('equity drops with more opponents', () => {
    const one = equityVsRandom(c('As Ah'), [], 1, 5000, mulberry32(1));
    const four = equityVsRandom(c('As Ah'), [], 4, 5000, mulberry32(1));
    expect(four.win).toBeLessThan(one.win);
  });

  it('river vs random: a royal flush always wins', () => {
    const r = equityVsRandom(c('As Ks'), c('Qs Js Ts 2h 3d'), 3, 500, mulberry32(9));
    expect(r).toEqual({ win: 1, tie: 0 });
  });

  it('is deterministic with the same seed and works with the default generator', () => {
    const a = equityVsRandom(c('7h 7d'), c('Kc 5s 2d'), 2, 2000, mulberry32(77));
    const b = equityVsRandom(c('7h 7d'), c('Kc 5s 2d'), 2, 2000, mulberry32(77));
    expect(a).toEqual(b);
    const d = equityVsRandom(c('7h 7d'), c('Kc 5s 2d'), 2, 2000);
    expect(d.win).toBeGreaterThan(0.3);
    expect(d.win).toBeLessThan(0.9);
  });
});

describe('input validation', () => {
  it('throws on bad input', () => {
    expect(() => equityExact([c('As Ah'), c('As Kh')], [])).toThrow();
    expect(() => equityExact([c('As'), c('Ks Kh')], [])).toThrow();
    expect(() => equityExact([c('As Ah'), c('Ks Kh')], c('2c 3c'))).toThrow();
    expect(() => equityExact([c('As Ah'), c('Ks Kh')], c('2c 3c As'))).toThrow();
    expect(() => equityVsRandom(c('As'), [], 1, 100)).toThrow();
    expect(() => equityVsRandom(c('As Ah'), c('2c 3c'), 1, 100)).toThrow();
    expect(() => equityVsRandom(c('As Ah'), c('As 3c 4c'), 1, 100)).toThrow();
    expect(() => equityVsRandom(c('As Ah'), [], 0, 100)).toThrow();
    expect(() => equityVsRandom(c('As Ah'), [], 9, 100)).toThrow();
    expect(() => equityVsRandom([51, 52], [], 1, 100)).toThrow();
  });
});

describe('source', () => {
  it('does not use Math.random', () => {
    const src = readFileSync(new URL('../src/equity.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('Math.random');
  });
});
