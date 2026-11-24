import { describe, expect, it } from 'vitest';
import { analyse, sharedNetwork } from '../src/collusion.js';
import type { ActionKind, Card, Chips, HandEvent, HandRecord, SeatIndex } from '../src/types.js';

const BB = 100;
const STAKES = { smallBlind: 50, bigBlind: BB, ante: 0, anteKind: 'none' as const };

// rank 0 = deuce .. 12 = ace; suit 0 c, 1 d, 2 h, 3 s
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
function c(s: string): Card {
  return RANKS.indexOf(s[0]!) * 4 + SUITS.indexOf(s[1]!);
}
function cards(s: string): Card[] {
  return s.split(' ').map(c);
}

const ACES = cards('As Ah');
const TRASH = cards('7c 2d');
const BOARD = cards('Kd 9s 4h 3c Jd');

interface SeatSpec { id: string; stack?: Chips; hole: Card[] }

/** Tiny hand-record builder: writes events by hand and tracks stacks and the pot. */
class HandBuilder {
  private readonly events: HandEvent[] = [];
  private readonly stacks: Chips[];
  private readonly contrib = new Map<SeatIndex, Chips>();
  private pot = 0;
  private boardDealt = 0;

  constructor(private readonly handId: string, private readonly seats: SeatSpec[], private readonly board: Card[] = BOARD) {
    this.stacks = seats.map((s) => s.stack ?? 10_000);
    this.events.push({
      type: 'handStarted', handId, handNumber: 1, buttonSeat: 0, stakes: STAKES,
      seats: seats.map((s, i) => ({ seat: i, playerId: s.id, stack: this.stacks[i]! })),
      commitment: '', cardCommitments: [],
    });
  }

  private put(seat: SeatIndex, to: Chips): void {
    const prev = this.contrib.get(seat) ?? 0;
    this.stacks[seat]! -= to - prev;
    this.pot += to - prev;
    this.contrib.set(seat, to);
  }

  blinds(sb: SeatIndex, bb: SeatIndex): this {
    this.put(sb, STAKES.smallBlind);
    this.events.push({ type: 'postBlind', seat: sb, blind: 'small', amount: STAKES.smallBlind });
    this.put(bb, BB);
    this.events.push({ type: 'postBlind', seat: bb, blind: 'big', amount: BB });
    this.seats.forEach((s, i) => this.events.push({ type: 'dealHole', seat: i, cards: s.hole }));
    return this;
  }

  act(seat: SeatIndex, kind: ActionKind, amount = 0): this {
    let total = this.contrib.get(seat) ?? 0;
    if (kind === 'call') total = Math.max(...this.contrib.values(), 0);
    if (kind === 'bet' || kind === 'raise' || kind === 'allIn') total = amount;
    if (kind !== 'fold' && kind !== 'check') this.put(seat, total);
    this.events.push({ type: 'action', seat, kind, amount: total, stackAfter: this.stacks[seat]! });
    return this;
  }

  street(street: 'flop' | 'turn' | 'river'): this {
    const n = street === 'flop' ? 3 : 1;
    const dealt = this.board.slice(this.boardDealt, this.boardDealt + n);
    this.boardDealt += n;
    this.contrib.clear();
    this.events.push({ type: 'street', street, cards: dealt });
    return this;
  }

  award(seat: SeatIndex): HandRecord {
    this.stacks[seat]! += this.pot;
    this.events.push({ type: 'potAwarded', potIndex: 0, seats: [seat], amounts: [this.pot] });
    this.events.push({
      type: 'handEnded', stacks: this.stacks.map((stack, i) => ({ seat: i, stack })), clientSeeds: [], nextCommitment: '',
    });
    const hole: Record<SeatIndex, Card[]> = {};
    const playerIds: Record<SeatIndex, string> = {};
    this.seats.forEach((s, i) => { hole[i] = s.hole; playerIds[i] = s.id; });
    return {
      handId: this.handId, gameId: 'g1', handNumber: 1, startedAt: '', endedAt: '',
      events: this.events, hole, playerIds, board: this.board.slice(0, this.boardDealt),
    };
  }
}

/** A (seat 0) raises to 300, B calls, flop checks through, B bets 500 on the turn, A folds. Pot at fold = 1100. */
function turnFold(id: string, a: SeatSpec, b: SeatSpec): HandRecord {
  return new HandBuilder(id, [a, b]).blinds(0, 1)
    .act(0, 'raise', 300).act(1, 'call')
    .street('flop').act(1, 'check').act(0, 'check')
    .street('turn').act(1, 'bet', 500).act(0, 'fold')
    .award(1);
}

