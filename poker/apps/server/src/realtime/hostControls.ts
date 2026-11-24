/**
 * Host commands as a pure state transition (PLAN.md S17, I-9 "Statuses" / "Starting (F4)").
 *
 * `applyHostCommand` checks who sent the command and whether it fits the game's DB-style status, validates
 * settings changes, and returns the next settings and status plus the effects the TableManager must carry
 * out. It does no I/O, never mutates its inputs and never throws: every rejection is `{ error }`.
 */
import {
  GameSettingsSchema,
  HostCommandSchema,
  PartialGameSettingsSchema,
  type GameSettings,
  type HostCommand,
} from '@poker/protocol';

export type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';
export type HostEffect = 'start' | 'kick' | 'pause' | 'resume' | 'end' | 'approve' | 'reject';

export type HostResult = { settings: GameSettings; status: GameStatus; effects: HostEffect[] } | { error: string };

/** Settings that shape the table itself and may not change once the game has started. */
const LOCKED_AFTER_START = ['kind', 'maxSeats'] as const;

function startedStatus(status: GameStatus): boolean {
  return status === 'running' || status === 'paused';
}

function firstIssue(issues: readonly { message: string }[], fallback: string): string {
  return issues[0]?.message ?? fallback;
}

function updateSettings(settings: GameSettings, status: GameStatus, partialInput: unknown): HostResult {
  const partial = PartialGameSettingsSchema.safeParse(partialInput);
  if (!partial.success) return { error: firstIssue(partial.error.issues, 'Invalid settings') };
  if (startedStatus(status)) {
    for (const key of LOCKED_AFTER_START) {
      const next = partial.data[key];
      if (next !== undefined && next !== settings[key]) {
        return { error: `${key} cannot be changed after the game has started` };
      }
    }
  }
  const merged = GameSettingsSchema.safeParse({ ...settings, ...partial.data });
  if (!merged.success) return { error: firstIssue(merged.error.issues, 'Invalid settings') };
  return { settings: merged.data, status, effects: [] };
}

export function applyHostCommand(
  settings: GameSettings,
  status: GameStatus,
  cmd: HostCommand,
  actor: string,
  hostId: string,
): HostResult {
  if (actor !== hostId) return { error: 'Only the host can do that' };
  if (status === 'finished' || status === 'cancelled') return { error: 'This game is over' };

  const parsed = HostCommandSchema.safeParse(cmd);
  if (!parsed.success) return { error: firstIssue(parsed.error.issues, 'Invalid host command') };
  const command = parsed.data;

  switch (command.kind) {
    case 'start':
      return status === 'open'
        ? { settings, status: 'running', effects: ['start'] }
        : { error: 'The game can only be started while it is open' };
    case 'pause':
      return status === 'running'
        ? { settings, status: 'paused', effects: ['pause'] }
        : { error: 'Only a running game can be paused' };
    case 'resume':
      return status === 'paused'
        ? { settings, status: 'running', effects: ['resume'] }
        : { error: 'Only a paused game can be resumed' };
    case 'end':
      return status === 'open' || startedStatus(status)
        ? { settings, status: 'finished', effects: ['end'] }
        : { error: 'The game has not opened yet' };
    case 'kick':
      return command.playerId === hostId
        ? { error: 'The host cannot kick themself' }
        : { settings, status, effects: ['kick'] };
    case 'approveSeat':
      return { settings, status, effects: [command.approve ? 'approve' : 'reject'] };
    case 'updateSettings':
      return updateSettings(settings, status, command.settings);
  }
}
