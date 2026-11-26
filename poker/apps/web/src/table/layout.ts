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
export const BUTTON_FRACTION = 0.68;
/** ...and this far to the side of that point (counter-clockwise along the rim, as the viewer sees it). */
export const BUTTON_SIDE = 0.55;

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

/** Size of the view the camera frames, in CSS px, and of the seat HUDs drawn (at a fixed pixel size) centred on
 *  each seat point. */
export interface CameraViewport {
  width: number;
  height: number;
  hudWidth?: number;
  hudHeight?: number;
}

/** Seat HUD size (CSS px) assumed when the caller does not say (seatHud.css: clamp(66px, 18vw, 120px) wide). */
export function hudSizeFor(windowWidth: number): { hudWidth: number; hudHeight: number } {
  const w = Math.min(120, Math.max(66, windowWidth * 0.18));
  return { hudWidth: w, hudHeight: Math.round(w * 0.52) };
}

/** Free space (CSS px) kept between a HUD or the rail and the edge of the view. */
const VIEW_PAD_PX = 8;
/** Outer reach of the rail including its bevel (Felt.tsx), which must stay in view too. */
const RAIL_REACH_X = RIM_RX + 0.12;
const RAIL_REACH_Z = RIM_RZ + 0.12;

interface FitPoint {
  p: Vec3;
  /** Allowed |NDC| on x and y. */
  lx: number;
  ly: number;
}

function fitPoints(vp: Required<CameraViewport>): FitPoint[] {
  const halfW = vp.width / 2;
  const halfH = vp.height / 2;
  const hudLx = 1 - (vp.hudWidth / 2 + VIEW_PAD_PX) / halfW;
  const hudLy = 1 - (vp.hudHeight / 2 + VIEW_PAD_PX) / halfH;
  const railLx = 1 - VIEW_PAD_PX / halfW;
  const railLy = 1 - VIEW_PAD_PX / halfH;
  const pts: FitPoint[] = [];
  const steps = 72; // seats can sit at any angle (2..9 seats, any viewer), so check the whole ellipse
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    pts.push({ p: [SEAT_RX * Math.sin(a), 0, SEAT_RZ * Math.cos(a)], lx: hudLx, ly: hudLy });
    pts.push({ p: [RAIL_REACH_X * Math.sin(a), 0.24, RAIL_REACH_Z * Math.cos(a)], lx: railLx, ly: railLy });
  }
  return pts;
}

/** Projects a world point for a camera tilted CAMERA_TILT_DEG, `distance` from the target [0, 0, tz]. */
function project(p: Vec3, distance: number, tz: number, aspect: number): { nx: number; ny: number } | null {
  const t = (CAMERA_TILT_DEG * Math.PI) / 180;
  // Camera direction from the target: D = (0, cos t, sin t); camera up: U = (0, sin t, −cos t); right = +x.
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
  const qy = p[1];
  const qz = p[2] - tz;
  const depth = distance - (qy * cos + qz * sin);
  if (depth <= 0.05) return null;
  return { nx: p[0] / depth / (tanHalf * aspect), ny: (qy * sin - qz * cos) / depth / tanHalf };
}

/** Smallest slack (limit − |NDC|) over the fit points; negative when something is outside. Also the top and
 *  bottom slack, to centre the table vertically. */
function slack(pts: FitPoint[], distance: number, tz: number, aspect: number): { min: number; top: number; bottom: number } {
  let min = Infinity;
  let top = Infinity;
  let bottom = Infinity;
  for (const { p, lx, ly } of pts) {
    const q = project(p, distance, tz, aspect);
    if (!q) return { min: -Infinity, top: -Infinity, bottom: -Infinity };
    top = Math.min(top, ly - q.ny);
    bottom = Math.min(bottom, ly + q.ny);
    min = Math.min(min, lx - Math.abs(q.nx), top, bottom);
  }
  return { min, top, bottom };
}

function fitDistance(pts: FitPoint[], tz: number, aspect: number): number {
  let lo = 2;
  let hi = 400;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (slack(pts, mid, tz, aspect).min < 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The camera for a view of `aspect` (width / height): ~35° tilt, fov 40, looking at the table (the target is
 * moved along z by at most a little so the table sits centred on screen, since the near side projects larger),
 * as close as it can be while every seat HUD and the rail stay inside the view. Narrower views move it back.
 * `viewport` gives the view and HUD sizes in CSS px; without it a 600 px tall view with 120×62 px HUDs is assumed.
 */
export function cameraFor(aspect: number, viewport?: CameraViewport): { position: Vec3; fov: number; lookAt: Vec3 } {
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  const height = viewport && viewport.height > 0 ? viewport.height : 600;
  const width = viewport && viewport.width > 0 ? viewport.width : height * a;
  const vp: Required<CameraViewport> = {
    width,
    height,
    hudWidth: viewport?.hudWidth ?? 120,
    hudHeight: viewport?.hudHeight ?? 62,
  };
  const pts = fitPoints(vp);
  // Balance top and bottom slack by moving the target along z (bisection; more tz moves the table up on screen).
  let lo = -1.5;
  let hi = 1.5;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const s = slack(pts, fitDistance(pts, mid, a), mid, a);
    if (s.top > s.bottom) lo = mid;
    else hi = mid;
  }
  const tz = (lo + hi) / 2;
  const d = fitDistance(pts, tz, a);
  const t = (CAMERA_TILT_DEG * Math.PI) / 180;
  return {
    position: [0, round(d * Math.cos(t)), round(tz + d * Math.sin(t))],
    fov: CAMERA_FOV,
    lookAt: [0, 0, round(tz)],
  };
}
