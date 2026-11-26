/**
 * Turn ring (W8): an SVG ring around the active seat's avatar that drains toward the store's `deadline`.
 * Green normally, amber in the last 5 s, red while this seat is using its time bank (with the text "Time bank").
 * A gentle glow pulse (opacity, 1.2 s loop, easeInOutSine) runs through the tween module unless the user
 * prefers reduced motion. The drain reads `Date.now()` against `deadline` on every animation frame and writes
 * `stroke-dashoffset` straight to the element, so it never re-renders React per frame.
 */
import type { SeatIndex } from '@poker/engine';
import { useEffect, useRef, useState } from 'react';
import { easeInOutSine, prefersReducedMotion, tween, type TweenHandle } from '../anim/tween.js';
import { useTable } from './storeContext.js';

/** Remaining time (ms) at or below which the ring turns amber. */
export const TURN_WARN_MS = 5000;
/** One full glow pulse (ms): half up, half down. */
export const TURN_PULSE_MS = 1200;

const RADIUS = 46;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Phase = 'normal' | 'warn' | 'bank';

function scheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(h);
  }
  const h = setTimeout(cb, 100);
  return () => clearTimeout(h);
}

export function TurnRing({ seat }: { seat: SeatIndex }) {
  const deadline = useTable((s) => s.deadline);
  const turnSeconds = useTable((s) => s.settings?.turnSeconds ?? null);
  const usingBank = useTable((s) => s.timeBank !== null && s.timeBank.seat === seat && s.timeBank.using);
  const progressRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const [warn, setWarn] = useState(false);

  // Drain: rAF clock against the deadline.
  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    if (deadline === null) {
      el.style.strokeDashoffset = '0';
      setWarn(false);
      return;
    }
    const startRemaining = Math.max(0, deadline - Date.now());
    // Total of the ring: the turn length (or, on the time bank, what was left when it started).
    const total = Math.max(1, usingBank ? startRemaining : Math.max(startRemaining, (turnSeconds ?? 0) * 1000));
    let cancel: (() => void) | null = null;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const frac = Math.min(1, remaining / total);
      el.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - frac));
      setWarn(remaining <= TURN_WARN_MS);
      cancel = remaining > 0 ? scheduleFrame(tick) : null;
    };
    tick();
    return () => {
      cancel?.();
    };
  }, [deadline, turnSeconds, usingBank]);

  // Glow pulse: two eased half-cycles chained forever; skipped under reduced motion.
  useEffect(() => {
    const el = glowRef.current;
    if (!el || prefersReducedMotion()) return;
    let alive = true;
    let handle: TweenHandle | null = null;
    const run = (from: number, to: number) => {
      handle = tween<number>({
        id: 'turn-pulse:' + seat,
        from,
        to,
        durationMs: TURN_PULSE_MS / 2,
        ease: easeInOutSine,
        onUpdate: (v) => {
          el.style.opacity = String(v);
        },
        onDone: () => {
          if (alive) run(to, from);
        },
      });
    };
    run(0.25, 0.8);
    return () => {
      alive = false;
      handle?.cancel();
    };
  }, [seat]);

  const phase: Phase = usingBank ? 'bank' : warn ? 'warn' : 'normal';

  return (
    <span className={`turn-ring turn-ring--${phase}`} data-testid="turn-ring" data-phase={phase}>
      <svg className="turn-ring__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="turn-ring__track" cx="50" cy="50" r={RADIUS} />
        <circle ref={glowRef} className="turn-ring__glow" cx="50" cy="50" r={RADIUS} />
        <circle
          ref={progressRef}
          className="turn-ring__progress"
          cx="50"
          cy="50"
          r={RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          transform="rotate(-90 50 50)"
        />
      </svg>
      {usingBank && <span className="turn-ring__bank">Time bank</span>}
    </span>
  );
}