/** Same as turnFold but B shoves on the river and A folds there. */
function riverFold(id: string, a: SeatSpec, b: SeatSpec): HandRecord {
  return new HandBuilder(id, [a, b]).blinds(0, 1)
    .act(0, 'raise', 300).act(1, 'call')
    .street('flop').act(1, 'check').act(0, 'check')
    .street('turn').act(1, 'check').act(0, 'check')
    .street('river').act(1, 'allIn', 9700).act(0, 'fold')
    .award(1);
}

/** A loses 5000 (50 BB) to B at showdown, heads-up. */
function bigLoss(id: string, a: SeatSpec, b: SeatSpec): HandRecord {
  return new HandBuilder(id, [a, b]).blinds(0, 1)
    .act(0, 'raise', 2500).act(1, 'call')
    .street('flop').act(0, 'bet', 2500).act(1, 'call')
    .street('turn').act(0, 'check').act(1, 'check')
    .street('river').act(0, 'check').act(1, 'check')
    .award(1);
}

const ana = (hole = TRASH): SeatSpec => ({ id: 'ana', hole });
const ben = (hole = ACES): SeatSpec => ({ id: 'ben', hole });

describe('analyse: chipDumping', () => {
  it('flags 3 strong folds A -> B with the 3 hand ids', () => {
    const records = [turnFold('h1', ben(), ana()), riverFold('h2', ben(), ana()), turnFold('h3', ben(), ana())];
    const flags = analyse(records, BB);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.kind).toBe('chipDumping');
    expect(f.players).toEqual(['ana', 'ben']);
    expect(f.evidenceHandIds).toEqual(['h1', 'h2', 'h3']);
    expect(f.summary).toContain('ben folded a stronger hand to ana');
    expect(f.summary).toContain('3 times');
    // 3 strong folds + 3 × 300 chips flow = 9 BB
    expect(f.score).toBeCloseTo(3 + 9 / 50);
  });

  it('flags 2 strong folds plus >= 50 BB net heads-up flow', () => {
    const records = [turnFold('h1', ben(), ana()), turnFold('h2', ben(), ana()), bigLoss('h3', ben(), ana())];
    const flags = analyse(records, BB);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe('chipDumping');
    expect(flags[0]!.evidenceHandIds).toEqual(['h1', 'h2', 'h3']);
    expect(flags[0]!.score).toBeCloseTo(2 + 56 / 50);
  });

  it('does not flag 2 strong folds without the net flow', () => {
    expect(analyse([turnFold('h1', ben(), ana()), turnFold('h2', ben(), ana())], BB)).toEqual([]);
  });

  it('does not flag big net flow alone without strong folds', () => {
    expect(analyse([bigLoss('h1', ben(), ana()), bigLoss('h2', ben(), ana())], BB)).toEqual([]);
  });

  it('does not count folding a weaker hand', () => {
    const records = [1, 2, 3].map((i) => turnFold(`h${i}`, ben(TRASH), ana(ACES)));
    expect(analyse(records, BB)).toEqual([]);
  });

  it('does not count a strong fold on the flop', () => {
    const records = [1, 2, 3].map((i) => new HandBuilder(`h${i}`, [ben(), ana()]).blinds(0, 1)
      .act(0, 'raise', 300).act(1, 'call')
      .street('flop').act(1, 'bet', 2000).act(0, 'fold')
      .award(1));
    expect(analyse(records, BB)).toEqual([]);
  });

  it('does not count a strong fold in a pot under 10 BB', () => {
    // limp: pot 200, turn bet 100 -> pot 300 at fold
    const records = [1, 2, 3].map((i) => new HandBuilder(`h${i}`, [ben(), ana()]).blinds(0, 1)
      .act(0, 'call').act(1, 'check')
      .street('flop').act(1, 'check').act(0, 'check')
      .street('turn').act(1, 'bet', 100).act(0, 'fold')
      .award(1));
    expect(analyse(records, BB)).toEqual([]);
  });

  it('sorts players and says who folded to whom', () => {
    const zed = { id: 'zed', hole: ACES };
    const amy = { id: 'amy', hole: TRASH };
    const flags = analyse([1, 2, 3].map((i) => turnFold(`h${i}`, zed, amy)), BB);
    expect(flags[0]!.players).toEqual(['amy', 'zed']);
    expect(flags[0]!.summary.startsWith('zed folded a stronger hand to amy')).toBe(true);
  });

  it('caps evidence at 20 distinct hand ids', () => {
    const records = Array.from({ length: 25 }, (_, i) => turnFold(`h${i}`, ben(), ana()));
    const flags = analyse(records, BB);
    expect(flags[0]!.evidenceHandIds).toHaveLength(20);
    expect(new Set(flags[0]!.evidenceHandIds).size).toBe(20);
  });
});

