/**
 * Cards (W6, PLAN I-11). Renders one object per `CardEntity` in the store, declaratively. A card's position
 * comes only from `useTweenedPosition` (trace series `obj:<entity id>`); the arc lift, landing settle and
 * flip clearance are pure functions of the tweened values (see cardMotion.ts). Flip, fade and scale are
 * `useTween`s.
 *
 * - Board cards (and any card that is not a hole card) are thin 3D boxes with canvas textures, tilted toward
 *   the camera so the faces read at the 35° camera.
 * - Hole cards are DOM, drawn through `DomAnchor` above the seat HUDs (which are DOM on top of the canvas and
 *   would otherwise hide them). The anchor still moves with the tweened position (deck → seat → muck); at a
 *   seat the card sits at a screen-space offset from the HUD centre (`holeCardLayout`): the viewer's pair beside
 *   their HUD, large and face up; an opponent's pair over their HUD's avatar, growing at showdown.
 */
import { useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Card } from '@poker/engine';
import { easeInOutCubic, easeOutCubic, useTween, useTweenedPosition, type Vec3 } from '../anim/tween.js';
import {
  arcLift,
  CARD_FADE_MS,
  CARD_FLIP_MS,
  cardMotion,
  flipLift,
  holeCardLayout,
  holeIndexOf,
  opponentCandidates,
  pickSpot,
  tableObstacles,
  tableProjector,
  holeSeatOf,
  liftedPosition,
  offsetWeight,
  placeYaw,
  settleYaw,
  showsFace,
  travelFraction,
  type CardMotion,
} from './cardMotion.js';
import { cardBackTexture, cardFaceTexture, rankLabel, suitColour, suitSymbol } from './cardTexture.js';
import { DomAnchor } from './DomAnchor.js';
import { useScene, type Scene } from './sceneContext.js';
import { useTable } from './storeContext.js';
import type { CardEntity } from './types.js';

/** Board card size in world units (poker ratio 2.5 : 3.5; the board slots are 0.62 apart), and thickness. */
export const CARD_WIDTH = 0.54;
export const CARD_HEIGHT = 0.756;
export const CARD_THICKNESS = 0.008;
/** Tilt toward the camera (rotation about x, far edge up) so faces read at the 35° camera. */
export const CARD_TILT = 0.38;
/** Board cards on a narrow canvas are drawn larger (they overlap a little; each index stays visible). */
export const NARROW_CANVAS_PX = 600;
export const NARROW_BOARD_SCALE = 1.55;
/** DOM z-index of hole cards: above seat HUDs (20), bet labels (15) and the dealer button (10). */
export const HOLE_CARD_Z = 25;

const textureCache = new Map<string, THREE.CanvasTexture>();

/**
 * One shared card geometry whose origin is the middle of the card's far (top) edge: the card hangs toward the
 * camera from its place point. So the board row sits a little below its slots, clear of the pot above it, and a
 * card drawn larger on a narrow canvas grows downward and sideways, never up into the pot label.
 */
let cardGeometry: THREE.BoxGeometry | null = null;
function sharedCardGeometry(): THREE.BoxGeometry {
  if (!cardGeometry) {
    cardGeometry = new THREE.BoxGeometry(CARD_WIDTH, CARD_THICKNESS, CARD_HEIGHT).translate(0, 0, CARD_HEIGHT / 2);
  }
  return cardGeometry;
}

function canvasTexture(key: string, make: () => HTMLCanvasElement): THREE.CanvasTexture {
  let tex = textureCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(make());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    textureCache.set(key, tex);
  }
  return tex;
}

function faceTexture(card: Card, fourColour: boolean): THREE.CanvasTexture {
  return canvasTexture(`face:${card}:${fourColour ? 4 : 2}`, () => cardFaceTexture(card, fourColour));
}

function backTexture(): THREE.CanvasTexture {
  return canvasTexture('back', cardBackTexture);
}

// ---------------------------------------------------------------------------------------------------------
// Shared motion

interface TravelMemo {
  key: string;
  start: Vec3;
  startYaw: number;
  lastYaw: number;
  fromSeat: boolean;
  lastWeight: number;
}

