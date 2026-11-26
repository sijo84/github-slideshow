/**
 * Tween module (W2). The single writer of animated values in the web app (F5).
 *
 * - One shared requestAnimationFrame loop, timestamp based: value = from + (to − from)·ease(progress) with
 *   progress = clamp((frameTime − start − delay) / duration). A dropped frame simply lands further along.
 *   The last sample is exactly `to`, and `onDone` fires once, after that last `onUpdate`.
 * - Starting a tween whose id is already running replaces it and starts from the old tween's current
 *   (last emitted) value; the new `from` is ignored, so nothing snaps.
 * - `prefers-reduced-motion: reduce` scales durations (and delays, so staggers keep their shape) by 0.3,
 *   still eased.
 * - The loop runs only while tweens are active, or while the trace is on and `useTweenedPosition` objects
 *   are registered (they are sampled every frame under `obj:<id>`). Otherwise it stops so a canvas can idle.
 * - Trace: off unless `window.__POKER_TRACE__ === true`. Samples go to `window.__animTrace`, capped at
 *   TRACE_MAX_SAMPLES; samples beyond the cap are dropped (newest first) and counted in
 *   `window.__animTraceDropped`, so the start of every series stays intact.
 */
import { useEffect, useRef, useState } from 'react';
import { easeInOutCubic, type Ease, type TweenValue, type Vec3 } from './easing.js';

export {
  linear,
  easeInOutCubic,
  easeOutCubic,
  easeOutBack,
  easeOutQuart,
  easeInOutSine,
  EASE_OUT_BACK_C,
  EASE_OUT_BACK_OVERSHOOT,
  EASE_PEAK_SLOPE,
} from './easing.js';
export type { Ease, TweenValue, Vec3 } from './easing.js';

export interface TweenOptions<T extends TweenValue> {
  id: string;
  from: T;
  to: T;
  durationMs: number;
  /** Default easeInOutCubic. */
  ease?: Ease;
  delayMs?: number;
  onUpdate(value: T): void;
  onDone?(): void;
}

/** `done` resolves when the tween finishes, is cancelled, or is replaced by a tween with the same id
 *  (`onDone` runs only on natural completion). It never rejects. */
export interface TweenHandle {
  cancel(): void;
  readonly done: Promise<void>;
}

/** One trace sample. Tween series carry the tween's effective from/to/durationMs. `obj:<id>` series carry
 *  them only when a tween moved the object during that frame (`active: true`); otherwise `active: false`
 *  and the value must not have changed. */
export interface TraceSample {
  id: string;
  t: number;
  value: TweenValue;
  from?: TweenValue;
  to?: TweenValue;
  durationMs?: number;
  /** Whether a tween drove this value during the sampled frame. */
  active?: boolean;
  /** For `obj:` samples: the id of the tween that drove the object this frame. */
  tween?: string;
  /** Name of the ease function (`Function.name`, e.g. 'easeOutCubic'; see EASE_PEAK_SLOPE). */
  ease?: string;
}

export interface TraceMeta {
  from?: TweenValue;
  to?: TweenValue;
  durationMs?: number;
  active?: boolean;
  tween?: string;
  ease?: string;
}

/** Maximum number of samples kept in `window.__animTrace`. */
export const TRACE_MAX_SAMPLES = 250_000;
/** Duration multiplier under prefers-reduced-motion. */
export const REDUCED_MOTION_SCALE = 0.3;

interface TraceWindow {
  __POKER_TRACE__?: boolean;
  __animTrace?: TraceSample[];
  __animTraceDropped?: number;
}

function traceWindow(): TraceWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as TraceWindow);
}

function copyValue(v: TweenValue): TweenValue {
  return typeof v === 'number' ? v : [v[0], v[1], v[2]];
}

export const trace = {
  enabled(): boolean {
    return traceWindow()?.__POKER_TRACE__ === true;
  },
  record(id: string, t: number, value: TweenValue, meta?: TraceMeta): void {
    const w = traceWindow();
    if (!w || w.__POKER_TRACE__ !== true) return;
    const buf = (w.__animTrace ??= []);
    if (buf.length >= TRACE_MAX_SAMPLES) {
      w.__animTraceDropped = (w.__animTraceDropped ?? 0) + 1;
      return;
    }
    const sample: TraceSample = { id, t, value: copyValue(value) };
    if (meta) {
      if (meta.from !== undefined) sample.from = copyValue(meta.from);
      if (meta.to !== undefined) sample.to = copyValue(meta.to);
      if (meta.durationMs !== undefined) sample.durationMs = meta.durationMs;
      if (meta.active !== undefined) sample.active = meta.active;
      if (meta.tween !== undefined) sample.tween = meta.tween;
      if (meta.ease !== undefined) sample.ease = meta.ease;
    }
    buf.push(sample);
  },
  clear(): void {
    const w = traceWindow();
    if (!w) return;
    w.__animTrace = [];
    w.__animTraceDropped = 0;
  },
};

// ---------------------------------------------------------------------------------------------------------
// Clock / rAF plumbing

