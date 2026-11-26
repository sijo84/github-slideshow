/**
 * Table layout (W5). World positions of everything on the table.
 *
 * The table lies in the XZ plane, y is up, the centre is [0, 0, 0] and the camera sits on the +z side, so
 * +x is the viewer's right and −z is "up" on screen (the far side of the table).
 *
 * - Seats lie on an ellipse with radii SEAT_RX × SEAT_RZ. The viewer's seat (seat 0 when `mySeat` is null) is
 *   at bottom centre [0, ·, SEAT_RZ]; the others follow clockwise as the viewer sees the table (bottom → left
 *   → top → right), at equal angles.
 * - A seat's bet sits BET_FRACTION of the way from the centre to the seat; the dealer button sits a little
 *   further toward the seat and to one side of the bet.
 * - The five board cards form a centred row just below the table centre; pot 0 sits above the board and side
 *   pots fan out sideways from it (a second row, when there are more than five pots, sits below the board).
 * - The deck (dealer position) sits at the top centre of the felt; when an even seat count puts a seat at the
 *   very top, the scene moves the deck a little to the right of it (see `dealerPositionFor`).
 * - The muck sits left of the board, near the centre.
 */
import type { SeatIndex } from '@poker/engine';
import type { Vec3 } from '../anim/tween.js';
import type { Scene } from './sceneContext.js';

/** Seat ellipse radius on x. */
export const SEAT_RX = 4.2;
/** Seat ellipse radius on z. */
export const SEAT_RZ = 2.4;
/** Felt (playing surface) radii, inside the rim. */
export const FELT_RX = 3.75;
export const FELT_RZ = 2.05;
/** Outer radii of the raised rim (the rail). Seats sit on it. */
export const RIM_RX = 4.25;
export const RIM_RZ = 2.55;
/** Height of objects lying on the felt. */
export const FELT_Y = 0.02;

/** A bet sits this fraction of the way from the table centre to its seat. */
export const BET_FRACTION = 0.6;
/** The dealer button sits this fraction of the way from the centre to the seat... */
export const BUTTON_FRACTION = 0.7;
/** ...and this far to the side of that point (counter-clockwise along the rim, as the viewer sees it). */
export const BUTTON_SIDE = 0.4;

/** Distance between board card centres on x. */
export const BOARD_SPACING = 0.62;
/** z of the board row. */
export const BOARD_Z = 0.1;
/** Distance between pot stacks on x. */
export const POT_SPACING = 0.72;
/** z of the first pot row (above the board). */
export const POT_Z = -0.62;
/** z of the second pot row (pots 5 and up, below the board). */
export const POT_Z_2 = 0.82;

/** Camera tilt away from straight down, in degrees. */
export const CAMERA_TILT_DEG = 35;
export const CAMERA_FOV = 40;

function seatCount(maxSeats: number): number {
  return Number.isInteger(maxSeats) && maxSeats >= 2 ? maxSeats : 9;
}

/** Angle of a seat on the ellipse: 0 at bottom centre, growing clockwise as the viewer sees the table. */
function seatAngle(seat: SeatIndex, maxSeats: number, mySeat: SeatIndex | null): number {
  const n = seatCount(maxSeats);
  const viewer = mySeat ?? 0;
  const rel = (((seat - viewer) % n) + n) % n;
  return (2 * Math.PI * rel) / n;
}

function round(v: number): number {
  // Keep exact zeros/mirrors free of float noise like 2.4e-16, so symmetric seats compare equal.
  const r = Math.round(v * 1e9) / 1e9;
  return r === 0 ? 0 : r;
}

/** Where a seat (its HUD and its stack) sits, on the rim. */
export function seatPosition(seat: SeatIndex, maxSeats: number, mySeat: SeatIndex | null): Vec3 {
  const a = seatAngle(seat, maxSeats, mySeat);
  return [round(-SEAT_RX * Math.sin(a)), 0, round(SEAT_RZ * Math.cos(a))];
}

/** Where a seat's bet for this street sits: between the seat and the centre. */
export function betPosition(seat: SeatIndex, maxSeats: number, mySeat: SeatIndex | null): Vec3 {
  const [x, , z] = seatPosition(seat, maxSeats, mySeat);
  return [round(x * BET_FRACTION), FELT_Y, round(z * BET_FRACTION)];
}

/** Where the dealer button sits when this seat has it: beside the bet, toward the seat. */
export function buttonPosition(seat: SeatIndex, maxSeats: number, mySeat: SeatIndex | null): Vec3 {
  const a = seatAngle(seat, maxSeats, mySeat);
  const x = -SEAT_RX * Math.sin(a) * BUTTON_FRACTION;
  const z = SEAT_RZ * Math.cos(a) * BUTTON_FRACTION;
  // Unit tangent pointing counter-clockwise (toward decreasing angle): d/da of the seat point, negated.
  const tx = SEAT_RX * Math.cos(a);
  const tz = SEAT_RZ * Math.sin(a);
  const len = Math.hypot(tx, tz);
  return [round(x + (tx / len) * BUTTON_SIDE), FELT_Y, round(z + (tz / len) * BUTTON_SIDE)];
}

