/**
 * Table store context (W0, final; PLAN I-11 item 3). Every table component reads the store only through
 * `useTable` / `useTableStoreApi`, so the replayer can hand the same components a different store.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { initialTableState, type TableActions, type TableState } from './types.js';

export const TableStoreContext = createContext<StoreApi<TableState> | null>(null);

export function TableStoreProvider({ store, children }: { store: StoreApi<TableState>; children?: ReactNode }) {
  return <TableStoreContext.Provider value={store}>{children}</TableStoreContext.Provider>;
}

/** The store from the nearest `TableStoreProvider`; throws without one. */
export function useTableStoreApi(): StoreApi<TableState> {
  const store = useContext(TableStoreContext);
  if (!store) throw new Error('useTable/useTableStoreApi must be used inside a <TableStoreProvider>');
  return store;
}

/** Selects from the context store and re-renders when the selected value changes. */
export function useTable<T>(selector: (s: TableState) => T): T {
  return useStore(useTableStoreApi(), selector);
}

const noop = (): void => {};

function inertActions(): TableActions {
  return {
    applyView: noop,
    applyEvent: noop,
    applySeats: noop,
    applyClock: noop,
    applyStatus: noop,
    applyCommitment: noop,
    applyResults: noop,
    addChat: noop,
    setChatError: noop,
    setError: noop,
    setMyEquity: noop,
    begin: noop,
    consume: noop,
    flush: noop,
    reset: noop,
  };
}

/** A vanilla zustand store with `initialTableState()`, inert actions and `overrides` on top. Component tests
 *  build hand-made state with it (and change it with `store.setState`). */
export function createBareTableStore(overrides?: Partial<TableState>): StoreApi<TableState> {
  return createStore<TableState>()(() => ({ ...initialTableState(), ...inertActions(), ...overrides }));
}
