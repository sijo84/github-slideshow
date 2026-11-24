import type { Card } from './types.js';
import { evaluate7 } from './evaluator.js';

export interface Equity { win: number; tie: number }

/** Small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFLOP_SAMPLES = 50_000;
const PREFLOP_DEFAULT_SEED = 0x5eed_c0de;

function cryptoSeededRand(): () => number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return mulberry32(buf[0]!);
}

function validateCard(c: Card, used: Uint8Array): void {
  if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`invalid card: ${c}`);
  if (used[c]) throw new Error(`duplicate card: ${c}`);
  used[c] = 1;
}

/** Validates holes and board; returns the "used" mask (1 = dealt). */
function validate(holes: Card[][], board: Card[]): Uint8Array {
  if (!Array.isArray(board) || (board.length !== 0 && (board.length < 3 || board.length > 5))) {
    throw new Error(`board must have 0, 3, 4 or 5 cards, got ${board?.length}`);
  }
  const used = new Uint8Array(52);
  for (const hole of holes) {
    if (!Array.isArray(hole) || hole.length !== 2) throw new Error('each hole must have exactly 2 cards');
    validateCard(hole[0]!, used);
    validateCard(hole[1]!, used);
  }
  for (const c of board) validateCard(c, used);
  return used;
}

function unseen(used: Uint8Array): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used[c]) out.push(c);
  return out;
}

/**
 * Monte Carlo equity of `hole` against `opponents` random hands.
 * win = fraction of iterations hero strictly beats every opponent; tie = hero ties for best.
 */
export function equityVsRandom(hole: Card[], board: Card[], opponents: number, iterations: number, rand?: () => number): Equity {
  if (!Number.isInteger(opponents) || opponents < 1 || opponents > 8) throw new Error(`opponents must be 1..8, got ${opponents}`);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error(`iterations must be a positive integer, got ${iterations}`);
  const used = validate([hole], board);
  const r = rand ?? cryptoSeededRand();
  const deck = unseen(used);
  const deckLen = deck.length;
  const boardLen = board.length;
  const missing = 5 - boardLen;
  const draw = missing + 2 * opponents; // cards needed per iteration

  // Reused 7-card buffers: [hole0, hole1, board0..board4].
  const hero: Card[] = [hole[0]!, hole[1]!, 0, 0, 0, 0, 0];
  const opp: Card[] = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < boardLen; i++) { hero[2 + i] = board[i]!; opp[2 + i] = board[i]!; }

  let wins = 0;
  let ties = 0;
  for (let it = 0; it < iterations; it++) {
    // Partial Fisher-Yates: the first `draw` slots become the random sample.
    for (let i = 0; i < draw; i++) {
      const j = i + Math.floor(r() * (deckLen - i));
      const tmp = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = tmp;
    }
    for (let i = 0; i < missing; i++) {
      const c = deck[i]!;
      hero[2 + boardLen + i] = c;
      opp[2 + boardLen + i] = c;
    }
    const heroScore = evaluate7(hero).score;
    let best = -1;
    for (let o = 0; o < opponents; o++) {
      opp[0] = deck[missing + 2 * o]!;
      opp[1] = deck[missing + 2 * o + 1]!;
      const s = evaluate7(opp).score;
      if (s > best) {
        best = s;
        if (best > heroScore) break; // hero already lost
      }
    }
    if (heroScore > best) wins++;
    else if (heroScore === best) ties++;
  }
  return { win: wins / iterations, tie: ties / iterations };
}

/**
 * Equity of each hand in `holes` on `board`.
 * Exhaustive over all runouts when board.length >= 3; preflop uses 50,000 sampled boards
 * (deterministic fixed seed unless `rand` is given).
 */
export function equityExact(holes: Card[][], board: Card[], rand?: () => number): Equity[] {
  if (!Array.isArray(holes) || holes.length < 1 || holes.length > 9) throw new Error('equityExact needs 1..9 hands');
  const used = validate(holes, board);
  const n = holes.length;
  const deck = unseen(used);
  const deckLen = deck.length;
  const boardLen = board.length;

  const bufs: Card[][] = holes.map((h) => [h[0]!, h[1]!, 0, 0, 0, 0, 0]);
  for (const b of bufs) for (let i = 0; i < boardLen; i++) b[2 + i] = board[i]!;
  const scores = new Float64Array(n);
  const wins = new Float64Array(n);
  const ties = new Float64Array(n);
  let total = 0;

  const settle = (): void => {
    let best = -1;
    let count = 0;
    for (let h = 0; h < n; h++) {
      const s = evaluate7(bufs[h]!).score;
      scores[h] = s;
      if (s > best) { best = s; count = 1; } else if (s === best) count++;
    }
    for (let h = 0; h < n; h++) {
      if (scores[h] === best) {
        if (count === 1) wins[h] = wins[h]! + 1;
        else ties[h] = ties[h]! + 1;
      }
    }
    total++;
  };
  const setBoard = (slot: number, c: Card): void => {
    for (let h = 0; h < n; h++) bufs[h]![2 + slot] = c;
  };

  if (boardLen === 0) {
    const r = rand ?? mulberry32(PREFLOP_DEFAULT_SEED);
    for (let it = 0; it < PREFLOP_SAMPLES; it++) {
      for (let i = 0; i < 5; i++) {
        const j = i + Math.floor(r() * (deckLen - i));
        const tmp = deck[i]!;
        deck[i] = deck[j]!;
        deck[j] = tmp;
        setBoard(i, deck[i]!);
      }
      settle();
    }
  } else if (boardLen === 5) {
    settle();
  } else if (boardLen === 4) {
    for (let a = 0; a < deckLen; a++) {
      setBoard(4, deck[a]!);
      settle();
    }
  } else {
    for (let a = 0; a < deckLen - 1; a++) {
      setBoard(3, deck[a]!);
      for (let b = a + 1; b < deckLen; b++) {
        setBoard(4, deck[b]!);
        settle();
      }
    }
  }

  const out: Equity[] = [];
  for (let h = 0; h < n; h++) out.push({ win: wins[h]! / total, tie: ties[h]! / total });
  return out;
}
