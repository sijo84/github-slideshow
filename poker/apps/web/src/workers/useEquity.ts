/**
 * `useEquity()` (W12, PLAN I-11): returns a stable `(req | null) => void`. Requests go to one lazily created
 * equity worker per mounted hook; results are written to `setMyEquity` of the context store. Only replies to the
 * latest request are applied; `null` (or an invalid request) cancels and clears. Identical consecutive requests
 * are not re-sent. Without `Worker` (jsdom, old browsers) the job runs on the main thread in small chunks.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Card } from '@poker/engine';
import { useTableStoreApi } from '../table/storeContext.js';
import {
  isValidRequest,
  runEquityJob,
  type CancelToken,
  type EquityCancel,
  type EquityReply,
  type EquityRequest,
} from './equityJob.js';

export type EquityInput = { hole: Card[]; board: Card[]; opponents: number };

/** The part of `Worker` the hook uses, so tests can pass a fake. */
export interface EquityWorkerLike {
  onmessage: ((e: MessageEvent<EquityReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(message: EquityRequest | EquityCancel): void;
  terminate(): void;
}

/** Returns a worker, or `null` to use the main-thread fallback. */
export type EquityWorkerFactory = () => EquityWorkerLike | null;

export const defaultEquityWorkerFactory: EquityWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./equity.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
};

/** Iterations per chunk on the main thread (small, to keep frames short). */
const FALLBACK_CHUNK = 250;

export interface UseEquityOptions {
  createWorker?: EquityWorkerFactory;
}

export function useEquity(options?: UseEquityOptions): (req: EquityInput | null) => void {
  const store = useTableStoreApi();
  const storeRef = useRef(store);
  storeRef.current = store;
  const factoryRef = useRef(options?.createWorker ?? defaultEquityWorkerFactory);
  factoryRef.current = options?.createWorker ?? defaultEquityWorkerFactory;

  const worker = useRef<EquityWorkerLike | null>(null);
  const useFallback = useRef(false);
  const fallbackToken = useRef<CancelToken | null>(null);
  const latestId = useRef(0);
  const latestReq = useRef<EquityRequest | null>(null);
  const lastKey = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  const apply = useCallback((reply: EquityReply) => {
    if (!mounted.current || reply.id !== latestId.current) return;
    storeRef.current.getState().setMyEquity({ win: reply.win, tie: reply.tie });
  }, []);

  const cancelFallback = useCallback(() => {
    if (fallbackToken.current) fallbackToken.current.cancelled = true;
    fallbackToken.current = null;
  }, []);

  const runFallback = useCallback(
    (req: EquityRequest) => {
      cancelFallback();
      const token: CancelToken = { cancelled: false };
      fallbackToken.current = token;
      void runEquityJob(req, apply, token, { chunk: FALLBACK_CHUNK }).catch(() => undefined);
    },
    [apply, cancelFallback],
  );

  const getWorker = useCallback((): EquityWorkerLike | null => {
    if (useFallback.current) return null;
    if (worker.current) return worker.current;
    const w = factoryRef.current();
    if (!w) {
      useFallback.current = true;
      return null;
    }
    w.onmessage = (e) => apply(e.data);
    w.onerror = () => {
      // The worker failed to load or crashed: switch to the main thread and redo the latest request.
      w.terminate();
      if (worker.current === w) worker.current = null;
      useFallback.current = true;
      if (mounted.current && latestReq.current) runFallback(latestReq.current);
    };
    worker.current = w;
    return w;
  }, [apply, runFallback]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelFallback();
      worker.current?.terminate();
      worker.current = null;
      latestReq.current = null;
      lastKey.current = undefined; // a remount (StrictMode) must re-send the same request
    };
  }, [cancelFallback]);

  return useCallback(
    (input: EquityInput | null) => {
      const req: EquityRequest | null = input
        ? { id: latestId.current + 1, hole: input.hole, board: input.board, opponents: input.opponents }
        : null;
      const valid = req !== null && isValidRequest(req);
      const key = valid ? JSON.stringify([req.hole, req.board, req.opponents]) : 'null';
      if (key === lastKey.current) return;
      lastKey.current = key;

      if (!valid) {
        latestId.current += 1; // replies still in flight are now stale
        latestReq.current = null;
        cancelFallback();
        worker.current?.postMessage({ type: 'cancel' });
        storeRef.current.getState().setMyEquity(null);
        return;
      }

      latestId.current = req.id;
      latestReq.current = req;
      const w = getWorker();
      if (w) w.postMessage(req);
      else runFallback(req);
    },
    [cancelFallback, getWorker, runFallback],
  );
}
