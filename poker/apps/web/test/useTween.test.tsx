import { StrictMode, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  __setRafForTests,
  activeTweenCount,
  useTween,
  useTweenedPosition,
  type TraceSample,
  type Vec3,
} from '../src/anim/tween.js';

let time = 0;
let nextHandle = 1;
const pending = new Map<number, (t: number) => void>();

function frames(n: number, ms = 16.7): void {
  act(() => {
    for (let i = 0; i < n; i++) {
      time += ms;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(time);
    }
  });
}

type TraceWin = { __POKER_TRACE__?: boolean; __animTrace?: TraceSample[] };
const tw = window as unknown as TraceWin;

beforeEach(() => {
  time = 1000;
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
  delete tw.__POKER_TRACE__;
  delete tw.__animTrace;
});

afterEach(() => {
  cleanup();
  __resetForTests();
  delete tw.__POKER_TRACE__;
  delete tw.__animTrace;
});

let setTarget: (v: number) => void = () => {};
function Num({ initial, durationMs = 200 }: { initial: number; durationMs?: number }) {
  const [target, set] = useState(initial);
  setTarget = set;
  // inline ease: a new function identity on every render must not restart the tween
  const v = useTween(target, { id: 'num', durationMs, ease: (t) => t });
  return <span data-testid="v">{v}</span>;
}

let setPos: (v: Vec3) => void = () => {};
const seen: Vec3[] = [];
function Pos({ id, initial }: { id: string; initial: Vec3 }) {
  const [target, set] = useState<Vec3>(initial);
  setPos = set;
  const p = useTweenedPosition(id, target, { durationMs: 300 });
  seen.push(p);
  return <span data-testid="p">{p.join(',')}</span>;
}

