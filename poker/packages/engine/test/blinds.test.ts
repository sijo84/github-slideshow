import { describe, expect, it } from 'vitest';
import { blindSeats, forcedBets, levelAt, nextButton, validateLevels } from '../src/blinds.js';
import type { BlindLevel, SeatInput, Stakes } from '../src/types.js';

const seats = (...pairs: [number, number][]): SeatInput[] =>
  pairs.map(([seat, stack]) => ({ seat, playerId: `p${seat}`, stack }));

describe('nextButton', () => {
  it('starts at the lowest occupied seat', () => {
    expect(nextButton(null, [5, 2, 7], 9)).toBe(2);
  });
  it('moves to the next occupied seat', () => {
    expect(nextButton(2, [2, 3, 4], 9)).toBe(3);
  });
  it('skips empty seats', () => {
    expect(nextButton(2, [2, 6, 8], 9)).toBe(6);
  });
  it('wraps around', () => {
    expect(nextButton(8, [1, 4, 8], 9)).toBe(1);
    expect(nextButton(6, [1, 4, 6], 9)).toBe(1);
  });
  it('works when the previous button seat is now empty', () => {
    expect(nextButton(3, [1, 5, 7], 9)).toBe(5);
    expect(nextButton(8, [1, 5, 7], 9)).toBe(1);
  });
  it('returns the same seat when it is the only occupied one', () => {
    expect(nextButton(4, [4], 9)).toBe(4);
  });
  it('throws when no seat is occupied', () => {
    expect(() => nextButton(null, [], 9)).toThrow();
  });
});

describe('blindSeats', () => {
  it('heads-up: button is SB and acts first preflop, BB first postflop', () => {
    expect(blindSeats(3, [3, 7], 9)).toEqual({ sb: 3, bb: 7, firstToActPreflop: 3, firstToActPostflop: 7 });
    expect(blindSeats(7, [3, 7], 9)).toEqual({ sb: 7, bb: 3, firstToActPreflop: 7, firstToActPostflop: 3 });
  });
  it('3 players: button acts first preflop', () => {
    expect(blindSeats(0, [0, 1, 2], 9)).toEqual({ sb: 1, bb: 2, firstToActPreflop: 0, firstToActPostflop: 1 });
  });
  it('9 players', () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    expect(blindSeats(4, all, 9)).toEqual({ sb: 5, bb: 6, firstToActPreflop: 7, firstToActPostflop: 5 });
  });
  it('wraps around', () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    expect(blindSeats(7, all, 9)).toEqual({ sb: 8, bb: 0, firstToActPreflop: 1, firstToActPostflop: 8 });
    expect(blindSeats(8, all, 9)).toEqual({ sb: 0, bb: 1, firstToActPreflop: 2, firstToActPostflop: 0 });
  });
  it('handles non-contiguous seats', () => {
    expect(blindSeats(5, [1, 3, 5, 8], 9)).toEqual({ sb: 8, bb: 1, firstToActPreflop: 3, firstToActPostflop: 8 });
  });
  it('throws with fewer than two players or a button not dealt in', () => {
    expect(() => blindSeats(1, [1], 9)).toThrow();
    expect(() => blindSeats(2, [1, 3], 9)).toThrow();
  });
});

