import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/anim/tween.js';
import {
  SEAT_RX,
  SEAT_RZ,
  betPosition,
  boardPosition,
  buttonPosition,
  cameraFor,
  dealerPosition,
  makeScene,
  muckPosition,
  potPosition,
  seatPosition,
} from '../src/table/layout.js';
import { cardPlacePosition } from '../src/table/sceneContext.js';

const SEAT_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9];
const viewers = (n: number): (number | null)[] => [null, ...Array.from({ length: n }, (_, i) => i)];
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const insideEllipse = ([x, , z]: Vec3): boolean => (x / SEAT_RX) ** 2 + (z / SEAT_RZ) ** 2 < 1;
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe('seatPosition', () => {
  it('gives distinct positions for every seat count 2..9', () => {
    for (const n of SEAT_COUNTS) {
      for (const me of viewers(n)) {
        const ps = Array.from({ length: n }, (_, s) => seatPosition(s, n, me));
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) expect(dist(ps[i]!, ps[j]!)).toBeGreaterThan(1.2);
      }
    }
  });

  it('puts the viewer at bottom centre for every mySeat (seat 0 when null)', () => {
    for (const n of SEAT_COUNTS) {
      for (const me of viewers(n)) {
        const [x, , z] = seatPosition(me ?? 0, n, me);
        expect(x).toBe(0);
        expect(z).toBe(SEAT_RZ);
        for (let s = 0; s < n; s++) expect(seatPosition(s, n, me)[2]).toBeLessThanOrEqual(SEAT_RZ);
      }
    }
  });

  it('goes clockwise as the viewer sees it: the next seat is to the viewer’s left', () => {
    for (const n of SEAT_COUNTS) {
      for (const me of viewers(n)) {
        const next = ((me ?? 0) + 1) % n;
        if (n > 2) expect(seatPosition(next, n, me)[0]).toBeLessThan(0);
      }
    }
  });

  it('is left/right symmetric', () => {
    for (const n of SEAT_COUNTS) {
      for (const me of viewers(n)) {
        const v = me ?? 0;
        for (let k = 1; k < n; k++) {
          const a = seatPosition((v + k) % n, n, me);
          const b = seatPosition((v + n - k) % n, n, me);
          expect(close(a[0], -b[0])).toBe(true);
          expect(close(a[2], b[2])).toBe(true);
          const ba = betPosition((v + k) % n, n, me);
          const bb = betPosition((v + n - k) % n, n, me);
          expect(close(ba[0], -bb[0])).toBe(true);
          expect(close(ba[2], bb[2])).toBe(true);
        }
      }
    }
  });

  it('lies on the ellipse', () => {
    for (const n of SEAT_COUNTS)
      for (let s = 0; s < n; s++) {
        const [x, , z] = seatPosition(s, n, null);
        expect((x / SEAT_RX) ** 2 + (z / SEAT_RZ) ** 2).toBeCloseTo(1, 6);
      }
  });
});

