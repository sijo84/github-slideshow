/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Chips, HandRecord } from './types.js';

export type FlagKind = 'chipDumping' | 'softPlay' | 'sharedIp' | 'sharedDevice';

export interface IntegrityFlag { kind: FlagKind; players: [string, string]; score: number; evidenceHandIds: string[]; summary: string }

export function analyse(records: HandRecord[], bigBlind: Chips): IntegrityFlag[] {
  throw new Error('not implemented');
}

export function sharedNetwork(sessions: { playerId: string; ip: string; deviceId: string }[]): IntegrityFlag[] {
  throw new Error('not implemented');
}
