import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32, type Card } from '@poker/engine';
import { TableStoreProvider, createBareTableStore } from '../src/table/storeContext.js';
import type { Equity } from '../src/table/types.js';
import {
  FINAL_ITERATIONS,
  FIRST_ITERATIONS,
  equityJob,
  isValidRequest,
  runEquityJob,
  type EquityCancel,
  type EquityReply,
  type EquityRequest,
} from '../src/workers/equityJob.js';
import { useEquity, type EquityWorkerLike } from '../src/workers/useEquity.js';

// Card = rank * 4 + suit (rank 12 = ace; suit 0 c, 1 d, 2 h, 3 s).
const card = (rank: number, suit: number): Card => rank * 4 + suit;
const As = card(12, 3);
const Ah = card(12, 2);
const Kd = card(11, 1);
const Qc = card(10, 0);
const Jc = card(9, 0);
const Tc = card(8, 0);
const deuce = card(0, 1);

function replies(req: EquityRequest, rand?: () => number, chunk?: number): EquityReply[] {
  return [...equityJob(req, rand, chunk)].filter((r): r is EquityReply => r !== undefined);
}

afterEach(() => {
  cleanup();
});

describe('equityJob', () => {
  it('yields 4,000 then 20,000 iterations with sane values (AsAh vs 1 preflop ~ 0.85)', () => {
    const out = replies({ id: 7, hole: [As, Ah], board: [], opponents: 1 }, mulberry32(12345));
    expect(out.map((r) => [r.iterations, r.final, r.id])).toEqual([
      [FIRST_ITERATIONS, false, 7],
      [FINAL_ITERATIONS, true, 7],
    ]);
    expect(FIRST_ITERATIONS).toBe(4_000);
    expect(FINAL_ITERATIONS).toBe(20_000);
    for (const r of out) {
      expect(r.win).toBeGreaterThan(0.82);
      expect(r.win).toBeLessThan(0.88);
      expect(r.tie).toBeGreaterThanOrEqual(0);
      expect(r.tie).toBeLessThan(0.02);
    }
  });

  it('yields between chunks (one step per chunk)', () => {
    const steps = [...equityJob({ id: 1, hole: [As, Ah], board: [], opponents: 2 }, mulberry32(1), 1_000)];
    expect(steps).toHaveLength(20);
    expect(steps[3]).toMatchObject({ iterations: 4_000, final: false });
    expect(steps.filter((s) => s === undefined)).toHaveLength(18);
  });

  it('works on the river (Monte Carlo over opponent hands)', () => {
    // Royal flush on board-plus-hole: hero cannot lose.
    const out = replies({ id: 1, hole: [card(12, 0), Kd], board: [Qc, Jc, Tc, card(11, 0), deuce], opponents: 3 }, mulberry32(9));
    expect(out.at(-1)).toMatchObject({ win: 1, tie: 0, final: true });
  });

  it('invalid input yields nothing', () => {
    const bad: unknown[] = [
      { id: 1, hole: [As], board: [], opponents: 1 },
      { id: 1, hole: [As, Ah], board: [Kd], opponents: 1 },
      { id: 1, hole: [As, Ah], board: [Kd, Qc], opponents: 1 },
      { id: 1, hole: [As, Ah], board: [], opponents: 0 },
      { id: 1, hole: [As, Ah], board: [], opponents: 9 },
      { id: 1, hole: [As, As], board: [], opponents: 1 },
      { id: 1, hole: [As, Ah], board: [Kd, Qc, Ah], opponents: 1 },
      { id: 1, hole: [As, 52], board: [], opponents: 1 },
      { id: 1.5, hole: [As, Ah], board: [], opponents: 1 },
      { type: 'cancel' },
      null,
    ];
    for (const b of bad) {
      expect(isValidRequest(b)).toBe(false);
      expect([...equityJob(b as EquityRequest)]).toEqual([]);
    }
    expect(isValidRequest({ id: 1, hole: [As, Ah], board: [Kd, Qc, Jc, Tc], opponents: 8 })).toBe(true);
  });

  it('runEquityJob stops between chunks when cancelled', async () => {
    const emitted: EquityReply[] = [];
    const token = { cancelled: false };
    let yields = 0;
    await runEquityJob({ id: 1, hole: [As, Ah], board: [], opponents: 1 }, (r) => emitted.push(r), token, {
      rand: mulberry32(3),
      chunk: 1_000,
      yieldFn: async () => {
        yields++;
        if (yields === 6) token.cancelled = true; // after the 4,000 reply, mid-refinement
      },
    });
    expect(yields).toBe(6);
    expect(emitted.map((r) => r.iterations)).toEqual([4_000]);
  });

  it('runEquityJob emits both replies when left alone', async () => {
    const emitted: EquityReply[] = [];
    await runEquityJob({ id: 2, hole: [As, Ah], board: [], opponents: 1 }, (r) => emitted.push(r), { cancelled: false }, {
      rand: mulberry32(4),
      chunk: 5_000,
    });
    expect(emitted.map((r) => [r.iterations, r.final])).toEqual([
      [4_000, false],
      [20_000, true],
    ]);
  });
});

