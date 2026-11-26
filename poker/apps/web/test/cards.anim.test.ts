import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { easeInOutCubic, easeOutBack, easeOutCubic, type Vec3 } from '../src/anim/easing.js';
import {
  arcLift,
  CARD_ARC_HEIGHT,
  cardMotion,
  holeCardLayout,
  holeIndexOf,
  holeSeatOf,
  liftedPosition,
  offsetWeight,
  opponentCandidates,
  pickSpot,
  seatBoxSize,
  tableObstacles,
  placeYaw,
  settleYaw,
  showsFace,
  travelFraction,
} from '../src/table/cardMotion.js';
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH, cardBackTexture, cardFaceTexture } from '../src/table/cardTexture.js';
import { cardPlacePosition, type Scene } from '../src/table/sceneContext.js';
import { DEAL_STAGGER_MS, type CardEntity } from '../src/table/types.js';

const scene: Scene = {
  maxSeats: 6,
  mySeat: 0,
  seatPosition: (seat) => [seat * 1.5 - 3, 0, 3],
  betPosition: (seat) => [seat, 0, 1.5],
  potPosition: (i) => [i * 0.4, 0, 0.6],
  boardPosition: (i) => [(i - 2) * 0.45, 0.02, 0],
  buttonPosition: (seat) => [seat, 0, 2],
  dealerPosition: [0, 0.05, -1.2],
  muckPosition: [1.6, 0.01, -0.9],
};

function entity(over: Partial<CardEntity>): CardEntity {
  return { id: 'card:h1:0:0', place: { at: 'deck' }, card: null, faceUp: false, order: 0, fading: false, ...over };
}

describe('cardMotion keyframes', () => {
  it('a deal: from the deck to the seat place, 380 ms easeOutCubic, delay = order × 90', () => {
    const e = entity({
      id: 'card:h1:2:1',
      place: { at: 'seat', seat: 2, index: 1 },
      spawnFrom: { at: 'deck' },
      order: 5,
    });
    const m = cardMotion(e, scene);
    expect(m.from).toEqual(scene.dealerPosition);
    expect(m.target).toEqual(cardPlacePosition(scene, { at: 'seat', seat: 2, index: 1 }));
    expect(m.durationMs).toBe(380);
    expect(m.ease).toBe(easeOutCubic);
    expect(m.ease.name).toBe('easeOutCubic');
    expect(m.delayMs).toBe(5 * DEAL_STAGGER_MS);
    expect(m.delayMs).toBe(450);
  });

  it('a board card: from the deck to its board slot, 380 ms easeOutCubic, staggered', () => {
    const e = entity({
      id: 'card:h1:board:2',
      place: { at: 'board', index: 2 },
      spawnFrom: { at: 'deck' },
      card: 12,
      faceUp: true,
      order: 2,
    });
    const m = cardMotion(e, scene);
    expect(m.from).toEqual(scene.dealerPosition);
    expect(m.target).toEqual(scene.boardPosition(2));
    expect(m.durationMs).toBe(380);
    expect(m.ease).toBe(easeOutCubic);
    expect(m.delayMs).toBe(180);
    expect(showsFace(e)).toBe(true);
  });

  it('a fold: to the muck, 300 ms easeInOutCubic, no spawn', () => {
    const e = entity({ id: 'card:h1:3:0', place: { at: 'muck' }, fading: true, order: 1 });
    const m = cardMotion(e, scene);
    expect(m.from).toBeUndefined();
    expect(m.target).toEqual(scene.muckPosition);
    expect(m.durationMs).toBe(300);
    expect(m.ease).toBe(easeInOutCubic);
    expect(m.delayMs).toBe(90);
  });

  it('a card already in place (snapshot) has no spawn point', () => {
    const m = cardMotion(entity({ place: { at: 'seat', seat: 0, index: 0 } }), scene);
    expect(m.from).toBeUndefined();
    expect(m.delayMs).toBe(0);
  });

  it('hidden cards never show a face; board cards with a value always do', () => {
    expect(showsFace(entity({ card: null, faceUp: true }))).toBe(false);
    expect(showsFace(entity({ card: 3, faceUp: true, place: { at: 'seat', seat: 1, index: 0 } }))).toBe(true);
    expect(showsFace(entity({ card: 3, faceUp: false, place: { at: 'seat', seat: 1, index: 0 } }))).toBe(false);
  });
});