interface CardPose {
  motion: CardMotion;
  /** Displayed position: the tweened position plus the arc lift (and the flip clearance for 3D cards). */
  pos: Vec3;
  /** Travel fraction of the current move, 0..1. */
  f: number;
  yaw: number;
  flip: number;
  opacity: number;
  /** Weight of the hole card's screen offset (1 at a seat). */
  weight: number;
}

/** Everything that moves a card, all driven by tweens. `flipHalfWidth` > 0 lifts the card while it flips. */
function useCardPose(entity: CardEntity, scene: Scene): CardPose {
  const motion = cardMotion(entity, scene);
  const pos = useTweenedPosition(entity.id, motion.target, {
    from: motion.from,
    delayMs: motion.delayMs,
    durationMs: motion.durationMs,
    ease: motion.ease,
  });
  const flip = useTween(showsFace(entity) ? 1 : 0, {
    id: 'flip:' + entity.id,
    durationMs: CARD_FLIP_MS,
    ease: easeInOutCubic,
  });
  const opacity = useTween(entity.fading ? 0 : 1, {
    id: 'fade:' + entity.id,
    durationMs: CARD_FADE_MS,
    ease: easeInOutCubic,
  });

  // Remember where the current move started (the displayed position when the target changed), so the arc,
  // the settle and the screen offset follow the tweened position. Nothing here writes a position.
  const toSeat = entity.place.at === 'seat';
  const toYaw = placeYaw(entity.place, entity.id);
  const key = `${motion.target[0]},${motion.target[1]},${motion.target[2]}`;
  const memo = useRef<TravelMemo | null>(null);
  if (memo.current === null) {
    const startYaw = entity.spawnFrom ? placeYaw(entity.spawnFrom, entity.id) : toYaw;
    const fromSeat = entity.spawnFrom ? entity.spawnFrom.at === 'seat' : toSeat;
    memo.current = { key, start: pos, startYaw, lastYaw: startYaw, fromSeat, lastWeight: fromSeat ? 1 : 0 };
  } else if (memo.current.key !== key) {
    const m = memo.current;
    memo.current = { key, start: pos, startYaw: m.lastYaw, lastYaw: m.lastYaw, fromSeat: m.lastWeight > 0.5, lastWeight: m.lastWeight };
  }
  const m = memo.current;
  const f = travelFraction(m.start, motion.target, pos);
  const yaw = settleYaw(m.startYaw, toYaw, f);
  const weight = offsetWeight(m.fromSeat, toSeat, f);
  m.lastYaw = yaw;
  m.lastWeight = weight;
  return { motion, pos, f, yaw, flip, opacity, weight };
}

// ---------------------------------------------------------------------------------------------------------
// 3D cards (board)

function useNarrowCanvas(): boolean {
  return useSyncExternalStore(subscribeResize, narrowCanvasSnapshot, () => false);
}

