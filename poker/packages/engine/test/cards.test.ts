import { describe, it, expect } from 'vitest';
import { RANKS, SUITS, rankOf, suitOf, parseCard, formatCard, parseCards, fullDeck } from '../src/cards.js';

describe('cards', () => {
  it('round-trips all 52 cards', () => {
    const seen = new Set<string>();
    for (const c of fullDeck()) {
      const s = formatCard(c);
      seen.add(s);
      expect(parseCard(s)).toBe(c);
      expect(s).toBe(RANKS.charAt(rankOf(c)) + SUITS.charAt(suitOf(c)));
    }
    expect(seen.size).toBe(52);
  });

  it('encodes rank and suit per the spec', () => {
    expect(parseCard('As')).toBe(51);
    expect(parseCard('2c')).toBe(0);
    expect(parseCard('Td')).toBe((8 << 2) | 1);
    expect(formatCard(51)).toBe('As');
    expect(rankOf(51)).toBe(12);
    expect(suitOf(51)).toBe(3);
  });

  it('rejects bad input', () => {
    for (const bad of ['1x', '', 'AsK', 'Ax', 'Zs', 'A', ' As']) {
      expect(() => parseCard(bad)).toThrow();
    }
    expect(() => formatCard(52)).toThrow();
    expect(() => formatCard(-1)).toThrow();
    expect(() => formatCard(1.5)).toThrow();
  });

  it('parses card lists with or without spaces', () => {
    expect(parseCards('As Kd')).toEqual([51, 45]);
    expect(parseCards('AsKd')).toEqual([51, 45]);
    expect(parseCards('')).toEqual([]);
    expect(() => parseCards('AsK')).toThrow();
    expect(() => parseCards('As 1x')).toThrow();
    expect(() => parseCards('A sKd')).toThrow();
  });

  it('fullDeck is [0..51]', () => {
    const d = fullDeck();
    expect(d).toHaveLength(52);
    d.forEach((c, i) => expect(c).toBe(i));
  });
});