type Raf = (cb: (t: number) => void) => number;
type Caf = (h: number) => void;

let testRaf: Raf | null = null;
let testCaf: Caf | null = null;
let testNow: (() => number) | null = null;

function now(): number {
  if (testNow) return testNow();
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function raf(cb: (t: number) => void): number {
  if (testRaf) return testRaf(cb);
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(() => cb(now()), 16) as unknown as number;
}

function caf(h: number): void {
  if (testCaf) return testCaf(h);
  if (typeof cancelAnimationFrame === 'function') return cancelAnimationFrame(h);
  clearTimeout(h);
}

/** Lets tests drive time deterministically. Cancels a pending frame scheduled with the previous rAF. */
export function __setRafForTests(r: Raf, c: Caf, n: () => number): void {
  if (rafHandle !== null) {
    caf(rafHandle);
    rafHandle = null;
  }
  testRaf = r;
  testCaf = c;
  testNow = n;
  ensureLoop();
}

/** Test helper (addition): cancels every tween, unregisters tracked objects, restores the real rAF. */
export function __resetForTests(): void {
  for (const e of [...active.values()]) finish(e, false);
  tracked.clear();
  frameInfo.clear();
  if (rafHandle !== null) caf(rafHandle);
  rafHandle = null;
  testRaf = testCaf = null;
  testNow = null;
  lastReportedCount = 0;
}

// ---------------------------------------------------------------------------------------------------------
// Engine

interface Entry {
  id: string;
  scalar: boolean;
  from: number[];
  to: number[];
  current: number[];
  start: number;
  delay: number;
  duration: number;
  ease: Ease;
  emit: (v: TweenValue) => void;
  onDone?: () => void;
  resolve: () => void;
  finished: boolean;
}

interface FrameInfo {
  from: TweenValue;
  to: TweenValue;
  durationMs: number;
  ease: string;
}

interface Tracked {
  token: object;
  tweenId: string;
  get: () => Vec3;
}

const active = new Map<string, Entry>();
/** Tweens that moved during the current frame (kept until obj sampling at frame end). */
const frameInfo = new Map<string, FrameInfo>();
/** `obj:<id>` → tracked position. */
const tracked = new Map<string, Tracked>();
const listeners = new Set<(n: number) => void>();
let rafHandle: number | null = null;
let lastReportedCount = 0;

function toArr(v: TweenValue): number[] {
  return typeof v === 'number' ? [v] : [v[0], v[1], v[2]];
}

function fromArr(a: number[], scalar: boolean): TweenValue {
  return scalar ? a[0]! : [a[0]!, a[1]!, a[2]!];
}

function notifyActivity(): void {
  const n = active.size;
  if (n === lastReportedCount) return;
  lastReportedCount = n;
  for (const l of [...listeners]) {
    try {
      l(n);
    } catch (err) {
      console.error('[tween] activity listener threw', err);
    }
  }
}

function needsLoop(): boolean {
  return active.size > 0 || (tracked.size > 0 && trace.enabled());
}

function ensureLoop(): void {
  if (rafHandle === null && needsLoop()) rafHandle = raf(frame);
}

function finish(e: Entry, natural: boolean): void {
  if (e.finished) return;
  e.finished = true;
  if (active.get(e.id) === e) active.delete(e.id);
  if (natural && e.onDone) {
    try {
      e.onDone();
    } catch (err) {
      console.error(`[tween] onDone for ${e.id} threw`, err);
    }
  }
  e.resolve();
}

function step(e: Entry, t: number, tracing: boolean): void {
  const elapsed = t - e.start - e.delay;
  if (elapsed < 0) return; // still in delay: value stays at `from`, nothing emitted
  const p = e.duration > 0 ? elapsed / e.duration : 1;
  const done = p >= 1;
  if (done) {
    e.current = e.to.slice();
  } else {
    const k = e.ease(p);
    e.current = e.from.map((f, i) => f + (e.to[i]! - f) * k);
  }
  const value = fromArr(e.current, e.scalar);
  const from = fromArr(e.from, e.scalar);
  const to = fromArr(e.to, e.scalar);
  const info: FrameInfo = { from, to, durationMs: e.duration, ease: e.ease.name };
  frameInfo.set(e.id, info);
  if (tracing) trace.record(e.id, t, value, { ...info, active: true });
  try {
    e.emit(value);
  } catch (err) {
    console.error(`[tween] onUpdate for ${e.id} threw`, err);
  }
  if (done) finish(e, true);
}

function frame(t: number): void {
  rafHandle = null;
  const tracing = trace.enabled();
  // Snapshot: tweens started from callbacks during this frame begin on the next frame.
  for (const e of [...active.values()]) {
    if (!e.finished) step(e, t, tracing);
  }
  if (tracing) {
    for (const [objId, tr] of tracked) {
      const info = frameInfo.get(tr.tweenId);
      if (info) {
        trace.record(objId, t, tr.get(), { ...info, active: true, tween: tr.tweenId });
      } else {
        trace.record(objId, t, tr.get(), { active: false });
      }
    }
  }
  frameInfo.clear();
  notifyActivity();
  ensureLoop();
}

export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function tween<T extends TweenValue>(opts: TweenOptions<T>): TweenHandle {
  const scalar = typeof opts.to === 'number';
  const prev = active.get(opts.id);
  let from = toArr(opts.from);
  if (prev) {
    if (prev.scalar === scalar) from = prev.current.slice();
    finish(prev, false);
  }
  const scale = prefersReducedMotion() ? REDUCED_MOTION_SCALE : 1;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const entry: Entry = {
    id: opts.id,
    scalar,
    from,
    to: toArr(opts.to),
    current: from.slice(),
    start: now(),
    delay: Math.max(0, opts.delayMs ?? 0) * scale,
    duration: Math.max(0, opts.durationMs) * scale,
    ease: opts.ease ?? easeInOutCubic,
    emit: opts.onUpdate as (v: TweenValue) => void,
    onDone: opts.onDone,
    resolve,
    finished: false,
  };
  active.set(opts.id, entry);
  notifyActivity();
  ensureLoop();
  return {
    cancel() {
      if (entry.finished) return;
      finish(entry, false);
      notifyActivity();
    },
    done,
  };
}

/** Addition: cancels the running tween with this id, if any. */
export function cancelTween(id: string): void {
  const e = active.get(id);
  if (e) {
    finish(e, false);
    notifyActivity();
  }
}

/** Addition: whether a tween with this id is running (including its delay). */
export function isTweening(id: string): boolean {
  return active.has(id);
}

export function activeTweenCount(): number {
  return active.size;
}

/** Listener gets the active tween count whenever it changes. Returns an unsubscribe function. */
export function onTweenActivity(listener: (active: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------------------------------------
// React hooks

function sameValue(a: TweenValue, b: TweenValue): boolean {
  if (typeof a === 'number' || typeof b === 'number') return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function valueKey(v: TweenValue): string {
  return typeof v === 'number' ? String(v) : `${v[0]},${v[1]},${v[2]}`;
}

interface TweenStateOpts<T extends TweenValue> {
  durationMs: number;
  ease?: Ease;
  /** Passed to every tween the hook starts. */
  delayMs?: number;
  /** Value on the first render (a spawn); the hook then tweens to `target` at once. Read on mount only. */
  from?: T;
}

/** Shared core: state that eases to `target`; restarts only when the target value or tween id changes. */
function useTweenState<T extends TweenValue>(
  tweenId: string,
  target: T,
  opts: TweenStateOpts<T>,
): [T, { current: T }] {
  const [value, setValue] = useState<T>(() => opts.from ?? target);
  const valueRef = useRef<T>(value);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const targetRef = useRef(target);
  targetRef.current = target;
  const key = valueKey(target);

  useEffect(() => {
    let alive = true;
    const to = targetRef.current;
    if (sameValue(valueRef.current, to)) return;
    const h = tween<T>({
      id: tweenId,
      from: valueRef.current,
      to,
      durationMs: optsRef.current.durationMs,
      ease: optsRef.current.ease,
      delayMs: optsRef.current.delayMs,
      onUpdate: (v) => {
        if (!alive) return;
        valueRef.current = v;
        setValue(v);
      },
    });
    return () => {
      alive = false;
      h.cancel();
    };
  }, [tweenId, key]);

  return [value, valueRef];
}

/** React state that eases to `target` whenever it changes (first render: equals target, no motion).
 *  Changing `durationMs`/`ease` alone does not restart a running tween. */
export function useTween<T extends TweenValue>(
  target: T,
  opts: { id: string; durationMs: number; ease?: Ease },
): T {
  const [value] = useTweenState(opts.id, target, opts);
  return value;
}

/** Default duration for useTweenedPosition (addition, documents the default). */
export const DEFAULT_POSITION_MS = 350;

/** F5: like useTween for a position, and it also records the value it returns every frame under `obj:<id>`
 *  in the trace, moving or not. The only way table objects and panels get a position. The underlying tween
 *  id is `pos:<id>`.
 *  - `from` (I-11): the value on the first render; the hook then tweens to `target` at once (a spawn).
 *    Without it the first render equals `target`. Only read on mount.
 *  - `delayMs` (I-11): passed to every tween the hook starts; during the delay the value holds still. */
export function useTweenedPosition(
  id: string,
  target: Vec3,
  opts?: { durationMs?: number; ease?: Ease; delayMs?: number; from?: Vec3 },
): Vec3 {
  const tweenId = `pos:${id}`;
  const [value, valueRef] = useTweenState<Vec3>(tweenId, target, {
    durationMs: opts?.durationMs ?? DEFAULT_POSITION_MS,
    ease: opts?.ease,
    delayMs: opts?.delayMs,
    from: opts?.from,
  });

  useEffect(() => {
    const objId = `obj:${id}`;
    const token = {};
    tracked.set(objId, { token, tweenId, get: () => valueRef.current });
    ensureLoop();
    return () => {
      if (tracked.get(objId)?.token === token) tracked.delete(objId);
    };
  }, [id, tweenId, valueRef]);

  return value;
}
