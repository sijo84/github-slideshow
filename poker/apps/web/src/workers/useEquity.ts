// stub (W0): replaced by task W12
import type { Card } from '@poker/engine';

/** Stub: returns an inert request function (no worker) rather than throwing, so a page that calls it can render. */
export function useEquity(): (req: { hole: Card[]; board: Card[]; opponents: number } | null) => void {
  return () => {};
}
