import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatPlayMoney, settle, settlementText, type Transfer } from '../src/settlement.js';

const NOTICE = 'Play money only. Settle any real-money arrangements among yourselves, outside this app.';

/** received - paid per player. */
function balances(net: { playerId: string; chips: number }[], transfers: Transfer[]): Map<string, number> {
  const result = new Map<string, number>(net.map((n) => [n.playerId, 0]));
  for (const t of transfers) {
    result.set(t.to, (result.get(t.to) ?? 0) + t.chips);
    result.set(t.from, (result.get(t.from) ?? 0) - t.chips);
  }
  return result;
}

/** Negates without producing -0 (which Object.is-based assertions treat as distinct from 0). */
function negate(x: number): number {
  return x === 0 ? 0 : -x;
}

describe('settle', () => {
  it('(a) largest debtor pays the largest creditor first', () => {
    const { transfers } = settle([
      { playerId: 'A', chips: 3000 },
      { playerId: 'B', chips: -1000 },
      { playerId: 'C', chips: -2000 },
    ]);
    expect(new Set(transfers.map((t) => `${t.from}->${t.to}:${String(t.chips)}`))).toEqual(
      new Set(['C->A:2000', 'B->A:1000']),
    );
    expect(transfers).toEqual([
      { from: 'C', to: 'A', chips: 2000 },
      { from: 'B', to: 'A', chips: 1000 },
    ]);
  });

  it('(b) 6 players with random nets need at most 5 transfers', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 200; round++) {
      const values = Array.from({ length: 5 }, () => (rand() % 20001) - 10000);
      values.push(negate(values.reduce((a, b) => a + b, 0)));
      const net = values.map((chips, i) => ({ playerId: `p${String(i)}`, chips }));
      const { transfers } = settle(net);
      expect(transfers.length).toBeLessThanOrEqual(5);
      const bal = balances(net, transfers);
      for (const n of net) expect(bal.get(n.playerId) === n.chips).toBe(true);
    }
  });

  it('(c) property: transfers balance every player exactly, all > 0, count <= n-1', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
        (head) => {
          const values = [...head, negate(head.reduce((a, b) => a + b, 0))];
          const net = values.map((chips, i) => ({ playerId: `p${String(i)}`, chips }));
          const { transfers } = settle(net);
          expect(transfers.length).toBeLessThanOrEqual(net.length - 1);
          for (const t of transfers) {
            expect(Number.isInteger(t.chips)).toBe(true);
            expect(t.chips).toBeGreaterThan(0);
            expect(t.from).not.toBe(t.to);
          }
          const bal = balances(net, transfers);
          for (const n of net) expect(bal.get(n.playerId) === n.chips).toBe(true);
          const zeroIds = new Set(net.filter((n) => n.chips === 0).map((n) => n.playerId));
          for (const t of transfers) {
            expect(zeroIds.has(t.from)).toBe(false);
            expect(zeroIds.has(t.to)).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('breaks ties by playerId ascending', () => {
    const { transfers } = settle([
      { playerId: 'd2', chips: -100 },
      { playerId: 'c2', chips: 100 },
      { playerId: 'd1', chips: -100 },
      { playerId: 'c1', chips: 100 },
    ]);
    expect(transfers).toEqual([
      { from: 'd1', to: 'c1', chips: 100 },
      { from: 'd2', to: 'c2', chips: 100 },
    ]);
  });

  it('returns no transfers when everyone is even', () => {
    expect(settle([]).transfers).toEqual([]);
    expect(settle([{ playerId: 'A', chips: 0 }, { playerId: 'B', chips: 0 }]).transfers).toEqual([]);
  });

  it('treats a net of -0 as even (no transfer)', () => {
    expect(settle([{ playerId: 'A', chips: -0 }, { playerId: 'B', chips: 0 }]).transfers).toEqual([]);
    expect(settle([
      { playerId: 'A', chips: 3 },
      { playerId: 'B', chips: -3 },
      { playerId: 'Z', chips: -0 },
    ]).transfers).toEqual([{ from: 'B', to: 'A', chips: 3 }]);
  });

  it('(d) throws when nets do not sum to 0 or are not integers', () => {
    expect(() => settle([{ playerId: 'A', chips: 100 }, { playerId: 'B', chips: -99 }])).toThrow(Error);
    expect(() => settle([{ playerId: 'A', chips: 0.5 }, { playerId: 'B', chips: -0.5 }])).toThrow(Error);
    expect(() => settle([{ playerId: 'A', chips: Number.NaN }])).toThrow(Error);
    const big = Number.MAX_SAFE_INTEGER + 1;
    expect(() => settle([{ playerId: 'A', chips: big }, { playerId: 'B', chips: -big }])).toThrow(Error);
  });
});

describe('formatPlayMoney', () => {
  it('(e) formats dollars with locale-independent grouping', () => {
    expect(formatPlayMoney(1250)).toBe('$1,250');
    expect(formatPlayMoney(-40)).toBe('-$40');
    expect(formatPlayMoney(0)).toBe('$0');
    expect(formatPlayMoney(1234567)).toBe('$1,234,567');
    expect(formatPlayMoney(999)).toBe('$999');
    expect(formatPlayMoney(1000)).toBe('$1,000');
    expect(formatPlayMoney(-1234567)).toBe('-$1,234,567');
  });
});

describe('settlementText', () => {
  it('(f) lists one line per transfer followed by the notice', () => {
    const text = settlementText(
      [
        { from: 'b', to: 'a', chips: 1250 },
        { from: 'x', to: 'a', chips: 40 },
      ],
      { a: 'Ana', b: 'Ben' },
    );
    expect(text).toBe(`Ben owes Ana $1,250\nx owes Ana $40\n\n${NOTICE}`);
    expect(text).toContain('Play money only.');
  });

  it('(f) says everyone is even with no transfers', () => {
    const text = settlementText([], {});
    expect(text).toBe(`Everyone is even.\n\n${NOTICE}`);
    expect(text).toContain('Play money only.');
  });
});
