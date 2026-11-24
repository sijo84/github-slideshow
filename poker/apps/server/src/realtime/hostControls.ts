/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { GameSettings, HostCommand } from '@poker/protocol';

export type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';
export type HostEffect = 'start' | 'kick' | 'pause' | 'resume' | 'end' | 'approve' | 'reject';

export function applyHostCommand(
  settings: GameSettings,
  status: GameStatus,
  cmd: HostCommand,
  actor: string,
  hostId: string,
): { settings: GameSettings; status: GameStatus; effects: HostEffect[] } | { error: string } {
  throw new Error('not implemented');
}
