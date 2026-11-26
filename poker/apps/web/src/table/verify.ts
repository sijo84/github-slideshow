/**
 * Card verification (W11a; PLAN F1, F10/I-7).
 *
 * Live: each `cardProof { position, card, salt }` is checked against the hand's `cardCommitments[position]`
 * (sha256(salt + ':' + position + ':' + card)), and its position must be the deck position, per the deal-order
 * map, of a card this viewer was actually shown (own hole card, board card or a shown hand) with the same value.
 * A `ProofBook` per hand collects this; `proofVerdict` gives the hand's result.
 *
 * After the game: `verifyGame` re-derives every deck from the revealed seeds and checks it against the
 * commitments and against the cards the hand records show.
 */
import {
  cardCommitments,
  commit,
  dealPositions,
  deckFromSeeds,
  verifyCard,
  verifyDeck,
  type Card,
  type HandEvent,
  type SeatIndex,
} from '@poker/engine';

type HandStarted = Extract<HandEvent, { type: 'handStarted' }>;

export interface CardProof {
  position: number;
  card: Card;
  salt: string;
}

/** What a deck position holds in a hand: a hole card of a seat (round `index`) or board card `index`. */
export type CardSlot = { kind: 'hole'; seat: SeatIndex; index: 0 | 1 } | { kind: 'board'; index: number };

/** The deal-order map of one hand. */
export interface DealMap {
  /** Seats in deal order: first seat left of the button first, the button last. */
  order: SeatIndex[];
  hole: Map<SeatIndex, [number, number]>;
  board: number[];
  burns: number[];
  slots: Map<number, CardSlot>;
}

/** sha256(salt:position:card) equals the committed value at that position. */
export function checkCardProof(commitments: string[], proof: CardProof): boolean {
  const c = commitments[proof.position];
  if (typeof c !== 'string' || !Number.isInteger(proof.position) || proof.position < 0) return false;
  return verifyCard(c, proof.salt, proof.position, proof.card);
}

/** Seats in deal order: clockwise from the seat after the button, the button last. */
export function dealOrder(seats: SeatIndex[], buttonSeat: SeatIndex): SeatIndex[] {
  const span = Math.max(buttonSeat, ...seats) + 1;
  const dist = (s: SeatIndex): number => {
    const d = (((s - buttonSeat) % span) + span) % span;
    return d === 0 ? span : d;
  };
  return [...seats].sort((a, b) => dist(a) - dist(b));
}

/** Deck position of a hole card per F10: `round * seatCount + seatOrder`. */
export function expectedPosition(seatCount: number, seatOrder: number, round: number): number {
  const p = dealPositions(seatCount).hole[seatOrder]?.[round];
  if (p === undefined) throw new RangeError(`no hole card for seat order ${seatOrder}, round ${round} of ${seatCount}`);
  return p;
}

/** The deal-order map of a hand from its `handStarted` event. */
export function dealMap(hs: Pick<HandStarted, 'seats' | 'buttonSeat'>): DealMap {
  const order = dealOrder(
    hs.seats.map((s) => s.seat),
    hs.buttonSeat,
  );
  const pos = dealPositions(order.length);
  const hole = new Map<SeatIndex, [number, number]>();
  const slots = new Map<number, CardSlot>();
  order.forEach((seat, k) => {
    const p0 = expectedPosition(order.length, k, 0);
    const p1 = expectedPosition(order.length, k, 1);
    hole.set(seat, [p0, p1]);
    slots.set(p0, { kind: 'hole', seat, index: 0 });
    slots.set(p1, { kind: 'hole', seat, index: 1 });
  });
  pos.board.forEach((p, i) => slots.set(p, { kind: 'board', index: i }));
  return { order, hole, board: pos.board, burns: pos.burns, slots };
}

