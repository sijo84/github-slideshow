import {
  applyAction,
  cardCommitments,
  cardSalt,
  commit,
  deckFromSeeds,
  newClientSeed,
  newServerSeed,
  startHand,
  type HandEvent,
  type HandRecord,
} from '@poker/engine';
import { describe, expect, it } from 'vitest';
import {
  checkCardProof,
  createProofBook,
  dealMap,
  dealOrder,
  expectedPosition,
  proofVerdict,
  recordHandEvent,
  recordProof,
  verifyGame,
  type FairnessHand,
} from '../src/table/verify.js';

const SALT_KEY = newServerSeed();

describe('checkCardProof', () => {
  const deck = deckFromSeeds(newServerSeed(), [newClientSeed()], 1);
  const commitments = cardCommitments(deck, SALT_KEY);

  it('accepts every real card with its salt (round trip)', () => {
    for (let p = 0; p < 52; p++) {
      expect(checkCardProof(commitments, { position: p, card: deck[p]!, salt: cardSalt(SALT_KEY, p) })).toBe(true);
    }
  });

  it('rejects a tampered card, salt or position', () => {
    const p = 7;
    const good = { position: p, card: deck[p]!, salt: cardSalt(SALT_KEY, p) };
    expect(checkCardProof(commitments, { ...good, card: (good.card + 1) % 52 })).toBe(false);
    expect(checkCardProof(commitments, { ...good, salt: cardSalt(SALT_KEY, p + 1) })).toBe(false);
    expect(checkCardProof(commitments, { ...good, position: p + 1 })).toBe(false);
    expect(checkCardProof(commitments, { ...good, position: 52 })).toBe(false);
    expect(checkCardProof(commitments, { ...good, position: -1 })).toBe(false);
    expect(checkCardProof([], good)).toBe(false);
  });
});

