/**
 * Pure core of the equity worker (W12). `equityJob` is a generator that runs `equityVsRandom` in chunks and
 * yields after every chunk, so the caller can stop between chunks when a newer request arrives. It yields a
 * reply at 4,000 iterations and a final one at 20,000 (cumulative: the final result includes the first 4,000).
 * `runEquityJob` drives a job, waiting for a macrotask between chunks; the worker and the main-thread fallback
 * of `useEquity` both use it. No DOM or Node APIs here.
 */
import { equityVsRandom, type Card } from '@poker/engine';

export interface EquityRequest {
  id: number;
  hole: Card[];
  board: Card[];
  opponents: number;
}

export interface EquityReply {
  id: number;
  win: number;
  tie: number;
  iterations: number;
  final: boolean;
}

/** Sent by `useEquity` to stop the running job without starting another (any message cancels the running job). */
export interface EquityCancel {
  type: 'cancel';
}

export const FIRST_ITERATIONS = 4_000;
export const FINAL_ITERATIONS = 20_000;
export const DEFAULT_CHUNK = 1_000;

function isCard(c: unknown): c is Card {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 51;
}

/** 2 hole cards, 0/3/4/5 board cards, 1..8 opponents, cards 0..51 with no duplicates, integer id. */
export function isValidRequest(req: unknown): req is EquityRequest {
  if (typeof req !== 'object' || req === null) return false;
  const r = req as Partial<Record<keyof EquityRequest, unknown>>;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id)) return false;
  if (typeof r.opponents !== 'number' || !Number.isInteger(r.opponents) || r.opponents < 1 || r.opponents > 8) return false;
  if (!Array.isArray(r.hole) || r.hole.length !== 2) return false;
  if (!Array.isArray(r.board) || ![0, 3, 4, 5].includes(r.board.length)) return false;
  const all: unknown[] = [...r.hole, ...r.board];
  if (!all.every(isCard)) return false;
  return new Set(all).size === all.length;
}

/**
 * Yields `undefined` after each chunk that ends no milestone, and an `EquityReply` after the chunks that reach
 * 4,000 and 20,000 iterations. Invalid input yields nothing.
 */
export function* equityJob(
  req: EquityRequest,
  rand?: () => number,
  chunk: number = DEFAULT_CHUNK,
): Generator<EquityReply | undefined, void, void> {
  if (!isValidRequest(req)) return;
  const size = Math.max(1, Math.floor(chunk));
  const milestones = [FIRST_ITERATIONS, FINAL_ITERATIONS];
  let done = 0;
  let wins = 0;
  let ties = 0;
  for (const target of milestones) {
    while (done < target) {
      const n = Math.min(size, target - done);
      const e = equityVsRandom(req.hole, req.board, req.opponents, n, rand);
      wins += Math.round(e.win * n);
      ties += Math.round(e.tie * n);
      done += n;
      if (done < target) yield undefined;
    }
    yield { id: req.id, win: wins / done, tie: ties / done, iterations: done, final: target === FINAL_ITERATIONS };
  }
}

export interface CancelToken {
  cancelled: boolean;
}

/** Resolves on the next macrotask, so queued messages (a cancel, a newer request) get processed first. */
export function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Runs a job to the end or until `token.cancelled`, calling `emit` for each reply and yielding between chunks. */
export async function runEquityJob(
  req: EquityRequest,
  emit: (reply: EquityReply) => void,
  token: CancelToken,
  options: { rand?: () => number; chunk?: number; yieldFn?: () => Promise<void> } = {},
): Promise<void> {
  const wait = options.yieldFn ?? macrotask;
  const job = equityJob(req, options.rand, options.chunk);
  while (!token.cancelled) {
    const step = job.next(); // computes one chunk
    if (step.done) return;
    const reply = step.value;
    if (reply) emit(reply);
    if (reply?.final) return;
    await wait();
  }
}