describe('bets, button, board, pots', () => {
  it('keeps bet and button positions inside the ellipse', () => {
    for (const n of SEAT_COUNTS)
      for (const me of viewers(n))
        for (let s = 0; s < n; s++) {
          expect(insideEllipse(betPosition(s, n, me))).toBe(true);
          expect(insideEllipse(buttonPosition(s, n, me))).toBe(true);
        }
  });

  it('puts the board in a centred row and pot 0 above it', () => {
    const xs = [0, 1, 2, 3, 4].map((i) => boardPosition(i)[0]);
    expect(xs[2]).toBe(0);
    expect(close(xs[0]!, -xs[4]!)).toBe(true);
    for (let i = 1; i < 5; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(potPosition(0)[0]).toBe(0);
    expect(potPosition(0)[2]).toBeLessThan(boardPosition(0)[2]);
    expect(potPosition(1)[0]).toBeLessThan(0);
    expect(potPosition(2)[0]).toBeGreaterThan(0);
    expect(dealerPosition[2]).toBeLessThan(potPosition(0)[2]);
    expect(muckPosition[0]).toBeLessThan(boardPosition(0)[0]);
  });

  it('lets nothing overlap for any seat count and viewer', () => {
    for (const n of SEAT_COUNTS) {
      for (const me of viewers(n)) {
        const scene = makeScene(n, me);
        const items: { name: string; p: Vec3; seat?: number }[] = [];
        for (let s = 0; s < n; s++) {
          items.push({ name: `bet${s}`, p: scene.betPosition(s), seat: s });
          items.push({ name: `button${s}`, p: scene.buttonPosition(s), seat: s });
          for (const index of [0, 1] as const)
            items.push({ name: `hole${s}.${index}`, p: cardPlacePosition(scene, { at: 'seat', seat: s, index }), seat: s });
        }
        for (let i = 0; i < 5; i++) items.push({ name: `board${i}`, p: scene.boardPosition(i) });
        for (let i = 0; i < n - 1; i++) items.push({ name: `pot${i}`, p: scene.potPosition(i) });
        items.push({ name: 'dealer', p: scene.dealerPosition });
        items.push({ name: 'muck', p: scene.muckPosition });
        for (let i = 0; i < items.length; i++)
          for (let j = i + 1; j < items.length; j++) {
            const a = items[i]!;
            const b = items[j]!;
            // A seat's two hole cards sit side by side by design, and only one seat holds the button at a time.
            if (a.name.startsWith('hole') && b.name.startsWith('hole') && a.seat === b.seat) continue;
            if (a.name.startsWith('button') && b.name.startsWith('button')) continue;
            const d = dist(a.p, b.p);
            if (d < 0.4) throw new Error(`n=${n} me=${me}: ${a.name} and ${b.name} are ${d.toFixed(2)} apart`);
          }
      }
    }
  });

  it('makeScene binds the seat count and viewer', () => {
    const scene = makeScene(6, 3);
    expect(scene.maxSeats).toBe(6);
    expect(scene.mySeat).toBe(3);
    expect(scene.seatPosition(3)).toEqual(seatPosition(3, 6, 3));
    expect(scene.betPosition(1)).toEqual(betPosition(1, 6, 3));
    expect(scene.buttonPosition(5)).toEqual(buttonPosition(5, 6, 3));
  });
});

describe('cameraFor', () => {
  it('uses fov 40, looks at the centre and tilts about 35°', () => {
    const c = cameraFor(1.6);
    expect(c.fov).toBe(40);
    expect(c.lookAt).toEqual([0, 0, 0]);
    const [x, y, z] = c.position;
    expect(x).toBe(0);
    const tiltDeg = (Math.atan2(z, y) * 180) / Math.PI;
    expect(tiltDeg).toBeGreaterThan(30);
    expect(tiltDeg).toBeLessThan(40);
  });

  it('moves back as the aspect ratio narrows', () => {
    const len = (aspect: number): number => Math.hypot(...cameraFor(aspect).position);
    expect(len(390 / 700)).toBeGreaterThan(len(1));
    expect(len(1)).toBeGreaterThan(len(1280 / 800));
    expect(len(0.4)).toBeGreaterThan(len(390 / 700));
  });

  for (const [label, w, h] of [
    ['390×700 portrait', 390, 700],
    ['390×844 portrait', 390, 844],
    ['1280×800', 1280, 800],
    ['1920×1080', 1920, 1080],
  ] as const) {
    it(`keeps every seat of 9 in view at ${label}`, () => {
      const c = cameraFor(w / h);
      const camera = new PerspectiveCamera(c.fov, w / h, 0.1, 500);
      camera.position.set(...c.position);
      camera.lookAt(new Vector3(...c.lookAt));
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      for (const me of [null, 0, 4, 8]) {
        for (let s = 0; s < 9; s++) {
          const v = new Vector3(...seatPosition(s, 9, me)).project(camera);
          expect(Math.abs(v.x)).toBeLessThan(0.9);
          expect(Math.abs(v.y)).toBeLessThan(0.9);
          expect(v.z).toBeLessThan(1);
        }
      }
    });
  }
});
