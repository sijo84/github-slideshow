/**
 * Card motion (W6): pure helpers that decide how a card entity moves, so the keyframes can be tested without
 * a Canvas. `Cards.tsx` feeds `cardMotion` straight into `useTweenedPosition`; the arc lift and the landing
 * settle are pure functions of how far along its straight path the tweened position is, so the tween stays
 * the only writer of a card's position.
 */
import { easeInOutCubic, easeOutBack, easeOutCubic, type Ease, type Vec3 } from '../anim/easing.js';
import { cardPlacePosition, type Scene } from './sceneContext.js';
import { DEAL_STAGGER_MS, type CardEntity, type CardPlace } from './types.js';

/** Travel time to a seat or the board (also used for the rare move back to the deck). */
export const CARD_TRAVEL_MS = 380;
/** Travel time to the muck. */
export const CARD_MUCK_MS = 300;
/** Flip (face up/down) duration. */
export const CARD_FLIP_MS = 300;
/** Fade-out duration for `fading` cards. */
export const CARD_FADE_MS = 300;
/** Peak height of the travel arc above the straight line. */
export const CARD_ARC_HEIGHT = 0.3;

export interface CardMotion {
  target: Vec3;
  from?: Vec3;
  delayMs: number;
  durationMs: number;
  ease: Ease;
}

export function cardMotion(entity: CardEntity, scene: Scene): CardMotion {
  const toMuck = entity.place.at === 'muck';
  const motion: CardMotion = {
    target: cardPlacePosition(scene, entity.place),
    delayMs: entity.order * DEAL_STAGGER_MS,
    durationMs: toMuck ? CARD_MUCK_MS : CARD_TRAVEL_MS,
    ease: toMuck ? easeInOutCubic : easeOutCubic,
  };
  if (entity.spawnFrom) motion.from = cardPlacePosition(scene, entity.spawnFrom);
  return motion;
}

/**
 * How far along the straight line from `start` to `target` the point `current` is, in [0, 1] (projection,
 * clamped). A move of (almost) zero length counts as arrived (1).
 */
export function travelFraction(start: Vec3, target: Vec3, current: Vec3): number {
  const dx = target[0] - start[0];
  const dy = target[1] - start[1];
  const dz = target[2] - start[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return 1;
  const f = ((current[0] - start[0]) * dx + (current[1] - start[1]) * dy + (current[2] - start[2]) * dz) / len2;
  if (!(f > 0)) return 0;
  return f >= 1 ? 1 : f;
}

/** Arc height for a travel fraction: 0 at both ends, CARD_ARC_HEIGHT at the middle. */
export function arcLift(f: number): number {
  const t = f < 0 ? 0 : f > 1 ? 1 : f;
  return CARD_ARC_HEIGHT * 4 * t * (1 - t);
}

/** Resting yaw (rotation about y) of a card at a place. The muck gets a stable per-card scatter. */
export function placeYaw(place: CardPlace, id: string): number {
  switch (place.at) {
    case 'deck':
      return 0.35;
    case 'seat':
    case 'board':
      return 0;
    case 'muck': {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
      return (((h >>> 0) % 1000) / 1000 - 0.5) * 1.2;
    }
  }
}

/** Yaw while travelling: eases from `fromYaw` to `toYaw` with easeOutBack over the travel fraction, so the
 *  card overshoots slightly and settles as it lands. */
export function settleYaw(fromYaw: number, toYaw: number, f: number): number {
  return fromYaw + (toYaw - fromYaw) * easeOutBack(f);
}

/** Extra height while flipping so the card's edge clears the felt (flip in [0, 1], 0 = face down). */
export function flipLift(flip: number, halfWidth: number): number {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, flip))) * halfWidth;
}

/** The displayed position: the tweened position with the arc and flip lift added on y. */
export function liftedPosition(pos: Vec3, lift: number): Vec3 {
  return [pos[0], pos[1] + lift, pos[2]];
}

/** Board cards always show their face when the value is known; otherwise the entity decides. */
export function showsFace(entity: CardEntity): boolean {
  if (entity.card === null) return false;
  return entity.faceUp || entity.place.at === 'board';
}