describe('analyse: normal play', () => {
  it('raises no flags', () => {
    const cal = { id: 'cal', hole: cards('Qc Qd') };
    const records: HandRecord[] = [];
    for (let i = 0; i < 20; i++) {
      // ben bets, ana folds weaker; ana bets, ben folds weaker; three-way showdowns
      records.push(turnFold(`a${i}`, ben(TRASH), ana(ACES)));
      records.push(new HandBuilder(`b${i}`, [ana(), ben(cards('6c 5d')), cal]).blinds(1, 2)
        .act(0, 'call').act(1, 'call').act(2, 'check')
        .street('flop').act(1, 'bet', 200).act(2, 'raise', 600).act(0, 'call').act(1, 'call')
        .street('turn').act(1, 'check').act(2, 'bet', 1000).act(0, 'fold').act(1, 'fold')
        .award(2));
    }
    expect(analyse(records, BB)).toEqual([]);
  });
});

describe('analyse: softPlay', () => {
  const cal = { id: 'cal', hole: cards('Qc Qd') };

  function softRecords(headsUp: number): HandRecord[] {
    const records: HandRecord[] = [];
    for (let i = 0; i < headsUp; i++) {
      records.push(new HandBuilder(`hu${i}`, [ana(cards('8c 8d')), ben(cards('8h 8s'))]).blinds(0, 1)
        .act(0, 'call').act(1, 'check')
        .street('flop').act(1, 'check').act(0, 'check')
        .street('turn').act(1, 'check').act(0, 'check')
        .street('river').act(1, 'check').act(0, 'check')
        .award(i % 2));
    }
    for (let i = 0; i < 10; i++) {
      for (const [p, tag] of [[ana(), 'a'], [ben(), 'b']] as const) {
        records.push(new HandBuilder(`${tag}c${i}`, [p, cal]).blinds(0, 1)
          .act(0, 'raise', 300).act(1, 'call')
          .street('flop').act(1, 'check').act(0, 'bet', 300).act(1, 'call')
          .street('turn').act(1, 'check').act(0, 'bet', 600).act(1, 'call')
          .street('river').act(1, 'check').act(0, 'check')
          .award(1));
      }
    }
    return records;
  }

  it('flags >= 15 passive heads-up pots between two players who are aggressive against others', () => {
    const flags = analyse(softRecords(15), BB);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.kind).toBe('softPlay');
    expect(f.players).toEqual(['ana', 'ben']);
    expect(f.score).toBeCloseTo(1);
    expect(f.evidenceHandIds).toHaveLength(15);
    expect(f.evidenceHandIds.every((id) => id.startsWith('hu'))).toBe(true);
  });

  it('does not flag with only 14 heads-up pots', () => {
    expect(analyse(softRecords(14), BB)).toEqual([]);
  });
});

describe('sharedNetwork', () => {
  it('flags the same IP', () => {
    const flags = sharedNetwork([
      { playerId: 'zed', ip: '10.0.0.1', deviceId: 'd1' },
      { playerId: 'amy', ip: '10.0.0.1', deviceId: 'd2' },
    ]);
    expect(flags).toEqual([expect.objectContaining({ kind: 'sharedIp', players: ['amy', 'zed'], score: 1 })]);
  });

  it('flags the same device', () => {
    const flags = sharedNetwork([
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'dev' },
      { playerId: 'ben', ip: '10.0.0.2', deviceId: 'dev' },
    ]);
    expect(flags).toEqual([expect.objectContaining({ kind: 'sharedDevice', players: ['ana', 'ben'], score: 1 })]);
  });

  it("ignores the 'unknown' device id", () => {
    expect(sharedNetwork([
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'unknown' },
      { playerId: 'ben', ip: '10.0.0.2', deviceId: 'unknown' },
    ])).toEqual([]);
  });

  it('ignores loopback IPs but still flags a shared device on loopback', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(sharedNetwork([
        { playerId: 'ana', ip, deviceId: 'd1' },
        { playerId: 'ben', ip, deviceId: 'd2' },
      ])).toEqual([]);
      const flags = sharedNetwork([
        { playerId: 'ana', ip, deviceId: 'same' },
        { playerId: 'ben', ip, deviceId: 'same' },
      ]);
      expect(flags.map((f) => f.kind)).toEqual(['sharedDevice']);
    }
  });

  it('does not pair a player with themself and reports each pair once', () => {
    expect(sharedNetwork([
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'd1' },
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'd1' },
    ])).toEqual([]);
    const flags = sharedNetwork([
      { playerId: 'ben', ip: '10.0.0.1', deviceId: 'd1' },
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'd2' },
      { playerId: 'ben', ip: '10.0.0.1', deviceId: 'd3' },
      { playerId: 'ana', ip: '10.0.0.1', deviceId: 'd4' },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.players).toEqual(['ana', 'ben']);
  });
});