describe('useTween', () => {
  it('first render equals target with no motion; then eases to a new target', () => {
    const { getByTestId } = render(<Num initial={5} />);
    expect(getByTestId('v').textContent).toBe('5');
    expect(activeTweenCount()).toBe(0);
    act(() => setTarget(105));
    expect(activeTweenCount()).toBe(1);
    frames(6); // 100.2 ms of 200, linear
    expect(Number(getByTestId('v').textContent)).toBeCloseTo(5 + 100 * (100.2 / 200), 6);
    frames(10);
    expect(getByTestId('v').textContent).toBe('105');
    expect(activeTweenCount()).toBe(0);
  });

  it('retargets from the current value without snapping', () => {
    const { getByTestId } = render(<Num initial={0} />);
    act(() => setTarget(100));
    frames(5);
    const mid = Number(getByTestId('v').textContent);
    act(() => setTarget(0));
    frames(1);
    const after = Number(getByTestId('v').textContent);
    expect(Math.abs(after - mid)).toBeLessThanOrEqual((100 * 16.7) / 200 + 1e-9);
    frames(20);
    expect(getByTestId('v').textContent).toBe('0');
  });

  it('is StrictMode safe and cancels on unmount without setting state afterwards', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByTestId, unmount } = render(
      <StrictMode>
        <Num initial={0} />
      </StrictMode>,
    );
    act(() => setTarget(50));
    expect(activeTweenCount()).toBe(1);
    frames(20);
    expect(getByTestId('v').textContent).toBe('50');
    act(() => setTarget(0));
    frames(2);
    unmount();
    expect(activeTweenCount()).toBe(0);
    frames(20);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('useTweenedPosition', () => {
  it('returns Vec3 values (new arrays per update) and records obj:<id> every frame, moving or not', () => {
    tw.__POKER_TRACE__ = true;
    seen.length = 0;
    const { getByTestId } = render(
      <StrictMode>
        <Pos id="seat:3" initial={[1, 2, 3]} />
      </StrictMode>,
    );
    expect(getByTestId('p').textContent).toBe('1,2,3');
    expect(pending.size).toBe(1); // loop runs for the traced object even with no tween
    frames(5);
    let obj = tw.__animTrace!.filter((s) => s.id === 'obj:seat:3');
    expect(obj).toHaveLength(5);
    for (const s of obj) {
      expect(s.value).toEqual([1, 2, 3]);
      expect(s.active).toBe(false);
      expect(s.from).toBeUndefined();
    }

    act(() => setPos([4, 2, 0]));
    frames(30);
    frames(3);
    obj = tw.__animTrace!.filter((s) => s.id === 'obj:seat:3');
    expect(obj).toHaveLength(38);
    expect(obj.at(-1)!.value).toEqual([4, 2, 0]);
    expect(getByTestId('p').textContent).toBe('4,2,0');

    // the e2e (F5) rule: every change is covered by an active tween and bounded by 2.5× its average step
    for (let i = 1; i < obj.length; i++) {
      const a = obj[i - 1]!.value as Vec3;
      const b = obj[i]!.value as Vec3;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const s = obj[i]!;
      if (!s.active) {
        expect(d).toBe(0);
        continue;
      }
      const f = s.from as Vec3;
      const t = s.to as Vec3;
      expect(s.durationMs).toBe(300);
      expect(s.tween).toBe('pos:seat:3');
      const dist = Math.hypot(t[0] - f[0], t[1] - f[1], t[2] - f[2]);
      const dt = s.t - obj[i - 1]!.t;
      expect(d).toBeLessThanOrEqual((2.5 * dist * dt) / s.durationMs! + 1e-9);
    }
    // the last moving sample (the frame the tween completed) still carries the tween info
    const lastMoving = obj.findLastIndex((s) => s.active);
    expect(obj[lastMoving]!.value).toEqual([4, 2, 0]);
    expect(obj.slice(lastMoving + 1).every((s) => s.active === false)).toBe(true);

    // new arrays per update
    const moving = seen.filter((p, i) => i > 0 && p !== seen[i - 1]);
    expect(new Set(moving).size).toBe(moving.length);
  });

  it('stops sampling and the loop after unmount; no obj samples with trace off', () => {
    const { unmount } = render(<Pos id="hud" initial={[0, 0, 0]} />);
    expect(pending.size).toBe(0); // trace off: nothing to sample, loop idle
    unmount();
    tw.__POKER_TRACE__ = true;
    const r = render(<Pos id="hud2" initial={[0, 0, 0]} />);
    frames(2);
    r.unmount();
    frames(2);
    expect(pending.size).toBe(0);
    expect(tw.__animTrace!.filter((s) => s.id === 'obj:hud2')).toHaveLength(2);
    expect(tw.__animTrace!.some((s) => s.id === 'obj:hud')).toBe(false);
  });
});

function Spawn({ id, target, from, delayMs }: { id: string; target: Vec3; from?: Vec3; delayMs?: number }) {
  const p = useTweenedPosition(id, target, { durationMs: 300, from, delayMs });
  return <span data-testid="s">{p.join(',')}</span>;
}

describe('useTweenedPosition from / delayMs (I-11)', () => {
  it('mounting with `from` starts at `from`, tweens to `target`, every change in obj: active', () => {
    tw.__POKER_TRACE__ = true;
    const { getByTestId } = render(
      <StrictMode>
        <Spawn id="card:x" from={[0, 0, 0]} target={[3, 0, 4]} />
      </StrictMode>,
    );
    expect(getByTestId('s').textContent).toBe('0,0,0');
    expect(activeTweenCount()).toBe(1);
    frames(25);
    expect(getByTestId('s').textContent).toBe('3,0,4');
    expect(activeTweenCount()).toBe(0);
    const obj = tw.__animTrace!.filter((s) => s.id === 'obj:card:x');
    expect(obj.length).toBe(25);
    expect(obj.at(-1)!.value).toEqual([3, 0, 4]);
    let changes = 0;
    let prev: Vec3 = [0, 0, 0];
    for (const s of obj) {
      const v = s.value as Vec3;
      if (v[0] !== prev[0] || v[1] !== prev[1] || v[2] !== prev[2]) {
        changes++;
        expect(s.active).toBe(true);
        expect(s.tween).toBe('pos:card:x');
        expect(s.from).toEqual([0, 0, 0]);
        expect(s.to).toEqual([3, 0, 4]);
      }
      prev = v;
    }
    expect(changes).toBeGreaterThan(5);
  });

  it('delayMs holds the start value for that long, then moves', () => {
    tw.__POKER_TRACE__ = true;
    const { getByTestId } = render(<Spawn id="chip" from={[1, 1, 1]} target={[2, 1, 1]} delayMs={200} />);
    frames(11); // 183.7 ms < 200
    expect(getByTestId('s').textContent).toBe('1,1,1');
    const held = tw.__animTrace!.filter((s) => s.id === 'obj:chip');
    expect(held).toHaveLength(11);
    expect(held.every((s) => (s.value as Vec3)[0] === 1)).toBe(true);
    frames(2); // 217.1 ms: past the delay
    expect(Number(getByTestId('s').textContent!.split(',')[0])).toBeGreaterThan(1);
    frames(30);
    expect(getByTestId('s').textContent).toBe('2,1,1');
  });

  it('delayMs also applies to retargets', () => {
    let set: (v: Vec3) => void = () => {};
    function Retarget() {
      const [t, s] = useState<Vec3>([0, 0, 0]);
      set = s;
      const p = useTweenedPosition('r', t, { durationMs: 100, delayMs: 100 });
      return <span data-testid="r">{p.join(',')}</span>;
    }
    const { getByTestId } = render(<Retarget />);
    act(() => set([1, 0, 0]));
    frames(5); // 83.5 ms
    expect(getByTestId('r').textContent).toBe('0,0,0');
    frames(10);
    expect(getByTestId('r').textContent).toBe('1,0,0');
  });

  it('without `from` the first render equals target and nothing tweens', () => {
    const { getByTestId } = render(<Spawn id="plain" target={[5, 0, 5]} delayMs={100} />);
    expect(getByTestId('s').textContent).toBe('5,0,5');
    expect(activeTweenCount()).toBe(0);
    frames(10);
    expect(getByTestId('s').textContent).toBe('5,0,5');
  });
});