function MeshCard({ entity, fourColour }: { entity: CardEntity; fourColour: boolean }) {
  const scene = useScene();
  const pose = useCardPose(entity, scene);
  const narrow = useNarrowCanvas();
  const scale = useTween(narrow ? NARROW_BOARD_SCALE : 1, {
    id: 'scale:' + entity.id,
    durationMs: pose.motion.durationMs,
    ease: easeOutCubic,
  });
  // Overlapping neighbours (narrow canvas) stack left to right by a hair, so the right card covers cleanly.
  const stack = entity.place.at === 'board' ? entity.place.index * 0.004 : 0;
  // The tilt (about the far edge) dips the near edge: lift by that much so the whole card stays above the felt.
  const tiltClear = CARD_HEIGHT * Math.sin(CARD_TILT) * scale;
  const shown = liftedPosition(
    pose.pos,
    arcLift(pose.f) + flipLift(pose.flip, (CARD_WIDTH * scale) / 2) + tiltClear + stack,
  );

  const face = useMemo(
    () => (entity.card === null ? backTexture() : faceTexture(entity.card, fourColour)),
    [entity.card, fourColour],
  );
  const back = backTexture();
  const { opacity } = pose;
  const transparent = opacity < 1;

  return (
    <group position={shown} rotation={[CARD_TILT, pose.yaw, 0]} name={entity.id}>
      <mesh geometry={sharedCardGeometry()} rotation={[0, 0, (1 - pose.flip) * Math.PI]} scale={scale} castShadow>
        {/* BoxGeometry material order: +x, -x, +y (face), -y (back), +z, -z. */}
        <meshStandardMaterial attach="material-0" color="#f4f2ec" transparent={transparent} opacity={opacity} />
        <meshStandardMaterial attach="material-1" color="#f4f2ec" transparent={transparent} opacity={opacity} />
        <meshStandardMaterial
          attach="material-2"
          map={face}
          alphaTest={0.5}
          roughness={0.55}
          transparent={transparent}
          opacity={opacity}
        />
        <meshStandardMaterial
          attach="material-3"
          map={back}
          alphaTest={0.5}
          roughness={0.6}
          transparent={transparent}
          opacity={opacity}
        />
        <meshStandardMaterial attach="material-4" color="#f4f2ec" transparent={transparent} opacity={opacity} />
        <meshStandardMaterial attach="material-5" color="#f4f2ec" transparent={transparent} opacity={opacity} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------------------
// DOM hole cards

function subscribeResize(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

function windowWidthSnapshot(): number {
  return window.innerWidth;
}

function narrowCanvasSnapshot(): boolean {
  // The table stage is about 70% of the window on desktop and the full width on phones.
  return window.innerWidth <= NARROW_CANVAS_PX;
}

const BACK_STYLE: CSSProperties = {
  background:
    'repeating-linear-gradient(45deg, rgba(39,132,90,0.55) 0 2px, transparent 2px 7px),' +
    'repeating-linear-gradient(-45deg, rgba(39,132,90,0.55) 0 2px, transparent 2px 7px), #134a31',
  boxShadow: 'inset 0 0 0 2px #fbfaf6, inset 0 0 0 3px #d9b45a',
};

function HoleCardFace({ card, fourColour, width }: { card: Card; fourColour: boolean; width: number }) {
  const colour = suitColour(card, fourColour);
  const rank = rankLabel(card);
  const rankPx = Math.round(width * (rank.length > 1 ? 0.42 : 0.5));
  const suitPx = Math.round(width * 0.42);
  const pipPx = Math.round(width * 0.62);
  return (
    <>
      <span
        style={{
          position: 'absolute',
          left: Math.max(1, Math.round(width * 0.07)),
          top: Math.max(0, Math.round(width * 0.03)),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          lineHeight: 1,
          color: colour,
          fontWeight: 800,
          letterSpacing: rank.length > 1 ? '-0.06em' : 0,
        }}
      >
        <span style={{ fontSize: rankPx }}>{rank}</span>
        <span style={{ fontSize: suitPx, marginTop: 1 }}>{suitSymbol(card)}</span>
      </span>
      <span
        style={{
          position: 'absolute',
          right: Math.round(width * 0.06),
          bottom: Math.round(width * 0.02),
          fontSize: pipPx,
          lineHeight: 1,
          color: colour,
        }}
      >
        {suitSymbol(card)}
      </span>
    </>
  );
}

interface CardRect {
  dx: number;
  dy: number;
  width: number;
  height: number;
  rotateDeg: number;
}

/** A hole card's spot (relative to the seat point) face down and face up. */
interface HoleLayout {
  down: CardRect;
  up: CardRect;
}

function myCardLayout(windowWidth: number, index: 0 | 1): HoleLayout {
  const l = holeCardLayout(true, windowWidth, index);
  const r = { dx: l.dx, dy: l.dy, width: l.width, height: l.height, rotateDeg: l.rotateDeg };
  return { down: r, up: r };
}

/**
 * An opponent's spot: the first free place around the seat box (beside it toward the table centre, above,
 * below…), found by projecting the table with the same camera Table3D uses (`cameraFor`), so the avatar, name
 * and stack, the neighbouring boxes, bets, the button, the board and the viewer's cards all stay uncovered.
 */
function opponentCardLayout(
  scene: Scene,
  seat: number,
  index: 0 | 1,
  windowWidth: number,
  canvasW: number,
  canvasH: number,
): HoleLayout {
  const width = canvasW > 0 ? canvasW : 912;
  const height = canvasH > 0 ? canvasH : 513;
  const project = tableProjector(width, height, windowWidth);
  const seatPos = scene.seatPosition(seat);
  const at = project(seatPos);
  const towardRight = seatPos[0] <= 0.01;
  const side = index === 0 ? -1 : 1;
  const rect = (faceUp: boolean): CardRect => {
    const spot = pickSpot(
      at,
      opponentCandidates(towardRight, windowWidth, faceUp),
      tableObstacles(project, scene, windowWidth, faceUp),
      { width, height },
    );
    return {
      dx: spot.cx + (side * spot.fan) / 2,
      dy: spot.cy,
      width: spot.cardW,
      height: spot.cardH,
      rotateDeg: side * 3,
    };
  };
  return { down: rect(false), up: rect(true) };
}

function HoleCard({ entity, seat, fourColour }: { entity: CardEntity; seat: number; fourColour: boolean }) {
  const scene = useScene();
  const pose = useCardPose(entity, scene);
  const windowWidth = useSyncExternalStore(subscribeResize, windowWidthSnapshot, () => 1280);
  const canvasW = useThree((st) => st.size.width);
  const canvasH = useThree((st) => st.size.height);
  // A card dealt to the viewer stays laid out as the viewer's, even if the viewer leaves the seat (busts) while
  // it is still on its way to the muck.
  const wasMine = useRef(false);
  if (scene.mySeat !== null && seat === scene.mySeat) wasMine.current = true;
  const mine = wasMine.current;
  const index = holeIndexOf(entity.id);
  const layout = useMemo(
    () => (mine ? myCardLayout(windowWidth, index) : opponentCardLayout(scene, seat, index, windowWidth, canvasW, canvasH)),
    [mine, scene, seat, index, windowWidth, canvasW, canvasH],
  );
  const shown = liftedPosition(pose.pos, arcLift(pose.f));

  // Face down → face up blends the spot and size with the flip tween (an opponent's pair moves to a larger
  // spot at showdown); the screen offset blends in over the travel (`pose.weight`).
  const k = pose.flip;
  const pick = (down: number, up: number) => down + (up - down) * k;
  const width = Math.round(pick(layout.down.width, layout.up.width));
  const height = Math.round(pick(layout.down.height, layout.up.height));
  const w = pose.weight;
  const dx = pick(layout.down.dx, layout.up.dx) * w;
  const dy = pick(layout.down.dy, layout.up.dy) * w;
  const rotate = (pose.yaw * 180) / Math.PI + layout.down.rotateDeg * w;

  const faceStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: Math.max(2, Math.round(width * 0.1)),
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
    overflow: 'hidden',
  };

  return (
    <group position={shown} name={entity.id}>
      <DomAnchor zIndex={mine ? HOLE_CARD_Z + 1 : HOLE_CARD_Z} pointerEvents="none">
        <div
          className="hole-card"
          data-card-entity={entity.id}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: dx,
            top: dy,
            width,
            height,
            opacity: pose.opacity,
            transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
            perspective: width * 6,
            filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))',
            fontFamily: '"Helvetica Neue", Arial, sans-serif',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              transformStyle: 'preserve-3d',
              transform: `rotateY(${(1 - pose.flip) * 180}deg)`,
            }}
          >
            <div style={{ ...faceStyle, background: '#fbfaf6', boxShadow: 'inset 0 0 0 1px #c9cdc9' }}>
              {entity.card !== null && (
                <HoleCardFace card={entity.card} fourColour={fourColour} width={width} />
              )}
            </div>
            <div style={{ ...faceStyle, ...BACK_STYLE, transform: 'rotateY(180deg)' }} />
          </div>
        </div>
      </DomAnchor>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------------------

/** Every card on the table. Lives inside the r3f Canvas (Table3D). */
export function Cards({ fourColour = false }: { fourColour?: boolean } = {}) {
  const cards = useTable((s) => s.cards);
  return (
    <>
      {cards.map((entity) => {
        const seat = holeSeatOf(entity.id);
        return seat === null ? (
          <MeshCard key={entity.id} entity={entity} fourColour={fourColour} />
        ) : (
          <HoleCard key={entity.id} entity={entity} seat={seat} fourColour={fourColour} />
        );
      })}
    </>
  );
}
