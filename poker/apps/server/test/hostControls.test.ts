import { randomUUID } from 'node:crypto';
import { GameSettingsSchema, type GameSettings, type HostCommand, type PartialGameSettings } from '@poker/protocol';
import { describe, expect, it } from 'vitest';
import { applyHostCommand, type GameStatus, type HostEffect } from '../src/realtime/hostControls.js';

const HOST = randomUUID();
const PLAYER = randomUUID();
const ALL_STATUSES: GameStatus[] = ['scheduled', 'open', 'running', 'paused', 'finished', 'cancelled'];
const LIVE_STATUSES: GameStatus[] = ['scheduled', 'open', 'running', 'paused'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function cashSettings(): GameSettings {
  return GameSettingsSchema.parse({
    kind: 'cash',
    maxSeats: 6,
    levels: [{ level: 1, smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none', durationMinutes: 60 }],
    minBuyIn: 200,
    maxBuyIn: 2000,
    startingStack: 1000,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    showAllInEquity: true,
  });
}

function tournamentSettings(): GameSettings {
  return GameSettingsSchema.parse({
    ...cashSettings(),
    kind: 'tournament',
    levels: [
      { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, anteKind: 'none', durationMinutes: 10 },
      { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, anteKind: 'none', durationMinutes: 10 },
    ],
    payouts: [60, 40],
  });
}

const COMMANDS: HostCommand[] = [
  { kind: 'start' },
  { kind: 'pause' },
  { kind: 'resume' },
  { kind: 'end' },
  { kind: 'kick', playerId: PLAYER },
  { kind: 'approveSeat', playerId: PLAYER, approve: true },
  { kind: 'updateSettings', settings: { turnSeconds: 30 } },
];

/** Runs a command against frozen inputs and checks the inputs come back unchanged. */
function run(cmd: HostCommand, status: GameStatus, opts: { settings?: GameSettings; actor?: string } = {}) {
  const settings = deepFreeze(opts.settings ?? cashSettings());
  const before = structuredClone(settings);
  const frozenCmd = deepFreeze(structuredClone(cmd));
  const cmdBefore = structuredClone(frozenCmd);
  const res = applyHostCommand(settings, status, frozenCmd, opts.actor ?? HOST, HOST);
  expect(settings).toEqual(before);
  expect(frozenCmd).toEqual(cmdBefore);
  return res;
}

function ok(cmd: HostCommand, status: GameStatus, settings?: GameSettings) {
  const res = run(cmd, status, { settings });
  if ('error' in res) throw new Error(`expected success, got error: ${res.error}`);
  return res;
}

function error(cmd: HostCommand, status: GameStatus, settings?: GameSettings): string {
  const res = run(cmd, status, { settings });
  if (!('error' in res)) throw new Error(`expected an error, got ${JSON.stringify(res)}`);
  expect(res.error).toEqual(expect.any(String));
  expect(res.error.length).toBeGreaterThan(0);
  return res.error;
}

describe('applyHostCommand: who may command', () => {
  it.each(COMMANDS.map((c) => [c.kind, c] as const))('rejects %s from a non-host in every status', (_kind, cmd) => {
    for (const status of ALL_STATUSES) {
      const res = run(cmd, status, { actor: PLAYER });
      expect(res).toEqual({ error: 'Only the host can do that' });
    }
  });

  it.each(COMMANDS.map((c) => [c.kind, c] as const))('rejects %s once the game is over', (_kind, cmd) => {
    for (const status of ['finished', 'cancelled'] as const) {
      expect(run(cmd, status)).toEqual({ error: 'This game is over' });
    }
  });
});

describe('applyHostCommand: status transitions', () => {
  const table: { cmd: HostCommand; allowed: Partial<Record<GameStatus, GameStatus>>; effect: HostEffect }[] = [
    { cmd: { kind: 'start' }, allowed: { open: 'running' }, effect: 'start' },
    { cmd: { kind: 'pause' }, allowed: { running: 'paused' }, effect: 'pause' },
    { cmd: { kind: 'resume' }, allowed: { paused: 'running' }, effect: 'resume' },
    { cmd: { kind: 'end' }, allowed: { open: 'finished', running: 'finished', paused: 'finished' }, effect: 'end' },
  ];

  for (const { cmd, allowed, effect } of table) {
    for (const status of LIVE_STATUSES) {
      const next = allowed[status];
      if (next) {
        it(`${cmd.kind} in ${status} → ${next}`, () => {
          const settings = cashSettings();
          const res = ok(cmd, status, settings);
          expect(res.status).toBe(next);
          expect(res.effects).toEqual([effect]);
          expect(res.settings).toEqual(settings);
        });
      } else {
        it(`${cmd.kind} in ${status} is rejected`, () => {
          error(cmd, status);
        });
      }
    }
  }
});

describe('applyHostCommand: kick and seat approval', () => {
  it.each(LIVE_STATUSES)('kicks another player in %s, keeping the status', (status) => {
    const res = ok({ kind: 'kick', playerId: PLAYER }, status);
    expect(res.status).toBe(status);
    expect(res.effects).toEqual(['kick']);
  });

  it('rejects kicking the host', () => {
    for (const status of LIVE_STATUSES) error({ kind: 'kick', playerId: HOST }, status);
  });

  it.each(LIVE_STATUSES)('approves and rejects seat requests in %s', (status) => {
    const yes = ok({ kind: 'approveSeat', playerId: PLAYER, approve: true }, status);
    expect(yes).toMatchObject({ status, effects: ['approve'] });
    const no = ok({ kind: 'approveSeat', playerId: PLAYER, approve: false }, status);
    expect(no).toMatchObject({ status, effects: ['reject'] });
  });

  it('rejects a malformed command instead of throwing', () => {
    const bad = { kind: 'kick', playerId: 'not-a-uuid' } as HostCommand;
    expect(() => run(bad, 'open')).not.toThrow();
    error(bad, 'open');
    error({ kind: 'nonsense' } as unknown as HostCommand, 'open');
  });
});

describe('applyHostCommand: updateSettings', () => {
  const update = (settings: PartialGameSettings): HostCommand => ({ kind: 'updateSettings', settings });

  it.each(LIVE_STATUSES)('merges a valid partial in %s with no effects', (status) => {
    const base = cashSettings();
    const res = ok(update({ turnSeconds: 30, seatApproval: true }), status, base);
    expect(res.status).toBe(status);
    expect(res.effects).toEqual([]);
    expect(res.settings).toEqual({ ...base, turnSeconds: 30, seatApproval: true });
  });

  it('rejects an invalid field (turnSeconds 0)', () => {
    error(update({ turnSeconds: 0 }), 'open');
  });

  it('rejects an unknown field', () => {
    error(update({ bogus: 1 } as unknown as PartialGameSettings), 'open');
  });

  it('rejects minBuyIn above maxBuyIn after merging', () => {
    expect(error(update({ minBuyIn: 5000 }), 'open')).toBe('minBuyIn must be <= maxBuyIn');
  });

  it('rejects payouts that do not sum to 100', () => {
    expect(error(update({ payouts: [50, 30] }), 'open')).toBe('payouts must sum to 100 (got 80)');
  });

  it('rejects a second level on a cash game', () => {
    const levels = [
      ...cashSettings().levels,
      { level: 2, smallBlind: 10, bigBlind: 20, ante: 0, anteKind: 'none' as const, durationMinutes: 60 },
    ];
    expect(error(update({ levels }), 'open')).toBe('cash games must have exactly 1 level');
  });

  it('allows changing kind and maxSeats before the game starts', () => {
    for (const status of ['scheduled', 'open'] as const) {
      const seats = ok(update({ maxSeats: 9 }), status);
      expect(seats.settings.maxSeats).toBe(9);
      const t = tournamentSettings();
      const kind = ok(update({ kind: 'cash', levels: [t.levels[0]!], payouts: [100] }), status, t);
      expect(kind.settings.kind).toBe('cash');
    }
  });

  it('rejects changing kind or maxSeats once the game is running or paused', () => {
    for (const status of ['running', 'paused'] as const) {
      expect(error(update({ maxSeats: 9 }), status)).toMatch(/maxSeats/);
      const t = tournamentSettings();
      expect(error(update({ kind: 'cash', levels: [t.levels[0]!], payouts: [100] }), status, t)).toMatch(/kind/);
    }
  });

  it('allows restating the unchanged kind and maxSeats while running', () => {
    const res = ok(update({ kind: 'cash', maxSeats: 6, turnSeconds: 25 }), 'running');
    expect(res.settings.turnSeconds).toBe(25);
  });

  it('allows a blind level change while running', () => {
    const levels = [{ level: 1, smallBlind: 10, bigBlind: 20, ante: 0, anteKind: 'none' as const, durationMinutes: 60 }];
    const res = ok(update({ levels }), 'running');
    expect(res.settings.levels).toEqual(levels);
    expect(res.status).toBe('running');

    const t = tournamentSettings();
    const longer = t.levels.map((l) => ({ ...l, durationMinutes: 15 }));
    const tRes = ok(update({ levels: longer }), 'paused', t);
    expect(tRes.settings.levels.map((l) => l.durationMinutes)).toEqual([15, 15]);
  });

  it('returns a fresh settings object, not the input', () => {
    const base = cashSettings();
    const res = ok(update({ turnSeconds: 30 }), 'open', base);
    expect(res.settings).not.toBe(base);
    expect(base.turnSeconds).toBe(20);
  });
});
