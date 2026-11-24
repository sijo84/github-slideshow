import { describe, expect, it, vi } from 'vitest';
import {
  cardCommitments,
  cardSalt,
  commit,
  deckFromSeeds,
  newClientSeed,
  newServerSeed,
  uniformInt,
  verifyCard,
  verifyDeck,
} from '../src/rng.js';

const SERVER = '00'.repeat(32);
const CLIENT = '11'.repeat(16);

describe('deckFromSeeds', () => {
  it('(a) is deterministic, depends on client seeds, ignores their order', () => {
    const a = deckFromSeeds(SERVER, ['alice', 'bob'], 7);
    const b = deckFromSeeds(SERVER, ['alice', 'bob'], 7);
    expect(b).toEqual(a);

    const other = deckFromSeeds(SERVER, ['alice', 'carol'], 7);
    expect(other).not.toEqual(a);

    const input = ['bob', 'alice'];
    const reordered = deckFromSeeds(SERVER, input, 7);
    expect(reordered).toEqual(a);
    expect(input).toEqual(['bob', 'alice']); // input not mutated

    expect(deckFromSeeds(SERVER, ['alice', 'bob'], 8)).not.toEqual(a);
  });

  it('(b) is a permutation of 0..51', () => {
    for (let k = 0; k < 20; k++) {
      const deck = deckFromSeeds(`perm-${k}`, [CLIENT], k);
      expect(deck).toHaveLength(52);
      expect([...deck].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i));
    }
  });

  it('(f) known-answer vector (cross-checked against node:crypto)', () => {
    expect(deckFromSeeds(SERVER, [CLIENT], 1).slice(0, 5)).toEqual([31, 51, 38, 6, 11]);
  });
});

describe('verifyDeck', () => {
  it('(c) accepts the real deck and rejects tampering', () => {
    const commitment = commit(SERVER);
    const deck = deckFromSeeds(SERVER, [CLIENT], 3);
    expect(verifyDeck(commitment, SERVER, [CLIENT], 3, deck)).toBe(true);

    const swapped = [...deck];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(verifyDeck(commitment, SERVER, [CLIENT], 3, swapped)).toBe(false);

    expect(verifyDeck(commit('other'), SERVER, [CLIENT], 3, deck)).toBe(false);
    expect(verifyDeck(commitment, SERVER, [CLIENT], 3, deck.slice(0, 51))).toBe(false);
  });
});

describe('uniformity', () => {
  it('(d) chi-square of card 0 position and of card at position 0 is < 90.57 (df 51, p 0.001)', () => {
    const N = 52_000;
    const posOfCard0 = new Array<number>(52).fill(0);
    const cardAtPos0 = new Array<number>(52).fill(0);
    for (let k = 0; k < N; k++) {
      const deck = deckFromSeeds(`seed-${k}`, [CLIENT], 1);
      posOfCard0[deck.indexOf(0)]! += 1;
      cardAtPos0[deck[0]!]! += 1;
    }
    const expected = N / 52;
    const chi = (bins: number[]): number => bins.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    expect(chi(posOfCard0)).toBeLessThan(90.57);
    expect(chi(cardAtPos0)).toBeLessThan(90.57);
  }, 120_000);
});

describe('seeds and commit', () => {
  it('(e) new seeds are random lowercase hex of the right length', () => {
    const s1 = newServerSeed();
    const s2 = newServerSeed();
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(s2).toMatch(/^[0-9a-f]{64}$/);
    expect(s1).not.toBe(s2);
    expect(newClientSeed()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('(f) commit known answer', () => {
    expect(commit('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('uniformInt', () => {
  it('(g) rejects values >= limit', () => {
    const values = [0xffffffff, 4];
    const next = vi.fn(() => values.shift()!);
    expect(uniformInt(3, next)).toBe(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('accepts the largest value below the limit', () => {
    const next = vi.fn(() => 0xfffffffe);
    expect(uniformInt(3, next)).toBe(0xfffffffe % 3);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('card commitments', () => {
  const saltKey = 'aa'.repeat(32);

  it('(h) commitments verify per card and reject wrong card/position/salt', () => {
    const deck = deckFromSeeds(SERVER, [CLIENT], 9);
    const commitments = cardCommitments(deck, saltKey);
    expect(commitments).toHaveLength(52);
    expect(new Set(commitments).size).toBe(52);
    for (const c of commitments) expect(c).toMatch(/^[0-9a-f]{64}$/);

    for (let p = 0; p < 52; p++) {
      const salt = cardSalt(saltKey, p);
      const card = deck[p]!;
      expect(verifyCard(commitments[p]!, salt, p, card)).toBe(true);
      expect(verifyCard(commitments[p]!, salt, p, (card + 1) % 52)).toBe(false);
      expect(verifyCard(commitments[p]!, salt, (p + 1) % 52, card)).toBe(false);
      expect(verifyCard(commitments[p]!, cardSalt(saltKey, (p + 1) % 52), p, card)).toBe(false);
    }
  });

  it('(h) known-answer vector (cross-checked against node:crypto)', () => {
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const commitments = cardCommitments(identity, saltKey);
    expect(commitments[0]).toBe('c176e9b82532c9b1435b48da1e601114ae7378a079e385dd65668719ea4cf6ec');
    expect(commitments[51]).toBe('1d4246d07ad59766efd92e830bd10638f4e070a47d57df1a2aedfea47cd46a28');
  });
});
