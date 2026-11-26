import '@testing-library/jest-dom/vitest';
import type { HandEvent } from '@poker/engine';
import type { TableView } from '@poker/protocol';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/anim/tween.js';
import {
  cardPlacePosition,
  chipPlacePosition,
  SceneContext,
  SeatActionsContext,
  useScene,
  useSeatActions,
  type Scene,
} from '../src/table/sceneContext.js';
import { createBareTableStore, TableStoreProvider, useTable, useTableStoreApi } from '../src/table/storeContext.js';
import { DEAL_STAGGER_MS, initialTableState, STEP_MS } from '../src/table/types.js';

afterEach(() => {
  cleanup();
});

describe('initialTableState', () => {
  it('returns every data field at its empty value', () => {
    expect(initialTableState()).toEqual({
      gameId: null,
      settings: null,
      status: 'waiting',
      level: null,
      nextLevelAt: null,
      handId: null,
      handNumber: 0,
      buttonSeat: null,
      seats: [],
      board: [],
      pots: [],
      toAct: null,
      legal: null,
      deadline: null,
      timeBank: null,
      mySeat: null,
      myPlayerId: null,
      myHole: [],
      myEquity: null,
      allInEquity: null,
      chat: [],
      chatError: null,
      seatRequests: [],
      results: null,
      commitment: null,
      handLog: [],
      verified: null,
      lastError: null,
      cards: [],
      chips: [],
      queue: [],
      playing: null,
      animate: true,
    });
  });

  it('returns fresh arrays on every call', () => {
    const a = initialTableState();
    const b = initialTableState();
    expect(a.cards).not.toBe(b.cards);
    expect(a.queue).not.toBe(b.queue);
  });

  it('has the step durations from I-11', () => {
    expect(STEP_MS).toEqual({
      newHand: 350,
      bet: 300,
      deal: 380,
      turn: 0,
      action: 0,
      fold: 300,
      collect: 450,
      return: 300,
      pots: 0,
      board: 380,
      flip: 300,
      muck: 300,
      equity: 0,
      award: 600,
      handEnd: 0,
    });
    expect(DEAL_STAGGER_MS).toBe(90);
  });
});

describe('createBareTableStore', () => {
  it('starts from initialTableState with the overrides applied', () => {
    const store = createBareTableStore({ handNumber: 7, mySeat: 2, animate: false });
    const s = store.getState();
    expect(s.handNumber).toBe(7);
    expect(s.mySeat).toBe(2);
    expect(s.animate).toBe(false);
    expect(s.status).toBe('waiting');
    expect(s.cards).toEqual([]);
  });

  it('has inert actions that can be called without throwing or changing state', () => {
    const store = createBareTableStore();
    const before = store.getState();
    const s = store.getState();
    const event = { type: 'street' } as unknown as HandEvent;
    const view = {} as unknown as TableView;
    expect(() => {
      s.applyView(view);
      s.applyEvent(event);
      s.applySeats([]);
      s.applyClock({} as never);
      s.applyStatus({} as never);
      s.applyCommitment({} as never);
      s.applyResults([]);
      s.addChat({} as never);
      s.setChatError('x');
      s.setError('x');
      s.setMyEquity({ win: 0.5, tie: 0 });
      s.begin(1);
      s.consume(1);
      s.flush();
      s.reset();
    }).not.toThrow();
    expect(store.getState()).toBe(before);
  });

  it('setState works', () => {
    const store = createBareTableStore();
    store.setState({ handNumber: 3 });
    expect(store.getState().handNumber).toBe(3);
  });

  it('an override can replace an action', () => {
    let begun = -1;
    const store = createBareTableStore({ begin: (id) => (begun = id) });
    store.getState().begin(4);
    expect(begun).toBe(4);
  });
});

function HandNo() {
  const n = useTable((s) => s.handNumber);
  return <span data-testid="n">{n}</span>;
}