class FakeWorker implements EquityWorkerLike {
  onmessage: ((e: MessageEvent<EquityReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: (EquityRequest | EquityCancel)[] = [];
  terminate = vi.fn();
  postMessage(message: EquityRequest | EquityCancel): void {
    this.posted.push(message);
  }
  reply(r: EquityReply): void {
    act(() => this.onmessage?.({ data: r } as MessageEvent<EquityReply>));
  }
  requests(): EquityRequest[] {
    return this.posted.filter((m): m is EquityRequest => 'id' in m);
  }
}

function setup(createWorker: () => EquityWorkerLike | null) {
  const setMyEquity = vi.fn<(e: Equity | null) => void>();
  const store = createBareTableStore({ setMyEquity });
  const wrapper = ({ children }: { children?: ReactNode }) => createElement(TableStoreProvider, { store }, children);
  const hook = renderHook(() => useEquity({ createWorker }), { wrapper });
  return { setMyEquity, hook };
}

const preflop = { hole: [As, Ah], board: [], opponents: 1 };
const flop = { hole: [As, Ah], board: [Kd, Qc, deuce], opponents: 2 };

describe('useEquity with a worker', () => {
  it('returns a stable function and creates the worker lazily, once', () => {
    const fake = new FakeWorker();
    const factory = vi.fn(() => fake);
    const { hook } = setup(factory);
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
    expect(factory).not.toHaveBeenCalled();
    act(() => first(preflop));
    act(() => first(flop));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.requests().map((r) => r.board.length)).toEqual([0, 3]);
  });

  it('the latest request wins: a late reply for an old id is ignored', () => {
    const fake = new FakeWorker();
    const { hook, setMyEquity } = setup(() => fake);
    act(() => hook.result.current(preflop));
    act(() => hook.result.current(flop));
    const [oldReq, newReq] = fake.requests();
    expect(newReq!.id).toBeGreaterThan(oldReq!.id);
    fake.reply({ id: newReq!.id, win: 0.6, tie: 0.01, iterations: 4_000, final: false });
    fake.reply({ id: oldReq!.id, win: 0.85, tie: 0.005, iterations: 20_000, final: true });
    fake.reply({ id: newReq!.id, win: 0.62, tie: 0.01, iterations: 20_000, final: true });
    expect(setMyEquity.mock.calls).toEqual([[{ win: 0.6, tie: 0.01 }], [{ win: 0.62, tie: 0.01 }]]);
  });

  it('identical consecutive requests are not re-sent', () => {
    const fake = new FakeWorker();
    const { hook } = setup(() => fake);
    act(() => hook.result.current(preflop));
    act(() => hook.result.current({ hole: [As, Ah], board: [], opponents: 1 }));
    expect(fake.requests()).toHaveLength(1);
    act(() => hook.result.current({ ...preflop, opponents: 3 }));
    expect(fake.requests()).toHaveLength(2);
  });

  it('null cancels and clears; later replies for the cancelled request are ignored', () => {
    const fake = new FakeWorker();
    const { hook, setMyEquity } = setup(() => fake);
    act(() => hook.result.current(preflop));
    const [req] = fake.requests();
    act(() => hook.result.current(null));
    expect(fake.posted.at(-1)).toEqual({ type: 'cancel' });
    expect(setMyEquity).toHaveBeenLastCalledWith(null);
    fake.reply({ id: req!.id, win: 0.85, tie: 0, iterations: 4_000, final: false });
    expect(setMyEquity).toHaveBeenCalledTimes(1);
    // The same request after a null is sent again.
    act(() => hook.result.current(preflop));
    expect(fake.requests()).toHaveLength(2);
  });

  it('an invalid request clears like null and is not sent', () => {
    const fake = new FakeWorker();
    const { hook, setMyEquity } = setup(() => fake);
    act(() => hook.result.current({ hole: [], board: [], opponents: 1 }));
    expect(fake.requests()).toHaveLength(0);
    expect(setMyEquity).toHaveBeenCalledWith(null);
  });

  it('terminates the worker on unmount and ignores replies after it', () => {
    const fake = new FakeWorker();
    const { hook, setMyEquity } = setup(() => fake);
    act(() => hook.result.current(preflop));
    const [req] = fake.requests();
    hook.unmount();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
    fake.reply({ id: req!.id, win: 0.85, tie: 0, iterations: 4_000, final: false });
    expect(setMyEquity).not.toHaveBeenCalled();
  });
});

describe('useEquity fallback (no Worker)', () => {
  it('jsdom has no Worker, so the default factory falls back', () => {
    expect(typeof Worker).toBe('undefined');
  });

  it('runs the job on the main thread and writes the result to setMyEquity', async () => {
    const { hook, setMyEquity } = setup(() => null);
    act(() => hook.result.current(preflop));
    await waitFor(() => expect(setMyEquity).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    for (const [e] of setMyEquity.mock.calls) {
      expect(e!.win).toBeGreaterThan(0.8);
      expect(e!.win).toBeLessThan(0.9);
    }
  });

  it('a newer request cancels the running fallback job', async () => {
    const { hook, setMyEquity } = setup(() => null);
    act(() => hook.result.current(preflop));
    act(() => hook.result.current({ hole: [deuce, card(5, 0)], board: [], opponents: 1 }));
    await waitFor(() => expect(setMyEquity).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    // 7-2 offsuit is far below AA: every value written comes from the newer request.
    for (const [e] of setMyEquity.mock.calls) expect(e!.win).toBeLessThan(0.45);
    await new Promise((r) => setTimeout(r, 50));
    expect(setMyEquity).toHaveBeenCalledTimes(2);
  });

  it('falls back when the worker reports an error', async () => {
    const fake = new FakeWorker();
    const { hook, setMyEquity } = setup(() => fake);
    act(() => hook.result.current(preflop));
    act(() => fake.onerror?.({} as ErrorEvent));
    expect(fake.terminate).toHaveBeenCalled();
    await waitFor(() => expect(setMyEquity).toHaveBeenCalledTimes(2), { timeout: 10_000 });
  });
});

describe('equity.worker module', () => {
  it('a new message cancels the running job; only the newer request gets replies', async () => {
    const scope = self as unknown as { onmessage: ((e: MessageEvent<unknown>) => void) | null; postMessage: unknown };
    const original = scope.postMessage;
    const posted: EquityReply[] = [];
    scope.postMessage = (m: EquityReply) => posted.push(m);
    try {
      await import('../src/workers/equity.worker.js');
      const send = (data: unknown) => scope.onmessage?.({ data } as MessageEvent<unknown>);
      send({ id: 1, hole: [As, Ah], board: [], opponents: 1 });
      send({ id: 2, hole: [As, Ah], board: [Kd, Qc, deuce], opponents: 2 });
      await waitFor(() => expect(posted.some((r) => r.final)).toBe(true), { timeout: 10_000 });
      expect(posted.map((r) => [r.id, r.iterations])).toEqual([
        [2, 4_000],
        [2, 20_000],
      ]);
      posted.length = 0;
      send({ id: 3, hole: [As, Ah], board: [], opponents: 1 });
      send({ type: 'cancel' });
      send({ id: 4, hole: [As], board: [], opponents: 1 }); // invalid: no reply
      await new Promise((r) => setTimeout(r, 100));
      expect(posted).toEqual([]);
    } finally {
      scope.postMessage = original;
      scope.onmessage = null;
    }
  });
});
