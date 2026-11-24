/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Pool } from 'pg';
import type { notify } from '../notify.js';

export interface SchedulerDeps {
  pool: Pool;
  clock: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  tables: { open(gameId: string): Promise<void> };
  notify: typeof notify;
}

/** Stub: schedules nothing and returns a no-op stop function. */
export function startScheduler(deps: SchedulerDeps): () => void {
  return () => {};
}