describe('useTable / useTableStoreApi', () => {
  it('reads the provided store and re-renders on setState', () => {
    const store = createBareTableStore({ handNumber: 1 });
    let renders = 0;
    function Counted() {
      renders++;
      return <HandNo />;
    }
    render(
      <TableStoreProvider store={store}>
        <Counted />
      </TableStoreProvider>,
    );
    expect(screen.getByTestId('n')).toHaveTextContent('1');
    act(() => store.setState({ handNumber: 2 }));
    expect(screen.getByTestId('n')).toHaveTextContent('2');
    expect(renders).toBe(1); // only the subscriber re-rendered
  });

  it('useTableStoreApi returns the provided store', () => {
    const store = createBareTableStore();
    const { result } = renderHook(() => useTableStoreApi(), {
      wrapper: ({ children }) => <TableStoreProvider store={store}>{children}</TableStoreProvider>,
    });
    expect(result.current).toBe(store);
  });

  it('throws a clear error without a provider', () => {
    const quiet = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', quiet);
    try {
      expect(() => render(<HandNo />)).toThrow(/TableStoreProvider/);
      expect(() => renderHook(() => useTableStoreApi())).toThrow(/TableStoreProvider/);
    } finally {
      window.removeEventListener('error', quiet);
    }
  });
});

const scene: Scene = {
  maxSeats: 6,
  mySeat: null,
  seatPosition: (seat) => [seat * 10, 0, 20],
  betPosition: (seat) => [seat, 0.01, 2],
  potPosition: (index) => [index, 0.01, 0],
  boardPosition: (index) => [index * 0.5, 0.01, -0.5],
  buttonPosition: (seat) => [seat, 0.01, 1],
  dealerPosition: [0, 0.01, -3],
  muckPosition: [3, 0.01, -3],
};

function close(a: Vec3, b: Vec3): void {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 10);
}

describe('cardPlacePosition / chipPlacePosition', () => {
  it('places cards', () => {
    expect(cardPlacePosition(scene, { at: 'deck' })).toEqual([0, 0.01, -3]);
    expect(cardPlacePosition(scene, { at: 'muck' })).toEqual([3, 0.01, -3]);
    expect(cardPlacePosition(scene, { at: 'board', index: 2 })).toEqual([1, 0.01, -0.5]);
    // seat 1 at [10, 0, 20]; 15% toward the centre → [8.5, _, 17]; ±0.22 on x; y 0.02
    close(cardPlacePosition(scene, { at: 'seat', seat: 1, index: 0 }), [8.5 - 0.22, 0.02, 17]);
    close(cardPlacePosition(scene, { at: 'seat', seat: 1, index: 1 }), [8.5 + 0.22, 0.02, 17]);
  });

  it('places chips', () => {
    expect(chipPlacePosition(scene, { at: 'seat', seat: 2 })).toEqual([20, 0, 20]);
    expect(chipPlacePosition(scene, { at: 'bet', seat: 2 })).toEqual([2, 0.01, 2]);
    expect(chipPlacePosition(scene, { at: 'pot', index: 1 })).toEqual([1, 0.01, 0]);
  });
});

describe('SceneContext / SeatActionsContext', () => {
  it('useScene returns the provided scene and throws without one', () => {
    const { result } = renderHook(() => useScene(), {
      wrapper: ({ children }) => <SceneContext.Provider value={scene}>{children}</SceneContext.Provider>,
    });
    expect(result.current).toBe(scene);
    const quiet = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', quiet);
    try {
      expect(() => renderHook(() => useScene())).toThrow(/SceneContext/);
    } finally {
      window.removeEventListener('error', quiet);
    }
  });

  it('useSeatActions has inert defaults and returns a provided value', () => {
    const d = renderHook(() => useSeatActions()).result.current;
    expect(() => {
      d.onSit(0);
      d.onOpenNotes('p', 'n');
    }).not.toThrow();
    const sat: number[] = [];
    const value = { onSit: (s: number) => sat.push(s), onOpenNotes: () => {} };
    const { result } = renderHook(() => useSeatActions(), {
      wrapper: ({ children }) => <SeatActionsContext.Provider value={value}>{children}</SeatActionsContext.Provider>,
    });
    result.current.onSit(3);
    expect(sat).toEqual([3]);
  });
});
