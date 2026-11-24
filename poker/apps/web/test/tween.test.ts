import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  __setRafForTests,
  activeTweenCount,
  cancelTween,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  isTweening,
  linear,
  onTweenActivity,
  prefersReducedMotion,
  trace,
  tween,
  type TraceSample,
  type Vec3,
} from '../src/anim/tween.js';

// ---- fake rAF ------------------------------------------------------------------------------------------
let time = 0;
let nextHandle = 1;
const pending = new Map<number, (t: number) => void>();

function installFakeRaf(): void {
  time = 1000;
  nextHandle = 1;
  pending.clear();
  __setRafForTests(
    (cb) => {
      const h = nextHandle++;
      pending.set(h, cb);
      return h;
    },
    (h) => {
      pending.delete(h);
    },
    () => time,
  );
}

/** Advance the clock by `ms` and run one frame. */
function frame(ms: number): void {
  time += ms;
  const cbs = [...pending.values()];
  pending.clear();
  for (const cb of cbs) cb(time);
}

function frames(n: number, ms = 16.7): void {
  for (let i = 0; i < n; i++) frame(ms);
}

type TraceWin = { __POKER_TRACE__?: boolean; __animTrace?: TraceSample[] };
const tw = window as unknown as TraceWin;

beforeEach(() => {
  installFakeRaf();
  delete tw.__POKER_TRACE__;
  delete tw.__animTrace;
});

afterEach(() => {
  __resetForTests();
  vi.unstubAllGlobals();
  delete tw.__POKER_TRACE__;
  delete tw.__animTrace;
});

