import { describe, expect, it } from 'vitest';
import { compare, evaluate5, evaluate7 } from '../src/evaluator.js';
import type { HandCategory } from '../src/evaluator.js';
import type { Card } from '../src/types.js';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

/** Local parser: "As Kd 2c" -> cards. */
function parse(s: string): Card[] {
  return s.trim().split(/\s+/).map((tok) => {
    const r = RANKS.indexOf(tok[0]!.toUpperCase());
    const su = SUITS.indexOf(tok[1]!.toLowerCase());
    if (tok.length !== 2 || r < 0 || su < 0) throw new Error(`bad card: ${tok}`);
    return r * 4 + su;
  });
}

const e5 = (s: string) => evaluate5(parse(s));
const e7 = (s: string) => evaluate7(parse(s));

describe('evaluate5 exhaustive', () => {
  it('produces the exact category counts over all 2,598,960 hands', () => {
    const counts: Record<HandCategory, number> = {
      highCard: 0, pair: 0, twoPair: 0, trips: 0, straight: 0, flush: 0, fullHouse: 0, quads: 0, straightFlush: 0,
    };
    const hand: Card[] = [0, 0, 0, 0, 0];
    let total = 0;
    for (let a = 0; a < 48; a++) {
      hand[0] = a;
      for (let b = a + 1; b < 49; b++) {
        hand[1] = b;
        for (let c = b + 1; c < 50; c++) {
          hand[2] = c;
          for (let d = c + 1; d < 51; d++) {
            hand[3] = d;
            for (let e = d + 1; e < 52; e++) {
              hand[4] = e;
              counts[evaluate5(hand).category]++;
              total++;
            }
          }
        }
      }
    }
    expect(total).toBe(2_598_960);
    expect(counts).toEqual({
      straightFlush: 40,
      quads: 624,
      fullHouse: 3_744,
      flush: 5_108,
      straight: 10_200,
      trips: 54_912,
      twoPair: 123_552,
      pair: 1_098_240,
      highCard: 1_302_540,
    });
  }, 120_000);
});

describe('compare: hand-picked', () => {
  // [winner, loser] or tie
  const wins: [string, string, string][] = [
    ['six-high straight beats wheel', '2c 3d 4h 5s 6c', 'Ac 2d 3h 4s 5c'],
    ['wheel beats trips', 'Ac 2d 3h 4s 5c', 'Kc Kd Kh 4s 2c'],
    ['broadway beats king-high straight', 'Tc Jd Qh Ks Ac', '9c Td Jh Qs Kc'],
    ['steel wheel loses to 6-high straight flush', '2h 3h 4h 5h 6h', 'Ah 2h 3h 4h 5h'],
    ['pair kicker: AAK beats AAQ', 'As Ad Kc 7h 2d', 'Ah Ac Qs 7d 2s'],
    ['pair: third kicker decides', 'Js Jd 9c 7h 4d', 'Jh Jc 9s 7d 3s'],
    ['high card: last card decides', 'Ks Qd 9c 7h 4d', 'Kh Qc 9s 7d 3s'],
    ['flush vs flush decided by 5th card', 'Ah Jh 9h 6h 4h', 'As Js 9s 6s 3s'],
    ['flush beats straight', '2h 5h 7h 9h Jh', 'Tc Jd Qh Ks Ac'],
    ['full house: trips rank first', '3c 3d 3h 2s 2c', '2d 2h 2s Ac Ad'],
    ['full house: same trips, pair decides', 'Kc Kd Kh 5s 5c', 'Ks Kh Kd 4s 4c'],
    ['full house beats flush', '2c 2d 2h 3s 3c', 'Ah Kh Qh Jh 9h'],
    ['two pair: higher top pair wins', 'Kc Kd 2h 2s 3c', 'Qc Qd Jh Js Ac'],
    ['two pair: lower pair decides', 'Kc Kd 5h 5s 2c', 'Kh Ks 4h 4s Ac'],
    ['two pair: kicker decides', 'Kc Kd 5h 5s 9c', 'Kh Ks 5d 5c 8c'],
    ['quads kicker decides', '9c 9d 9h 9s Ac', '9c 9d 9h 9s Kc'],
    ['quads beat full house', '2c 2d 2h 2s 3c', 'Ac Ad Ah Ks Kc'],
    ['trips kicker decides', '7c 7d 7h As 2c', '7c 7d 7h Ks Qc'],
  ];
  for (const [label, a, b] of wins) {
    it(label, () => {
      const va = e5(a), vb = e5(b);
      expect(compare(va, vb)).toBeGreaterThan(0);
      expect(compare(vb, va)).toBeLessThan(0);
    });
  }

  it('board plays: both players tie on a board straight', () => {
    const board = 'Tc Jd Qh Ks Ac';
    const p1 = e7(`${board} 2c 3d`);
    const p2 = e7(`${board} 4h 7s`);
    expect(compare(p1, p2)).toBe(0);
    expect(p1.score).toBe(p2.score);
  });

  it('suits never break ties', () => {
    expect(compare(e5('Ah Kh Qd Js 9c'), e5('As Ks Qc Jd 9h'))).toBe(0);
  });
});

