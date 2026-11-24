/**
 * Easing curves for the tween module (W2).
 *
 * Every curve maps [0, 1] → value with f(0) = 0 and f(1) = 1 exactly; inputs outside [0, 1] are clamped,
 * so a caller can pass a raw progress ratio without guarding it.
 */

export type Vec3 = [number, number, number];
export type TweenValue = number | Vec3;
export type Ease = (t: number) => number;

/** Clamp to [0, 1]; NaN becomes 0. */
function unit(t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return t;
}

export const linear: Ease = (t) => unit(t);

/**
 * Cubic in-out, as the Hermite cubic 3t² − 2t³ ("smoothstep"): zero slope at both ends and a peak slope of
 * exactly 1.5 at t = 0.5, i.e. peak velocity 1.5× the average, which is what the plan's per-frame bounds
 * (2× in unit tests, 2.5× in the e2e trace check) are built on. Penner's piecewise 4t³ curve peaks at 3×
 * and would break those bounds, so it is deliberately not used here.
 */
export const easeInOutCubic: Ease = (raw) => {
  const t = unit(raw);
  if (t === 0 || t === 1) return t;
  return t * t * (3 - 2 * t);
};

/** Peak slope (max f′) of each built-in curve, i.e. peak velocity as a multiple of the average velocity. */
export const EASE_PEAK_SLOPE = {
  linear: 1,
  easeInOutCubic: 1.5,
  easeOutCubic: 3,
  easeOutQuart: 4,
  easeInOutSine: Math.PI / 2,
  easeOutBack: 1.6 + 3, // c + 3 at t = 0
} as const;

export const easeOutCubic: Ease = (raw) => {
  const t = unit(raw);
  if (t === 0 || t === 1) return t;
  return 1 - Math.pow(1 - t, 3);
};

export const easeOutQuart: Ease = (raw) => {
  const t = unit(raw);
  if (t === 0 || t === 1) return t;
  return 1 - Math.pow(1 - t, 4);
};

export const easeInOutSine: Ease = (raw) => {
  const t = unit(raw);
  if (t === 0 || t === 1) return t;
  return -(Math.cos(Math.PI * t) - 1) / 2;
};

/**
 * Overshoot constant for easeOutBack. With f(t) = 1 + (c+1)u³ + c·u², u = t − 1, the peak overshoot is
 * 4c³ / (27(c+1)²). Penner's classic 1.70158 gives exactly 10%, which sits on the limit, so we use 1.6
 * (≈ 8.98% overshoot) to stay safely inside the ≤ 10% budget.
 */
export const EASE_OUT_BACK_C = 1.6;
/** Peak overshoot of easeOutBack above 1 (≈ 0.0898). */
export const EASE_OUT_BACK_OVERSHOOT =
  (4 * EASE_OUT_BACK_C ** 3) / (27 * (EASE_OUT_BACK_C + 1) ** 2);

export const easeOutBack: Ease = (raw) => {
  const t = unit(raw);
  if (t === 0 || t === 1) return t;
  const c1 = EASE_OUT_BACK_C;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};
