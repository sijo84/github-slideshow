/**
 * Chip motion (W7, pure). Which tween a chip entity takes to reach its place. `Chips.tsx` feeds the result
 * straight into `useTweenedPosition`, so the choice here is the whole motion design:
 * - to a bet place (`chips:inc:*` spawned at a seat, or a bet that grows): 300 ms easeOutCubic;
 * - to a pot (collect): 450 ms easeInOutCubic;
 * - to a seat as an award (`chips:award:*`): 600 ms easeInOutCubic, several winners staggered by `order`
 *   (a later share starts later and flies for less, so all land within the 600 ms award step);
 * - to a seat as an uncalled return (`chips:return:*`): 300 ms easeOutCubic.
 */
import { easeInOutCubic, easeOutCubic, type Ease, type Vec3 } from '../anim/easing.js';
import { chipPlacePosition, type Scene } from './sceneContext.js';
import type { ChipEntity } from './types.js';

export const BET_MS = 300;
export const COLLECT_MS = 450;
export const AWARD_MS = 600;
export const RETURN_MS = 300;
/** Delay between successive winners' shares when a pot is split (they fan out from the pot). */
export const AWARD_STAGGER_MS = 80;
/** Stagger stops growing after this many winners, so the last share still has a real flight. */
export const MAX_AWARD_STAGGERS = 3;

export interface ChipMotion {
  to: Vec3;
  /** Spawn point (first render only); absent when the entity appears in place. */
  from?: Vec3;
  durationMs: number;
  ease: Ease;
  delayMs: number;
}

export type ChipMotionKind = 'bet' | 'collect' | 'award' | 'return';

export function chipMotionKind(entity: ChipEntity): ChipMotionKind {
  if (entity.id.startsWith('chips:award:')) return 'award';
  if (entity.id.startsWith('chips:return:')) return 'return';
  switch (entity.place.at) {
    case 'bet':
      return 'bet';
    case 'pot':
      return 'collect';
    case 'seat':
      // Any other chips heading to a seat go back to their owner, like a return.
      return 'return';
  }
}

export function chipMotion(entity: ChipEntity, scene: Scene): ChipMotion {
  const to = chipPlacePosition(scene, entity.place);
  const from = entity.spawnFrom ? chipPlacePosition(scene, entity.spawnFrom) : undefined;
  const kind = chipMotionKind(entity);
  const base = from ? { to, from } : { to };
  switch (kind) {
    case 'bet':
      return { ...base, durationMs: BET_MS, ease: easeOutCubic, delayMs: 0 };
    case 'collect':
      return { ...base, durationMs: COLLECT_MS, ease: easeInOutCubic, delayMs: 0 };
    case 'award': {
      // Later winners start a little later but land on time: the award step lasts AWARD_MS and its consume
      // removes these entities, so every share must arrive by then.
      const delayMs = Math.min(Math.max(0, entity.order), MAX_AWARD_STAGGERS) * AWARD_STAGGER_MS;
      return { ...base, durationMs: AWARD_MS - delayMs, ease: easeInOutCubic, delayMs };
    }
    case 'return':
      return { ...base, durationMs: RETURN_MS, ease: easeOutCubic, delayMs: 0 };
  }
}

/** What the amount label next to an entity says, or null for chips in flight (inc, award, return). */
export function chipLabel(entity: ChipEntity): { testId: string; prefix: string } | null {
  const bet = /^chips:bet:(\d+)$/.exec(entity.id);
  if (bet) return { testId: `bet-${bet[1]}`, prefix: '' };
  const pot = /^chips:pot:(\d+)$/.exec(entity.id);
  if (pot) return { testId: `pot-${pot[1]}`, prefix: Number(pot[1]) === 0 ? 'Pot' : 'Side pot' };
  return null;
}