describe('arc lift', () => {
  it('is 0 at both ends and the peak (0.3) at the middle', () => {
    expect(arcLift(0)).toBe(0);
    expect(arcLift(1)).toBe(0);
    expect(arcLift(0.5)).toBeCloseTo(0.3, 12);
    expect(CARD_ARC_HEIGHT).toBe(0.3);
    for (let f = 0; f <= 1; f += 0.05) {
      expect(arcLift(f)).toBeGreaterThanOrEqual(0);
      expect(arcLift(f)).toBeLessThanOrEqual(0.3 + 1e-12);
      expect(arcLift(f)).toBeCloseTo(0.3 * 4 * f * (1 - f), 12);
    }
    expect(arcLift(-1)).toBe(0);
    expect(arcLift(2)).toBe(0);
  });

  it('follows the tweened position along the straight line', () => {
    const start: Vec3 = [0, 0, -1];
    const target: Vec3 = [2, 0, 3];
    expect(travelFraction(start, target, start)).toBe(0);
    expect(travelFraction(start, target, target)).toBe(1);
    expect(travelFraction(start, target, [1, 0, 1])).toBeCloseTo(0.5, 12);
    expect(travelFraction(start, target, [3, 0, 5])).toBe(1);
    expect(travelFraction(target, target, target)).toBe(1); // no move = arrived
    const mid = liftedPosition([1, 0, 1], arcLift(travelFraction(start, target, [1, 0, 1])));
    expect(mid[0]).toBe(1);
    expect(mid[1]).toBeCloseTo(0.3, 12);
    expect(mid[2]).toBe(1);
  });

  it('the landing settle starts and ends at the place yaws (easeOutBack overshoot in between)', () => {
    const from = placeYaw({ at: 'deck' }, 'x');
    const to = placeYaw({ at: 'seat', seat: 0, index: 0 }, 'x');
    expect(settleYaw(from, to, 0)).toBe(from);
    expect(settleYaw(from, to, 1)).toBe(to);
    expect(settleYaw(from, to, 0.7)).toBeCloseTo(from + (to - from) * easeOutBack(0.7), 12);
    expect(placeYaw({ at: 'muck' }, 'card:a')).toBe(placeYaw({ at: 'muck' }, 'card:a'));
  });
});