describe('deal-order map (F10)', () => {
  it('orders seats from the left of the button, button last', () => {
    expect(dealOrder([0, 2, 5, 7], 5)).toEqual([7, 0, 2, 5]);
    expect(dealOrder([1, 3], 3)).toEqual([1, 3]);
  });

  it('position r*n + k is seat order k card r; board after the burns', () => {
    expect(expectedPosition(3, 0, 0)).toBe(0);
    expect(expectedPosition(3, 2, 1)).toBe(5);
    expect(() => expectedPosition(3, 3, 0)).toThrow();
    const map = dealMap({ seats: [0, 2, 5].map((seat) => ({ seat, playerId: 'p' + seat, stack: 100 })), buttonSeat: 2 });
    expect(map.order).toEqual([5, 0, 2]);
    expect(map.hole.get(5)).toEqual([0, 3]);
    expect(map.hole.get(2)).toEqual([2, 5]);
    expect(map.board).toEqual([7, 8, 9, 11, 13]);
    expect(map.slots.get(4)).toEqual({ kind: 'hole', seat: 0, index: 1 });
    expect(map.slots.get(11)).toEqual({ kind: 'board', index: 3 });
    expect(map.slots.has(6)).toBe(false); // burn
  });

  it('matches the engine: every hole card sits at its expected position', () => {
    const deck = deckFromSeeds(newServerSeed(), [], 3);
    const seats = [1, 4, 6, 8].map((seat) => ({ seat, playerId: 'p' + seat, stack: 500 }));
    const { events } = startHand({ handId: 'h', handNumber: 3, maxSeats: 9, buttonSeat: 6, stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' }, seats, deck });
    const map = dealMap({ seats, buttonSeat: 6 });
    for (const e of events) {
      if (e.type !== 'dealHole') continue;
      const [p0, p1] = map.hole.get(e.seat)!;
      expect(e.cards).toEqual([deck[p0], deck[p1]]);
    }
  });
});

describe('proof book', () => {
  const deck = deckFromSeeds(newServerSeed(), [], 1);
  const seats = [0, 1, 2].map((seat) => ({ seat, playerId: 'p' + seat, stack: 100 }));
  const hs: Extract<HandEvent, { type: 'handStarted' }> = {
    type: 'handStarted', handId: 'h1', handNumber: 1, buttonSeat: 0,
    stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' }, seats, commitment: '',
    cardCommitments: cardCommitments(deck, SALT_KEY),
  };
  const proof = (p: number) => ({ position: p, card: deck[p]!, salt: cardSalt(SALT_KEY, p) });

  it('ok when my hole cards and the board are proven; failed without my hole proofs or with a burn', () => {
    // order: 1, 2, 0 → my seat 2 holds positions 1 and 4
    const book = createProofBook(hs, 2);
    recordHandEvent(book, { type: 'dealHole', seat: 2, cards: [deck[1]!, deck[4]!] });
    expect(proofVerdict(book)).toBe('failed');
    expect(recordProof(book, proof(1))).toBe(true);
    expect(recordProof(book, proof(4))).toBe(true);
    recordHandEvent(book, { type: 'street', street: 'flop', cards: [deck[7]!, deck[8]!, deck[9]!] });
    for (const p of [7, 8, 9]) expect(recordProof(book, proof(p))).toBe(true);
    expect(proofVerdict(book)).toBe('ok');
    expect(recordProof(book, proof(6))).toBe(false); // burn
    expect(proofVerdict(book)).toBe('failed');
  });

  it('a watcher with no proofs is ok; a proof for a card never shown fails', () => {
    const book = createProofBook(hs, null);
    expect(proofVerdict(book)).toBe('ok');
    recordProof(book, proof(0));
    expect(proofVerdict(book)).toBe('failed');
  });
});

// ---------------------------------------------------------------------------------------------------------

function generatedGame(hands = 3): { fairness: FairnessHand[]; records: HandRecord[] } {
  const fairness: FairnessHand[] = [];
  const records: HandRecord[] = [];
  for (let n = 1; n <= hands; n++) {
    const serverSeed = newServerSeed();
    const saltKey = newServerSeed();
    const clientSeeds = [newClientSeed(), newClientSeed()].sort();
    const deck = deckFromSeeds(serverSeed, clientSeeds, n);
    const handId = `hand-${n}`;
    const seats = [0, 1, 2].map((seat) => ({ seat, playerId: 'p' + seat, stack: 1000 }));
    let { state, events } = startHand({ handId, handNumber: n, maxSeats: 6, buttonSeat: (n - 1) % 3, stakes: { smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none' }, seats, deck });
    const all: HandEvent[] = [...events];
    // everyone calls / checks down to showdown
    for (let guard = 0; guard < 50 && !state.complete; guard++) {
      const seat = state.toAct;
      if (seat === null) break;
      const legal = state.players.find((p) => p.seat === seat)!;
      const kind = state.currentBet > legal.street ? 'call' : 'check';
      ({ state, events } = applyAction(state, { seat, kind }));
      all.push(...events);
    }
    const filled = all.map((e): HandEvent => {
      if (e.type === 'handStarted') return { ...e, commitment: commit(serverSeed), cardCommitments: cardCommitments(deck, saltKey) };
      if (e.type === 'handEnded') return { ...e, clientSeeds, nextCommitment: '' };
      return e;
    });
    fairness.push({ handId, handNumber: n, commitment: commit(serverSeed), serverSeed, saltKey, clientSeeds });
    records.push({ handId, gameId: 'g', handNumber: n, startedAt: '', endedAt: '', events: filled, hole: {}, playerIds: {}, board: state.board });
  }
  return { fairness, records };
}

describe('verifyGame', () => {
  it('passes for a generated game (array or route body)', () => {
    const { fairness, records } = generatedGame();
    expect(records[0]!.events.some((e) => e.type === 'showCards')).toBe(true);
    expect(verifyGame(fairness, records)).toEqual([
      { handNumber: 1, ok: true },
      { handNumber: 2, ok: true },
      { handNumber: 3, ok: true },
    ]);
    expect(verifyGame({ hands: fairness }, records).every((r) => r.ok)).toBe(true);
  });

  it('fails a hand whose seed, client seeds or salt key was altered', () => {
    const { fairness, records } = generatedGame();
    const altered = fairness.map((f, i) => (i === 1 ? { ...f, serverSeed: newServerSeed() } : f));
    const res = verifyGame(altered, records);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res[1]!.problem).toMatch(/commitment/);

    // a seed altered together with its commitment: the deck no longer matches the hand
    const seed = newServerSeed();
    const both = fairness.map((f, i) => (i === 0 ? { ...f, serverSeed: seed, commitment: commit(seed) } : f));
    expect(verifyGame(both, records)[0]!.ok).toBe(false);

    const salt = fairness.map((f, i) => (i === 2 ? { ...f, saltKey: newServerSeed() } : f));
    expect(verifyGame(salt, records)[2]).toMatchObject({ ok: false, problem: expect.stringMatching(/card commitments/) });

    const seeds = fairness.map((f, i) => (i === 0 ? { ...f, clientSeeds: [newClientSeed()] } : f));
    expect(verifyGame(seeds, records)[0]!.ok).toBe(false);
  });

  it('fails when the record shows a card the deck does not hold, or the record is missing', () => {
    const { fairness, records } = generatedGame(1);
    const rec = records[0]!;
    const events = rec.events.map((e) => (e.type === 'street' ? { ...e, cards: e.cards.map((c) => (c + 1) % 52) } : e));
    expect(verifyGame(fairness, [{ ...rec, events }])[0]).toMatchObject({ ok: false, problem: 'The board does not match the deck' });
    expect(verifyGame(fairness, [])[0]).toMatchObject({ ok: false, problem: 'The hand record is missing' });
  });
});