describe('evaluate7 picks the best 5', () => {
  it('finds a flush hidden among 7 cards', () => {
    const v = e7('Ah 9h Kc 4h Ks 2h Jh');
    expect(v.category).toBe('flush');
    expect(v.score).toBe(e5('Ah Jh 9h 4h 2h').score);
  });

  it('makes a full house from two sets of trips', () => {
    const v = e7('8c 8d 8h 5s 5c 5d Ac');
    expect(v.category).toBe('fullHouse');
    expect(v.name).toBe('Full house, Eights over Fives');
  });

  it('works with 6 cards', () => {
    const v = e7('9c Tc Jd Qh Kh 2s');
    expect(v.category).toBe('straight');
    expect(v.name).toBe('Straight, King high');
  });

  it('works with exactly 5 cards (same as evaluate5)', () => {
    expect(e7('As Kd 7c 5h 2s').score).toBe(e5('As Kd 7c 5h 2s').score);
  });

  it('picks the highest straight among 7 connected cards', () => {
    expect(e7('3c 4d 5h 6s 7c 8d 9h').name).toBe('Straight, Nine high');
  });

  it('prefers a straight flush over a flush and a straight', () => {
    const v = e7('5h 6h 7h 8h 9h Ah Tc');
    expect(v.category).toBe('straightFlush');
    expect(v.name).toBe('Straight flush, Nine high');
  });

  it('chooses the best kickers for two pair with three pairs', () => {
    const v = e7('Kc Kd 7h 7s 3c 3d 2h');
    expect(v.score).toBe(e5('Kc Kd 7h 7s 3c').score);
  });

  it('throws on too few or too many cards', () => {
    expect(() => e7('As Kd 7c 5h')).toThrow();
    expect(() => e7('As Kd 7c 5h 2s 3s 4s 6s')).toThrow();
  });
});

describe('names', () => {
  const cases: [string, string][] = [
    ['Kc Kd Kh 4s 4c', 'Full house, Kings over Fours'],
    ['As Ad 9c 7h 2d', 'Pair of Aces'],
    ['Kc Kd 4h 4s 9c', 'Two pair, Kings and Fours'],
    ['7c 7d 7h As 2c', 'Three of a kind, Sevens'],
    ['Ac 2d 3h 4s 5c', 'Straight, Five high'],
    ['Ah Jh 9h 6h 4h', 'Flush, Ace high'],
    ['9c 9d 9h 9s Ac', 'Four of a kind, Nines'],
    ['9s Ts Js Qs Ks', 'Straight flush, King high'],
    ['Ts Js Qs Ks As', 'Royal flush'],
    ['Ac Jd 9h 6s 4c', 'High card, Ace'],
  ];
  for (const [hand, name] of cases) {
    it(name, () => {
      expect(e5(hand).name).toBe(name);
    });
  }
});

describe('evaluate5 input validation', () => {
  it('throws unless given exactly 5 cards', () => {
    expect(() => e5('As Kd 7c 5h')).toThrow();
    expect(() => e5('As Kd 7c 5h 2s 3s')).toThrow();
  });
  it('throws on duplicate or out-of-range cards', () => {
    expect(() => evaluate5([0, 0, 1, 2, 3])).toThrow();
    expect(() => evaluate5([0, 1, 2, 3, 52])).toThrow();
  });
});