describe('Cards.tsx source guard', () => {
  const src = readFileSync(resolve(__dirname, '../src/table/Cards.tsx'), 'utf8');

  it('sets a position only from the tweened value', () => {
    const props = src.match(/position=\{[^}]*\}/g) ?? [];
    expect(props.length).toBeGreaterThanOrEqual(2); // the 3D board card and the DOM hole card's anchor group
    for (const p of props) expect(p).toBe('position={shown}');
    expect(src.match(/useTweenedPosition\(/g)).toHaveLength(1);
    expect(src).toMatch(/const pos = useTweenedPosition\(entity\.id, motion\.target,/);
    for (const decl of src.match(/const shown = [^;]*;/g) ?? []) expect(decl).toMatch(/^const shown = liftedPosition\(\s*pose\.pos,/);
    expect(src.match(/const shown = /g)).toHaveLength(2);
    expect(src).not.toMatch(/\.position\s*\.(set|copy|lerp|add)\s*\(/);
    expect(src).not.toMatch(/\.position(\.[xyz])?\s*=[^=]/);
    expect(src).not.toMatch(/useFrame/);
  });

  it('uses named ease functions, never inline arrows', () => {
    expect(src).not.toMatch(/ease:\s*\(/);
    expect(src).not.toMatch(/ease=\{\s*\(/);
  });
});

describe('hole cards on screen', () => {
  it('reads the seat and index from a hole-card id; board ids have no seat', () => {
    expect(holeSeatOf('card:h1:3:0')).toBe(3);
    expect(holeSeatOf('card:a:b:7:1')).toBe(7);
    expect(holeSeatOf('card:h1:board:2')).toBeNull();
    expect(holeIndexOf('card:h1:3:1')).toBe(1);
    expect(holeIndexOf('card:h1:3:0')).toBe(0);
  });

  it('puts the viewer’s pair large and left of the HUD on desktop, below-left on a phone', () => {
    for (const index of [0, 1] as const) {
      const d = holeCardLayout(true, 1280, index);
      expect(d.width).toBeGreaterThanOrEqual(56);
      expect(d.height).toBeCloseTo(d.width * 1.4, 0);
      expect(d.dx + d.width / 2).toBeLessThanOrEqual(-60); // right edge left of the 120 px HUD
      const p = holeCardLayout(true, 390, index);
      expect(p.width).toBeGreaterThanOrEqual(30);
      expect(p.dx + p.width / 2).toBeLessThan(-36); // left of the 72 px compact HUD
      expect(p.dy).toBeGreaterThan(15); // and lower than its centre
    }
    expect(holeCardLayout(true, 1280, 0).dx).toBeLessThan(holeCardLayout(true, 1280, 1).dx);
  });

  it('puts an opponent’s pair over the HUD and grows it face up', () => {
    const d = holeCardLayout(false, 1280, 0);
    expect(Math.abs(d.dx)).toBeLessThan(30);
    expect(d.faceUpScale).toBeGreaterThan(1);
    const p = holeCardLayout(false, 390, 1);
    expect(p.width * p.faceUpScale).toBeGreaterThanOrEqual(22);
  });

  it('blends the screen offset in over the travel', () => {
    expect(offsetWeight(false, true, 0)).toBe(0);
    expect(offsetWeight(false, true, 0.5)).toBe(0.5);
    expect(offsetWeight(false, true, 1)).toBe(1);
    expect(offsetWeight(true, false, 1)).toBe(0);
    expect(offsetWeight(true, true, 0.3)).toBe(1);
  });
});

describe('opponent card spots', () => {
  const inside = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  it('never puts a candidate over the seat box itself (avatar, name, stack)', () => {
    for (const width of [390, 1280])
      for (const faceUp of [false, true])
        for (const right of [false, true]) {
          const box = seatBoxSize(width);
          const own = { x0: -box.w / 2, y0: -box.h / 2, x1: box.w / 2, y1: box.h / 2 };
          for (const c of opponentCandidates(right, width, faceUp)) {
            const r = { x0: c.cx - c.pairW / 2, y0: c.cy - c.pairH / 2, x1: c.cx + c.pairW / 2, y1: c.cy + c.pairH / 2 };
            expect(inside(r, own)).toBe(false);
          }
        }
  });

  it('prefers the side facing the table centre and skips spots that hit an obstacle', () => {
    const cands = opponentCandidates(true, 1280, false);
    expect(cands[0]!.cx).toBeGreaterThan(0);
    const canvas = { width: 900, height: 500 };
    expect(pickSpot([300, 250], cands, [], canvas)).toBe(cands[0]);
    const first = cands[0]!;
    const blocker = { x0: 300 + first.cx - 5, y0: 250 + first.cy - 5, x1: 300 + first.cx + 5, y1: 250 + first.cy + 5 };
    const picked = pickSpot([300, 250], cands, [blocker], canvas);
    expect(picked).not.toBe(first);
    const r = { x0: 300 + picked.cx - picked.pairW / 2, y0: 250 + picked.cy - picked.pairH / 2, x1: 300 + picked.cx + picked.pairW / 2, y1: 250 + picked.cy + picked.pairH / 2 };
    expect(inside(r, blocker)).toBe(false);
  });

  it('face-up pairs are larger than face-down ones', () => {
    for (const width of [390, 1280]) {
      const down = opponentCandidates(true, width, false)[0]!;
      const up = opponentCandidates(true, width, true)[0]!;
      expect(up.cardW).toBeGreaterThan(down.cardW);
      expect(up.cardW).toBeGreaterThanOrEqual(22);
    }
  });

  it('lists every seat box, bet, button, board slot, the pot and the viewer’s cards as obstacles', () => {
    const project = (p: Vec3) => [p[0] * 100 + 450, p[2] * 80 + 250] as const;
    const down = tableObstacles(project, scene, 1280, false);
    const up = tableObstacles(project, scene, 1280, true);
    // 6 seats × (box + bet + button) + 5 board + pot + 2 own cards; face up has no bets.
    expect(down).toHaveLength(6 * 3 + 5 + 1 + 2);
    expect(up).toHaveLength(6 * 2 + 5 + 1 + 2);
  });
});

describe('card textures', () => {
  it('cardFaceTexture returns a cached canvas of the expected size', () => {
    const c = cardFaceTexture(51);
    expect(c).toBeInstanceOf(HTMLCanvasElement);
    expect(c.width).toBe(CARD_TEXTURE_WIDTH);
    expect(c.height).toBe(CARD_TEXTURE_HEIGHT);
    expect(cardFaceTexture(51)).toBe(c);
    expect(cardFaceTexture(51, true)).not.toBe(c);
  });

  it('cardBackTexture returns one cached canvas of the same size', () => {
    const b = cardBackTexture();
    expect(b.width).toBe(CARD_TEXTURE_WIDTH);
    expect(b.height).toBe(CARD_TEXTURE_HEIGHT);
    expect(cardBackTexture()).toBe(b);
  });
});