describe('forcedBets', () => {
  const base: Stakes = { smallBlind: 50, bigBlind: 100, ante: 0, anteKind: 'none' };

  it('no antes: small then big blind', () => {
    expect(forcedBets(base, 0, seats([0, 1000], [1, 1000], [2, 1000]), 9)).toEqual({
      antes: [],
      blinds: [
        { seat: 1, blind: 'small', amount: 50 },
        { seat: 2, blind: 'big', amount: 100 },
      ],
    });
  });

  it('ante amount with anteKind none is ignored', () => {
    const r = forcedBets({ ...base, ante: 10 }, 0, seats([0, 1000], [1, 1000]), 9);
    expect(r.antes).toEqual([]);
  });

  it('every-player antes listed clockwise from left of the button', () => {
    const r = forcedBets({ ...base, ante: 10, anteKind: 'every' }, 5, seats([1, 1000], [5, 1000], [8, 1000]), 9);
    expect(r.antes).toEqual([
      { seat: 8, amount: 10 },
      { seat: 1, amount: 10 },
      { seat: 5, amount: 10 },
    ]);
    expect(r.blinds).toEqual([
      { seat: 8, blind: 'small', amount: 50 },
      { seat: 1, blind: 'big', amount: 100 },
    ]);
  });

  it('every ante leaves a player with less than the blind', () => {
    const r = forcedBets({ ...base, ante: 10, anteKind: 'every' }, 0, seats([0, 1000], [1, 40], [2, 60]), 9);
    expect(r.antes).toEqual([
      { seat: 1, amount: 10 },
      { seat: 2, amount: 10 },
      { seat: 0, amount: 10 },
    ]);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 30 },
      { seat: 2, blind: 'big', amount: 50 },
    ]);
  });

  it('every ante that takes a whole stack omits that blind entry', () => {
    const r = forcedBets({ ...base, ante: 10, anteKind: 'every' }, 0, seats([0, 1000], [1, 1000], [2, 7]), 9);
    expect(r.antes).toContainEqual({ seat: 2, amount: 7 });
    expect(r.blinds).toEqual([{ seat: 1, blind: 'small', amount: 50 }]);
  });

  it('big blind ante: BB posts both', () => {
    const r = forcedBets({ ...base, ante: 100, anteKind: 'bigBlind' }, 0, seats([0, 1000], [1, 1000], [2, 1000]), 9);
    expect(r.antes).toEqual([{ seat: 2, amount: 100 }]);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 50 },
      { seat: 2, blind: 'big', amount: 100 },
    ]);
  });

  it('big blind ante heads-up: the non-button seat posts the ante', () => {
    const r = forcedBets({ ...base, ante: 100, anteKind: 'bigBlind' }, 4, seats([4, 1000], [6, 1000]), 9);
    expect(r.antes).toEqual([{ seat: 6, amount: 100 }]);
    expect(r.blinds).toEqual([
      { seat: 4, blind: 'small', amount: 50 },
      { seat: 6, blind: 'big', amount: 100 },
    ]);
  });

  it('big blind ante (TDA Rule 4): BB covers the blind but only part of the ante', () => {
    const r = forcedBets({ ...base, ante: 100, anteKind: 'bigBlind' }, 0, seats([0, 1000], [1, 1000], [2, 130]), 9);
    expect(r.antes).toEqual([{ seat: 2, amount: 30 }]);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 50 },
      { seat: 2, blind: 'big', amount: 100 },
    ]);
  });

  it('big blind ante (TDA Rule 4): BB cannot cover the blind, ante entry omitted', () => {
    const r = forcedBets({ ...base, ante: 100, anteKind: 'bigBlind' }, 0, seats([0, 1000], [1, 1000], [2, 70]), 9);
    expect(r.antes).toEqual([]);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 50 },
      { seat: 2, blind: 'big', amount: 70 },
    ]);
  });

  it('short-stacked small blind', () => {
    const r = forcedBets(base, 0, seats([0, 1000], [1, 20], [2, 1000]), 9);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 20 },
      { seat: 2, blind: 'big', amount: 100 },
    ]);
  });

  it('short-stacked big blind', () => {
    const r = forcedBets(base, 0, seats([0, 1000], [1, 1000], [2, 60]), 9);
    expect(r.blinds).toEqual([
      { seat: 1, blind: 'small', amount: 50 },
      { seat: 2, blind: 'big', amount: 60 },
    ]);
  });

  it('9 players with wraparound blinds', () => {
    const nine = seats(...([0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => [s, 1000]) as [number, number][]));
    const r = forcedBets({ ...base, ante: 10, anteKind: 'every' }, 8, nine, 9);
    expect(r.antes.map((a) => a.seat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.blinds).toEqual([
      { seat: 0, blind: 'small', amount: 50 },
      { seat: 1, blind: 'big', amount: 100 },
    ]);
  });
});