// ---- tests ---------------------------------------------------------------------------------------------
describe('tween', () => {
  it('easeInOutCubic: max per-frame delta ≤ 2 × distance × frameMs / duration at 16.7 ms frames', () => {
    const values: number[] = [0];
    const distance = 100;
    const duration = 500;
    tween({ id: 'a', from: 0, to: distance, durationMs: duration, ease: easeInOutCubic, onUpdate: (v) => values.push(v) });
    frames(60);
    expect(values.at(-1)).toBe(distance);
    let maxDelta = 0;
    for (let i = 1; i < values.length; i++) maxDelta = Math.max(maxDelta, Math.abs(values[i]! - values[i - 1]!));
    const avgStep = (distance * 16.7) / duration;
    expect(maxDelta).toBeLessThanOrEqual(2 * avgStep);
    expect(maxDelta).toBeGreaterThan(1.3 * avgStep); // sanity: the peak velocity really is ~1.5×
  });

  it('is timestamp based: a dropped frame moves exactly the eased distance for that time step and ends on `to`', () => {
    const from = 3;
    const to = 250.123456789;
    const duration = 400;
    const values: number[] = [];
    const times: number[] = [];
    const start = time;
    tween({
      id: 'drop',
      from,
      to,
      durationMs: duration,
      onUpdate: (v) => {
        values.push(v);
        times.push(time);
      },
    });
    frame(16.7);
    frame(16.7);
    frame(120); // dropped frames
    frames(30);
    expect(values.at(-1)).toBe(to); // exact, no float residue
    const eased = (t: number) => from + (to - from) * easeInOutCubic(Math.min(1, (t - start) / duration));
    for (let i = 0; i < values.length; i++) expect(values[i]).toBeCloseTo(eased(times[i]!), 9);
    for (let i = 1; i < values.length; i++) {
      const allowed = Math.abs(eased(times[i]!) - eased(times[i - 1]!));
      expect(Math.abs(values[i]! - values[i - 1]!)).toBeLessThanOrEqual(allowed + 1e-9);
    }
  });

  it('onDone fires exactly once, after the last onUpdate; done resolves', async () => {
    const log: string[] = [];
    const h = tween({
      id: 'd',
      from: 0,
      to: 1,
      durationMs: 100,
      onUpdate: (v) => log.push(`u${v === 1 ? '1' : ''}`),
      onDone: () => log.push('done'),
    });
    frames(20);
    expect(log.filter((l) => l === 'done')).toHaveLength(1);
    expect(log.at(-1)).toBe('done');
    expect(log.at(-2)).toBe('u1');
    await expect(h.done).resolves.toBeUndefined();
  });

  it('retargeting mid-flight starts from the current value (new `from` ignored), no discontinuity', () => {
    const values: number[] = [];
    const push = (v: number) => values.push(v);
    tween({ id: 'r', from: 0, to: 100, durationMs: 500, onUpdate: push });
    frames(12);
    const lastOld = values.at(-1)!;
    const nOld = values.length;
    let oldDone = false;
    tween({ id: 'r', from: 9999, to: -50, durationMs: 400, onUpdate: push, onDone: () => (oldDone = true) });
    frames(40);
    const firstNew = values[nOld]!;
    const stepBound = (2 * Math.abs(-50 - lastOld) * 16.7) / 400;
    expect(Math.abs(firstNew - lastOld)).toBeLessThanOrEqual(stepBound);
    for (let i = nOld + 1; i < values.length; i++) {
      expect(Math.abs(values[i]! - values[i - 1]!)).toBeLessThanOrEqual(stepBound);
    }
    expect(values.at(-1)).toBe(-50);
    expect(oldDone).toBe(true); // the new tween's onDone
    expect(values).not.toContain(9999);
  });

  it('replaced tween: no further updates, no onDone, its done promise resolves', async () => {
    const oldUpdates: number[] = [];
    let oldDone = 0;
    const h1 = tween({ id: 'x', from: 0, to: 10, durationMs: 100, onUpdate: (v) => oldUpdates.push(v), onDone: () => oldDone++ });
    frames(2);
    const n = oldUpdates.length;
    tween({ id: 'x', from: 0, to: 20, durationMs: 100, onUpdate: () => {} });
    frames(20);
    expect(oldUpdates).toHaveLength(n);
    expect(oldDone).toBe(0);
    await expect(h1.done).resolves.toBeUndefined();
    // cancelling the stale handle must not touch the replacement
    const h3 = tween({ id: 'y', from: 0, to: 1, durationMs: 100, onUpdate: () => {} });
    tween({ id: 'y', from: 0, to: 2, durationMs: 100, onUpdate: () => {} });
    h3.cancel();
    expect(isTweening('y')).toBe(true);
  });

  it('cancel stops updates and onDone', async () => {
    const values: number[] = [];
    let done = 0;
    const h = tween({ id: 'c', from: 0, to: 10, durationMs: 200, onUpdate: (v) => values.push(v), onDone: () => done++ });
    frames(3);
    const n = values.length;
    h.cancel();
    h.cancel();
    frames(30);
    expect(values).toHaveLength(n);
    expect(done).toBe(0);
    expect(activeTweenCount()).toBe(0);
    await expect(h.done).resolves.toBeUndefined();

    tween({ id: 'c2', from: 0, to: 1, durationMs: 200, onUpdate: () => {} });
    cancelTween('c2');
    expect(isTweening('c2')).toBe(false);
  });

  it('delayMs holds the tween before it starts, then eases over the full duration', () => {
    const samples: Array<[number, number]> = [];
    const start = time;
    tween({ id: 'dl', from: 0, to: 100, durationMs: 200, delayMs: 100, ease: linear, onUpdate: (v) => samples.push([time - start, v]) });
    frame(50);
    frame(40);
    expect(samples).toHaveLength(0);
    expect(activeTweenCount()).toBe(1);
    frame(60); // t = 150 → 50 ms into the tween
    expect(samples.at(-1)![1]).toBeCloseTo(25, 9);
    frames(20);
    expect(samples.at(-1)![1]).toBe(100);
    for (const [t, v] of samples) if (t < 300) expect(v).toBeCloseTo(((t - 100) / 200) * 100, 9);
  });

  it('Vec3 tweens: new array per update, exact end', () => {
    const values: Vec3[] = [];
    const from: Vec3 = [0, 1, 2];
    const to: Vec3 = [10, -1, 2.5];
    tween<Vec3>({ id: 'v', from, to, durationMs: 300, ease: easeOutCubic, onUpdate: (v) => values.push(v) });
    frames(30);
    expect(values.at(-1)).toEqual(to);
    expect(values.at(-1)).not.toBe(to);
    expect(new Set(values).size).toBe(values.length);
    expect(from).toEqual([0, 1, 2]); // input untouched
    const mid = values[5]!;
    const k = easeOutCubic((6 * 16.7) / 300);
    expect(mid[0]).toBeCloseTo(10 * k, 9);
    expect(mid[1]).toBeCloseTo(1 - 2 * k, 9);
  });

  it('easeOutBack overshoot is passed through (≤ 10% of the distance)', () => {
    const values: number[] = [];
    tween({ id: 'b', from: 0, to: 100, durationMs: 300, ease: easeOutBack, onUpdate: (v) => values.push(v) });
    frames(80, 4);
    expect(Math.max(...values)).toBeGreaterThan(100);
    expect(Math.max(...values)).toBeLessThanOrEqual(110);
    expect(values.at(-1)).toBe(100);
  });

  it('prefers-reduced-motion scales durations (and delays) to 0.3× but still eases', () => {
    expect(prefersReducedMotion()).toBe(false); // jsdom: matchMedia missing → false, no throw
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)', media: q })),
    );
    expect(prefersReducedMotion()).toBe(true);
    const samples: Array<[number, number]> = [];
    const start = time;
    tween({ id: 'rm', from: 0, to: 100, durationMs: 500, delayMs: 100, onUpdate: (v) => samples.push([time - start, v]) });
    frame(29); // still in the scaled 30 ms delay → nothing yet
    expect(samples).toHaveLength(0);
    frame(76); // 75 ms into a 150 ms tween → halfway
    expect(samples.at(-1)![1]).toBeCloseTo(100 * easeInOutCubic(0.5), 9);
    frame(10);
    expect(samples.at(-1)![1]).toBeCloseTo(100 * easeInOutCubic(85 / 150), 9);
    frame(65); // t = 180 = 30 + 150 → done
    expect(samples.at(-1)![1]).toBe(100);
    expect(activeTweenCount()).toBe(0);
  });

  it('the rAF loop stops when idle; onTweenActivity reports counts', () => {
    const counts: number[] = [];
    const off = onTweenActivity((n) => counts.push(n));
    tween({ id: 'p', from: 0, to: 1, durationMs: 50, onUpdate: () => {} });
    tween({ id: 'q', from: 0, to: 1, durationMs: 100, onUpdate: () => {} });
    expect(pending.size).toBe(1); // one shared loop
    frames(10);
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(pending.size).toBe(0);
    expect(activeTweenCount()).toBe(0);
    off();
    tween({ id: 'p', from: 0, to: 1, durationMs: 50, onUpdate: () => {} });
    frames(10);
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it('a tween started from onDone chains on the next frame', () => {
    const values: number[] = [];
    tween({
      id: 'ch',
      from: 0,
      to: 1,
      durationMs: 50,
      onUpdate: (v) => values.push(v),
      onDone: () => {
        tween({ id: 'ch', from: 1, to: 2, durationMs: 50, onUpdate: (v) => values.push(v) });
      },
    });
    frames(10);
    expect(values.at(-1)).toBe(2);
    expect(values.filter((v) => v === 1)).toHaveLength(1);
  });

  it('a throwing onUpdate does not break the loop for other tweens', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good: number[] = [];
    tween({ id: 'bad', from: 0, to: 1, durationMs: 50, onUpdate: () => { throw new Error('boom'); } });
    tween({ id: 'good', from: 0, to: 1, durationMs: 50, onUpdate: (v) => good.push(v) });
    frames(10);
    expect(good.at(-1)).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('trace', () => {
  it('records nothing when disabled', () => {
    expect(trace.enabled()).toBe(false);
    tween({ id: 't0', from: 0, to: 1, durationMs: 50, onUpdate: () => {} });
    frames(10);
    trace.record('manual', 1, 1);
    expect(tw.__animTrace).toBeUndefined();
  });

  it('records { id, t, value, from, to, durationMs } per frame when enabled', () => {
    tw.__POKER_TRACE__ = true;
    trace.clear();
    tween<Vec3>({ id: 'card:1:0:0', from: [0, 0, 0], to: [1, 2, 3], durationMs: 100, onUpdate: () => {} });
    frames(10);
    const s = tw.__animTrace!.filter((x) => x.id === 'card:1:0:0');
    expect(s.length).toBe(6); // 16.7 × 6 ≥ 100
    for (const x of s) {
      expect(typeof x.t).toBe('number');
      expect(x.from).toEqual([0, 0, 0]);
      expect(x.to).toEqual([1, 2, 3]);
      expect(x.durationMs).toBe(100);
      expect(x.active).toBe(true);
      expect(x.ease).toBe('easeInOutCubic');
    }
    expect(s.at(-1)!.value).toEqual([1, 2, 3]);
    expect(s.map((x) => x.t)).toEqual([...s.map((x) => x.t)].sort((a, b) => a - b));
    trace.clear();
    expect(tw.__animTrace).toEqual([]);
  });

  it('trace from/to after a retarget is the effective from (the current value)', () => {
    tw.__POKER_TRACE__ = true;
    tween({ id: 'rt', from: 0, to: 100, durationMs: 200, onUpdate: () => {} });
    frames(5);
    const last = tw.__animTrace!.at(-1)!.value as number;
    tween({ id: 'rt', from: 0, to: 0, durationMs: 200, onUpdate: () => {} });
    frames(1);
    const s = tw.__animTrace!.at(-1)!;
    expect(s.from).toBe(last);
    expect(s.to).toBe(0);
  });
});
