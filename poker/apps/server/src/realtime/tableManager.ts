/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { ActionKind, HandRecord } from '@poker/engine';
import type { HostCommand, ResultEntry, ServerEventName, TableView } from '@poker/protocol';
import type { Pool } from 'pg';

export interface TableManagerDeps {
  pool: Pool;
  clock: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  emitTo: (userId: string, event: ServerEventName, payload: unknown) => void;
  emitRoom: (gameId: string, event: ServerEventName, payload: unknown) => void;
  seedWaitMs?: number;
  runoutPacingMs?: number;
}

export class TableManager {
  constructor(deps: TableManagerDeps) {}

  async open(gameId: string): Promise<void> {
    throw new Error('not implemented');
  }

  isOpen(gameId: string): boolean {
    throw new Error('not implemented');
  }

  async join(gameId: string, userId: string): Promise<TableView> {
    throw new Error('not implemented');
  }

  async sit(gameId: string, userId: string, seat: number, buyIn: number, clientSeed: string): Promise<void> {
    throw new Error('not implemented');
  }

  async leave(gameId: string, userId: string): Promise<void> {
    throw new Error('not implemented');
  }

  async act(gameId: string, userId: string, handId: string, kind: ActionKind, amount?: number): Promise<void> {
    throw new Error('not implemented');
  }

  setClientSeed(gameId: string, userId: string, handNumber: number, clientSeed: string): void {
    throw new Error('not implemented');
  }

  async useTimeBank(gameId: string, userId: string): Promise<void> {
    throw new Error('not implemented');
  }

  async rebuy(gameId: string, userId: string): Promise<void> {
    throw new Error('not implemented');
  }

  async host(gameId: string, userId: string, cmd: HostCommand): Promise<void> {
    throw new Error('not implemented');
  }

  setConnected(gameId: string, userId: string, connected: boolean): void {
    throw new Error('not implemented');
  }

  pendingSeatRequests(gameId: string): { playerId: string; name: string }[] {
    throw new Error('not implemented');
  }

  async results(gameId: string): Promise<ResultEntry[]> {
    throw new Error('not implemented');
  }

  onHandEnded(listener: (gameId: string, record: HandRecord) => void): void {
    throw new Error('not implemented');
  }
}
