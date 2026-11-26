// stub (W0): replaced by task W11
import { useStore, type StoreApi } from 'zustand';
import { createBareTableStore } from './storeContext.js';
import type { TableState } from './types.js';

export function createTableStore(): StoreApi<TableState> {
  return createBareTableStore();
}

/** The live singleton. */
export const tableStore: StoreApi<TableState> = createTableStore();

/** Zustand hook bound to `tableStore`. */
export function useTableStore<T>(selector: (s: TableState) => T): T {
  return useStore(tableStore, selector);
}

export function connectTable(_gameId: string, _store?: StoreApi<TableState>): () => void {
  throw new Error('not implemented');
}

/** Stub: inert (plays nothing) rather than throwing, so a page that mounts it can render. */
export function useDirector(_store?: StoreApi<TableState>): void {}
