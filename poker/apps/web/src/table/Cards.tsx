/**
 * Cards (W6, PLAN I-11). Renders one mesh per `CardEntity` in the store, declaratively: a card's position
 * comes only from `useTweenedPosition` (trace series `obj:<entity id>`); the arc lift, landing settle and
 * flip clearance are pure functions of the tweened values (see cardMotion.ts). Flip and fade are `useTween`s.
 */
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Card } from '@poker/engine';
import { easeInOutCubic, useTween, useTweenedPosition, type Vec3 } from '../anim/tween.js';
import {
  arcLift,
  CARD_FADE_MS,
  CARD_FLIP_MS,
  cardMotion,
  flipLift,
  liftedPosition,
  placeYaw,
  settleYaw,
  showsFace,
  travelFraction,
} from './cardMotion.js';
import { cardBackTexture, cardFaceTexture } from './cardTexture.js';
import { useScene, type Scene } from './sceneContext.js';
import { useTable } from './storeContext.js';
import type { CardEntity } from './types.js';

/** Card size in world units (poker ratio 2.5 : 3.5), and its thickness. */
export const CARD_WIDTH = 0.36;
export const CARD_HEIGHT = 0.504;
export const CARD_THICKNESS = 0.006;
/** The viewer's own hole cards are drawn larger. */
export const MY_CARD_SCALE = 1.2;
/** Tilt toward the camera (rotation about x, far edge up) so faces read at the 35° camera. */
export const CARD_TILT = 0.12;

const textureCache = new Map<string, THREE.CanvasTexture>();

function canvasTexture(key: string, make: () => HTMLCanvasElement): THREE.CanvasTexture {
  let tex = textureCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(make());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
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

function isMine(entity: CardEntity, scene: Scene): boolean {
  return entity.place.at === 'seat' && scene.mySeat !== null && entity.place.seat === scene.mySeat;
}

interface TravelMemo {
  key: string;
  start: Vec3;
  startYaw: number;
  lastYaw: number;
}

function CardMesh({ entity, fourColour }: { entity: CardEntity; fourColour: boolean }) {
  const scene = useScene();
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
  const scale = useTween(isMine(entity, scene) ? MY_CARD_SCALE : 1, {
    id: 'scale:' + entity.id,
    durationMs: motion.durationMs,
    ease: motion.ease,
  });

  // Remember where the current move started (the displayed position when the target changed), so the arc
  // and the settle follow the tweened position. Read-only with respect to position: nothing here writes it.
  const toYaw = placeYaw(entity.place, entity.id);
  const key = `${motion.target[0]},${motion.target[1]},${motion.target[2]}`;
  const memo = useRef<TravelMemo | null>(null);
  if (memo.current === null) {
    const startYaw = entity.spawnFrom ? placeYaw(entity.spawnFrom, entity.id) : toYaw;
    memo.current = { key, start: pos, startYaw, lastYaw: startYaw };
  } else if (memo.current.key !== key) {
    memo.current = { key, start: pos, startYaw: memo.current.lastYaw, lastYaw: memo.current.lastYaw };
  }
  const f = travelFraction(memo.current.start, motion.target, pos);
  const yaw = settleYaw(memo.current.startYaw, toYaw, f);
  memo.current.lastYaw = yaw;

  const shown = liftedPosition(pos, arcLift(f) + flipLift(flip, (CARD_WIDTH * scale) / 2));

  const face = useMemo(
    () => (entity.card === null ? backTexture() : faceTexture(entity.card, fourColour)),
    [entity.card, fourColour],
  );
  const back = backTexture();
  const transparent = opacity < 1;

  return (
    <group position={shown} rotation={[CARD_TILT, yaw, 0]} name={entity.id}>
      <mesh rotation={[0, 0, (1 - flip) * Math.PI]} scale={scale} castShadow>
        <boxGeometry args={[CARD_WIDTH, CARD_THICKNESS, CARD_HEIGHT]} />
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

/** Every card on the table. Lives inside the r3f Canvas (Table3D). */
export function Cards({ fourColour = false }: { fourColour?: boolean } = {}) {
  const cards = useTable((s) => s.cards);
  return (
    <>
      {cards.map((entity) => (
        <CardMesh key={entity.id} entity={entity} fourColour={fourColour} />
      ))}
    </>
  );
}