/** Fan offset (in pot spacings) of pot `i` within a row: 0, −1, +1, −2, +2 … (or ±0.5, ±1.5 … for the second row). */
function fanOffset(i: number, half: boolean): number {
  if (half) {
    const k = Math.floor(i / 2) + 0.5;
    return i % 2 === 0 ? -k : k;
  }
  if (i === 0) return 0;
  const k = Math.ceil(i / 2);
  return i % 2 === 1 ? -k : k;
}

/** Where pot `index` sits: pot 0 above the board centre, side pots fanning out sideways. */
export function potPosition(index: number): Vec3 {
  const i = Math.max(0, Math.floor(index));
  if (i < 5) return [round(fanOffset(i, false) * POT_SPACING), FELT_Y, POT_Z];
  return [round(fanOffset(i - 5, true) * POT_SPACING), FELT_Y, POT_Z_2];
}

/** Where board card `index` (0..4) sits: a centred row. */
export function boardPosition(index: number): Vec3 {
  return [round((index - 2) * BOARD_SPACING), FELT_Y, BOARD_Z];
}

/** The deck: top centre of the felt. */
export const dealerPosition: Vec3 = [0, FELT_Y, -1.75];

/** The deck for a seat count: top centre, moved right of the top seat when one sits at the very top. */
export function dealerPositionFor(maxSeats: number): Vec3 {
  return seatCount(maxSeats) % 2 === 0 ? [1.05, FELT_Y, -1.7] : dealerPosition;
}

/** The muck: left of the board, near the centre. */
export const muckPosition: Vec3 = [-1.95, FELT_Y, -0.2];

export function makeScene(maxSeats: number, mySeat: SeatIndex | null): Scene {
  const n = seatCount(maxSeats);
  return {
    maxSeats: n,
    mySeat,
    seatPosition: (seat) => seatPosition(seat, n, mySeat),
    betPosition: (seat) => betPosition(seat, n, mySeat),
    potPosition,
    boardPosition,
    buttonPosition: (seat) => buttonPosition(seat, n, mySeat),
    dealerPosition: dealerPositionFor(n),
    muckPosition,
  };
}

/** World-space box the camera must keep in view: the seats plus room for their HUDs (which are DOM, drawn
 *  at a fixed pixel size around the seat point, mostly toward the viewer). */
const FIT_HALF_X = SEAT_RX + 0.9;
const FIT_NEAR_Z = SEAT_RZ + 0.75;
const FIT_FAR_Z = -(SEAT_RZ + 0.55);
/** The box must project inside ±FIT_NDC. */
const FIT_NDC = 0.95;

const FIT_POINTS: Vec3[] = [
  [FIT_HALF_X, 0, FIT_NEAR_Z],
  [-FIT_HALF_X, 0, FIT_NEAR_Z],
  [FIT_HALF_X, 0, FIT_FAR_Z],
  [-FIT_HALF_X, 0, FIT_FAR_Z],
  [0, 0, FIT_NEAR_Z],
  [0, 0, FIT_FAR_Z],
  [FIT_HALF_X, 0, 0],
  [-FIT_HALF_X, 0, 0],
];

/** Largest |NDC| of the fit points for a camera at `distance` (looking at the origin, tilted CAMERA_TILT_DEG). */
function worstNdc(distance: number, aspect: number): number {
  const t = (CAMERA_TILT_DEG * Math.PI) / 180;
  // Camera direction from the target: D = (0, cos t, sin t); camera up: U = (0, sin t, −cos t); right = +x.
  const dy = Math.cos(t);
  const dz = Math.sin(t);
  const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
  let worst = 0;
  for (const [x, y, z] of FIT_POINTS) {
    const depth = distance - (y * dy + z * dz);
    if (depth <= 0.01) return Infinity;
    const up = y * dz - z * dy;
    const nx = x / depth / (tanHalf * aspect);
    const ny = up / depth / tanHalf;
    worst = Math.max(worst, Math.abs(nx), Math.abs(ny));
  }
  return worst;
}

/** The camera for a viewport aspect ratio (width / height): ~35° tilt, fov 40, looking at the table centre,
 *  as close as it can be while the seats and their HUDs still fit. Narrower viewports move it back. */
export function cameraFor(aspect: number): { position: Vec3; fov: number; lookAt: Vec3 } {
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  let lo = 2;
  let hi = 400;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (worstNdc(mid, a) > FIT_NDC) lo = mid;
    else hi = mid;
  }
  const t = (CAMERA_TILT_DEG * Math.PI) / 180;
  return {
    position: [0, round(hi * Math.cos(t)), round(hi * Math.sin(t))],
    fov: CAMERA_FOV,
    lookAt: [0, 0, 0],
  };
}
