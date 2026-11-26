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

// ---------------------------------------------------------------------------------------------------------
// Hole cards on screen (DOM, drawn above the seat HUDs; see Cards.tsx)

/** Width at which the seat HUD switches to its compact phone layout (seatHud.css `max-width: 480px`). */
export const PHONE_MAX_WIDTH = 480;

/** The seat a hole-card id belongs to (`card:<handId>:<seat>:<0|1>`), or null for a board card. */
export function holeSeatOf(id: string): number | null {
  const parts = id.split(':');
  if (parts.length < 4) return null;
  const seat = parts[parts.length - 2]!;
  return /^\d+$/.test(seat) ? Number(seat) : null;
}

/** Index (0 or 1) of a hole card from its id. */
export function holeIndexOf(id: string): 0 | 1 {
  return id.endsWith(':1') ? 1 : 0;
}

/** Screen-space layout of one hole card relative to its seat point (the HUD centre), in CSS px. */
export interface HoleCardLayout {
  /** Centre of this card relative to the seat point, at rest. */
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** Fan rotation in degrees. */
  rotateDeg: number;
  /** Scale once the card is face up (opponents' cards grow at showdown so they can be read). */
  faceUpScale: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Where a hole card sits on screen, for the viewer's own seat (`mine`) or an opponent's, at a window width.
 * - Viewer, desktop: a fanned pair left of the HUD (the button sits on its right), vertically centred on it.
 * - Viewer, phone: a fanned pair below-left of the compact HUD, where the canvas has free room.
 * - Opponent: a small fanned pair over the HUD's avatar (desktop: centred near the top; phone: the compact HUD's
 *   avatar on the left, half above its top edge); face up at showdown it grows so rank and suit can be read.
 */
export function holeCardLayout(mine: boolean, windowWidth: number, index: 0 | 1): HoleCardLayout {
  const phone = windowWidth <= PHONE_MAX_WIDTH;
  const side = index === 0 ? -1 : 1;
  if (mine) {
    if (phone) {
      const width = 32;
      const fan = 20;
      return { dx: -84 + (side * fan) / 2, dy: 42, width, height: 45, rotateDeg: side * 4, faceUpScale: 1 };
    }
    const hudW = clamp(windowWidth * 0.18, 66, 120);
    const width = Math.round(clamp(windowWidth * 0.046, 40, 60));
    const fan = Math.round(width * 0.62);
    const pairW = width + fan;
    const cx = -(hudW / 2 + 10 + pairW / 2);
    return { dx: cx + (side * fan) / 2, dy: 6, width, height: Math.round(width * 1.4), rotateDeg: side * 5, faceUpScale: 1 };
  }
  if (phone) {
    const width = 14;
    const fan = 8;
    // Over the compact HUD's avatar (left part), half above the top edge (the HUD is ~30 px tall).
    return { dx: -21 + (side * fan) / 2, dy: -19, width, height: 20, rotateDeg: side * 6, faceUpScale: 1.7 };
  }
  const width = Math.round(clamp(windowWidth * 0.026, 24, 32));
  const height = Math.round(width * 1.4);
  const fan = Math.round(width * 0.45);
  // The desktop HUD is ~100-120 px tall with the avatar at its top: the pair sits over the avatar, its top just
  // inside the HUD's top edge, so it stays in view for seats at the top of the canvas too.
  return { dx: (side * fan) / 2, dy: -26, width, height, rotateDeg: side * 6, faceUpScale: 1.3 };
}

/** How much of a hole card's screen offset applies: 1 at a seat, 0 elsewhere (deck, muck), interpolated over
 *  the travel fraction so the card glides from the anchor point to its spot beside the HUD and back. */
export function offsetWeight(fromSeat: boolean, toSeat: boolean, f: number): number {
  const a = fromSeat ? 1 : 0;
  const b = toSeat ? 1 : 0;
  return a + (b - a) * f;
}

/** A screen rectangle in CSS px (canvas coordinates). */
export interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where an opponent's pair of hole cards sits relative to the seat point (CSS px): pair centre and size. */
export interface OpponentCardSpot {
  cx: number;
  cy: number;
  cardW: number;
  cardH: number;
  /** Horizontal step between the two cards of the pair. */
  fan: number;
  pairW: number;
  pairH: number;
  where: string;
}

/** Seat box size (CSS px) as seatHud.css draws it, for a window width; phones add a status-chip row below. */
export function seatBoxSize(windowWidth: number): { w: number; h: number; below: number } {
  if (windowWidth <= PHONE_MAX_WIDTH) return { w: 72, h: 30, below: 13 };
  return { w: clamp(windowWidth * 0.18, 66, 120), h: 104, below: 0 };
}

/** Candidate spots for an opponent's pair, in order of preference: beside the seat box on the side facing the
 *  table centre, above it, below it, then on the far side. Never over the box (avatar, name, stack). */