const lvl = (level: number, smallBlind: number, bigBlind: number, durationMinutes = 10, ante = 0): BlindLevel => ({
  level,
  smallBlind,
  bigBlind,
  ante,
  anteKind: ante > 0 ? 'bigBlind' : 'none',
  durationMinutes,
});

describe('levelAt', () => {
  const levels = [lvl(1, 10, 20, 10), lvl(2, 20, 40, 5), lvl(3, 50, 100, 20)];
  const MIN = 60_000;
  const t0 = 1_000_000;

  it('at the start', () => {
    expect(levelAt(levels, t0, t0, 0)).toEqual({ index: 0, msLeft: 10 * MIN });
  });
  it('before the start counts as zero elapsed', () => {
    expect(levelAt(levels, t0, t0 - 5000, 0)).toEqual({ index: 0, msLeft: 10 * MIN });
  });
  it('mid level', () => {
    expect(levelAt(levels, t0, t0 + 12 * MIN, 0)).toEqual({ index: 1, msLeft: 3 * MIN });
  });
  it('exactly at a level boundary moves to the next level', () => {
    expect(levelAt(levels, t0, t0 + 10 * MIN - 1, 0)).toEqual({ index: 0, msLeft: 1 });
    expect(levelAt(levels, t0, t0 + 10 * MIN, 0)).toEqual({ index: 1, msLeft: 5 * MIN });
  });
  it('excludes paused time', () => {
    expect(levelAt(levels, t0, t0 + 12 * MIN, 4 * MIN)).toEqual({ index: 0, msLeft: 2 * MIN });
  });
  it('past the last level stays on the last index with msLeft 0', () => {
    expect(levelAt(levels, t0, t0 + 35 * MIN, 0)).toEqual({ index: 2, msLeft: 0 });
    expect(levelAt(levels, t0, t0 + 500 * MIN, 0)).toEqual({ index: 2, msLeft: 0 });
  });
});

describe('validateLevels', () => {
  const valid = [lvl(1, 10, 20), lvl(2, 20, 40, 15, 40), lvl(3, 25, 40)];

  it('accepts a valid schedule', () => {
    expect(validateLevels(valid)).toEqual([]);
  });
  it('requires at least one level', () => {
    expect(validateLevels([])).toHaveLength(1);
  });
  it('requires level numbers 1..n in order', () => {
    const errs = validateLevels([lvl(1, 10, 20), lvl(3, 20, 40)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('Level 2');
  });
  it('requires sb >= 1', () => {
    const errs = validateLevels([lvl(1, 0, 20)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Level 1.*small blind/);
  });
  it('requires bb > sb', () => {
    const errs = validateLevels([lvl(1, 20, 20)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Level 1.*big blind/);
  });
  it('requires non-decreasing bb', () => {
    const errs = validateLevels([lvl(1, 10, 40), lvl(2, 10, 30)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Level 2.*previous/);
  });
  it('requires ante >= 0', () => {
    const errs = validateLevels([lvl(1, 10, 20, 10, -5)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Level 1.*ante/);
  });
  it('requires duration >= 1 minute', () => {
    const errs = validateLevels([lvl(1, 10, 20, 0)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Level 1.*duration/);
  });
  it('requires safe integers', () => {
    expect(validateLevels([lvl(1, 10.5, 20)])[0]).toMatch(/Level 1.*smallBlind/);
    expect(validateLevels([lvl(1, 10, Number.MAX_SAFE_INTEGER + 1)])[0]).toMatch(/Level 1.*bigBlind/);
    expect(validateLevels([lvl(1, 10, 20, 2.5)])[0]).toMatch(/Level 1.*durationMinutes/);
  });
});