/** Which card a deck position stands for in this hand; null for burns and undealt positions. */
export function slotOf(map: DealMap, position: number): CardSlot | null {
  return map.slots.get(position) ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Live proofs

export interface ProofBook {
  handId: string;
  commitments: string[];
  map: DealMap;
  mySeat: SeatIndex | null;
  /** I was dealt into this hand. */
  dealtIn: boolean;
  /** Cards this viewer was shown, by deck position (from dealHole/street/showCards). */
  revealed: Map<number, Card>;
  boardCount: number;
  proofs: { position: number; card: Card; hashOk: boolean }[];
}

export function createProofBook(hs: HandStarted, mySeat: SeatIndex | null): ProofBook {
  return {
    handId: hs.handId,
    commitments: [...hs.cardCommitments],
    map: dealMap(hs),
    mySeat,
    dealtIn: mySeat !== null && hs.seats.some((s) => s.seat === mySeat),
    revealed: new Map(),
    boardCount: 0,
    proofs: [],
  };
}

/** Notes the cards a hand event shows this viewer, so proofs can be matched to them. */
export function recordHandEvent(book: ProofBook, event: HandEvent): void {
  if (event.type === 'dealHole' || event.type === 'showCards') {
    const ps = book.map.hole.get(event.seat);
    if (!ps) return;
    event.cards.forEach((card, r) => {
      const p = ps[r];
      if (p !== undefined) book.revealed.set(p, card);
    });
  } else if (event.type === 'street') {
    event.cards.forEach((card) => {
      const p = book.map.board[book.boardCount];
      book.boardCount++;
      if (p !== undefined) book.revealed.set(p, card);
    });
  }
}

function proofMatches(book: ProofBook, proof: { position: number; card: Card; hashOk: boolean }): boolean {
  if (!proof.hashOk || slotOf(book.map, proof.position) === null) return false;
  return book.revealed.get(proof.position) === proof.card;
}

/** Records a proof; returns whether it checks out now (hash, a dealt position, the card shown there). */
export function recordProof(book: ProofBook, proof: CardProof): boolean {
  const entry = { position: proof.position, card: proof.card, hashOk: checkCardProof(book.commitments, proof) };
  book.proofs.push(entry);
  return proofMatches(book, entry);
}

/** 'ok' when every proof received checks out and, if I was dealt in, both my hole cards were proven. */
export function proofVerdict(book: ProofBook): 'ok' | 'failed' {
  if (!book.proofs.every((p) => proofMatches(book, p))) return 'failed';
  if (book.dealtIn && book.mySeat !== null) {
    const mine = book.map.hole.get(book.mySeat);
    if (!mine) return 'failed';
    for (const p of mine) if (!book.proofs.some((x) => x.position === p && proofMatches(book, x))) return 'failed';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------------------------------------
// Whole game (after it finished)

/** One row of `GET /api/games/:id/fairness` (apps/server/src/routes/history.ts). */
export interface FairnessHand {
  handId: string;
  handNumber: number;
  commitment: string;
  serverSeed: string;
  saltKey: string;
  clientSeeds: string[];
}

/** The fairness route's response body. */
export interface FairnessResponse {
  hands: FairnessHand[];
}

/** What `verifyGame` reads of a hand record (a server `HandRecord` or the `/api/hands/:id` RedactedHand). */
export interface VerifiableHand {
  handId: string;
  handNumber: number;
  events: HandEvent[];
}

export interface HandVerification {
  handNumber: number;
  ok: boolean;
  problem?: string;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function verifyHand(row: FairnessHand, hand: VerifiableHand | undefined): string | null {
  if (commit(row.serverSeed) !== row.commitment) return 'The server seed does not match the commitment';
  const deck = deckFromSeeds(row.serverSeed, row.clientSeeds, row.handNumber);
  if (!verifyDeck(row.commitment, row.serverSeed, row.clientSeeds, row.handNumber, deck)) {
    return 'The deck does not match the commitment';
  }
  if (!hand) return 'The hand record is missing';
  const hs = hand.events.find((e): e is HandStarted => e.type === 'handStarted');
  if (!hs) return 'The hand record has no start';
  if (hs.commitment !== row.commitment) return 'The commitment differs from the one announced at the start of the hand';
  if (hs.handNumber !== row.handNumber) return 'The hand number differs from the record';
  if (!sameList(cardCommitments(deck, row.saltKey), hs.cardCommitments)) {
    return 'The card commitments do not match the revealed deck';
  }
  const ended = hand.events.find((e) => e.type === 'handEnded');
  if (ended && ended.type === 'handEnded' && ended.clientSeeds.length > 0) {
    if (!sameList([...ended.clientSeeds].sort(), [...row.clientSeeds].sort())) return 'The client seeds differ from the record';
  }
  const map = dealMap(hs);
  let boardIndex = 0;
  for (const e of hand.events) {
    if (e.type === 'dealHole' || e.type === 'showCards') {
      const ps = map.hole.get(e.seat);
      if (!ps) return `Seat ${e.seat + 1} was not dealt in`;
      for (let r = 0; r < e.cards.length; r++) {
        if (deck[ps[r] ?? -1] !== e.cards[r]) return `Seat ${e.seat + 1}'s cards do not match the deck`;
      }
    } else if (e.type === 'street') {
      for (const card of e.cards) {
        const p = map.board[boardIndex++];
        if (p === undefined || deck[p] !== card) return 'The board does not match the deck';
      }
    }
  }
  return null;
}

/** Re-derives every deck from the revealed seeds and checks commitments, card commitments and dealt cards. */
export function verifyGame(fairness: FairnessResponse | FairnessHand[], hands: VerifiableHand[]): HandVerification[] {
  const rows = Array.isArray(fairness) ? fairness : fairness.hands;
  return rows.map((row) => {
    const hand = hands.find((h) => h.handId === row.handId) ?? hands.find((h) => h.handNumber === row.handNumber);
    const problem = verifyHand(row, hand);
    return problem === null ? { handNumber: row.handNumber, ok: true } : { handNumber: row.handNumber, ok: false, problem };
  });
}