export function opponentCandidates(towardRight: boolean, windowWidth: number, faceUp: boolean): OpponentCardSpot[] {
  const phone = windowWidth <= PHONE_MAX_WIDTH;
  const box = seatBoxSize(windowWidth);
  const cardW = phone ? (faceUp ? 22 : 12) : faceUp ? 34 : 26;
  const cardH = Math.round(cardW * 1.4);
  const fan = Math.round(cardW * (faceUp ? 0.6 : 0.5));
  const pairW = cardW + fan;
  const pairH = cardH;
  const gap = 3;
  const mk = (cx: number, cy: number, where: string): OpponentCardSpot => ({ cx, cy, cardW, cardH, fan, pairW, pairH, where });
  const sideX = (sign: number) => sign * (box.w / 2 + gap + pairW / 2);
  const toward = towardRight ? 1 : -1;
  const topY = -box.h / 2 + pairH / 2;
  const bottomY = box.h / 2 - pairH / 2;
  const aboveY = -box.h / 2 - gap - pairH / 2;
  const belowY = box.h / 2 + box.below + gap + pairH / 2;
  const edgeX = box.w / 2 - pairW / 2;
  return [
    mk(sideX(toward), topY, 'side-top'),
    mk(sideX(toward), 0, 'side-middle'),
    mk(sideX(toward), bottomY, 'side-bottom'),
    mk(toward * edgeX, aboveY, 'above-inner'),
    mk(0, aboveY, 'above'),
    mk(-toward * edgeX, aboveY, 'above-outer'),
    mk(toward * edgeX, belowY, 'below-inner'),
    mk(0, belowY, 'below'),
    mk(-toward * edgeX, belowY, 'below-outer'),
    mk(sideX(toward), aboveY + pairH / 2, 'side-raised'),
    mk(sideX(-toward), topY, 'far-top'),
    mk(sideX(-toward), 0, 'far-middle'),
    mk(sideX(-toward), bottomY, 'far-bottom'),
  ];
}

function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The first candidate (around the seat point `at`, canvas px) that stays inside the canvas and clear of every
 *  obstacle; if none is clear, the one with the least overlap. */
export function pickSpot(
  at: readonly [number, number],
  candidates: OpponentCardSpot[],
  obstacles: ScreenBox[],
  canvas: { width: number; height: number },
): OpponentCardSpot {
  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const c of candidates) {
    const b: ScreenBox = {
      x0: at[0] + c.cx - c.pairW / 2,
      y0: at[1] + c.cy - c.pairH / 2,
      x1: at[0] + c.cx + c.pairW / 2,
      y1: at[1] + c.cy + c.pairH / 2,
    };
    let cost = 0;
    for (const o of obstacles) cost += overlapArea(b, o);
    const outside =
      Math.max(0, -b.x0) + Math.max(0, -b.y0) + Math.max(0, b.x1 - canvas.width) + Math.max(0, b.y1 - canvas.height);
    cost += outside * c.pairH * 2;
    if (cost === 0) return c;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/**
 * Everything on screen an opponent's cards must not cover, in canvas px: every seat box (with its chip row on
 * phones), every bet stack with its amount label and every dealer-button spot (face down only: bets are gone
 * by showdown), the board, the main pot with its label, and the viewer's own cards.
 */
export function tableObstacles(
  project: (p: Vec3) => readonly [number, number],
  scene: Scene,
  windowWidth: number,
  faceUp: boolean,
): ScreenBox[] {
  const phone = windowWidth <= PHONE_MAX_WIDTH;
  const box = seatBoxSize(windowWidth);
  const chipR = phone ? 7 : 12;
  const label = { w: 50, h: 21 };
  const out: ScreenBox[] = [];
  for (let s = 0; s < scene.maxSeats; s++) {
    const [x, y] = project(scene.seatPosition(s));
    out.push({ x0: x - box.w / 2, y0: y - box.h / 2, x1: x + box.w / 2, y1: y + box.h / 2 + box.below });
    if (!faceUp) {
      const [bx, by] = project(scene.betPosition(s));
      out.push({ x0: bx - chipR, y0: by - label.h / 2, x1: bx + chipR + 4 + label.w, y1: by + label.h / 2 });
    }
    const [ux, uy] = project(scene.buttonPosition(s));
    out.push({ x0: ux - 10, y0: uy - 10, x1: ux + 10, y1: uy + 10 });
  }
  const boardScale = windowWidth <= 600 ? 1.55 : 1;
  for (let i = 0; i < 5; i++) {
    const [bx, , bz] = scene.boardPosition(i);
    const [x0, y0] = project([bx - 0.27 * boardScale, 0.3, bz]);
    const [x1, y1] = project([bx + 0.27 * boardScale, 0, bz + 0.72 * boardScale]);
    out.push({ x0, y0, x1, y1 });
  }
  const [px, py] = project(scene.potPosition(0));
  out.push({ x0: px - 14, y0: py - 11, x1: px + 14 + 80, y1: py + 11 });
  if (scene.mySeat !== null) {
    const [mx, my] = project(scene.seatPosition(scene.mySeat));
    for (const i of [0, 1] as const) {
      const l = holeCardLayout(true, windowWidth, i);
      out.push({ x0: mx + l.dx - l.width / 2 - 4, y0: my + l.dy - l.height / 2 - 4, x1: mx + l.dx + l.width / 2 + 4, y1: my + l.dy + l.height / 2 + 4 });
    }
  }
  return out;
}
