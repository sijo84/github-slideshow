/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { HandRecord } from './types.js';

export interface PlayerStats { hands: number; vpip: number; pfr: number; af: number; wtsd: number; wonAtShowdown: number; netChips: number }

export function computeStats(records: HandRecord[], playerId: string): PlayerStats {
  throw new Error('not implemented');
}
