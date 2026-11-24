import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BlindLevelSchema,
  ChatMessageSchema,
  ChatSendSchema,
  ClientEventSchemas,
  ErrorMessageSchema,
  GameSettingsSchema,
  HandCommitmentSchema,
  HandEventMessageSchema,
  HandEventSchema,
  HostCommandMessageSchema,
  HostCommandSchema,
  LegalActionsSchema,
  MIN_TURN_SECONDS,
  NotifySchema,
  PartialGameSettingsSchema,
  PotSchema,
  ServerEventSchemas,
  TableActionSchema,
  TableClientSeedSchema,
  TableClockSchema,
  TableJoinAckSchema,
  TableJoinSchema,
  TableLeaveSchema,
  TableRebuySchema,
  TableResultsSchema,
  TableSeatsSchema,
  TableSitSchema,
  TableStatusMessageSchema,
  TableUseTimeBankSchema,
  TableViewSchema,
  type BlindLevel,
  type GameSettingsInput,
  type SeatView,
  type TableView,
} from '../src/index.js';

const GAME = '0b7c6a52-7d0e-4e7c-9f54-3c1c3a6f8f11';
const HAND = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PLAYER = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const SEED = '0123456789abcdef0123456789abcdef';
const COMMIT = 'a'.repeat(64);

function ok(schema: z.ZodType, value: unknown): void {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`expected success, got: ${JSON.stringify(r.error.issues)}`);
}
function bad(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function level(n: number, sb: number, bb: number, extra: Partial<BlindLevel> = {}): BlindLevel {
  return { level: n, smallBlind: sb, bigBlind: bb, ante: 0, anteKind: 'none', durationMinutes: 10, ...extra };
}

function cashSettings(over: Partial<GameSettingsInput> = {}): GameSettingsInput {
  return {
    kind: 'cash',
    maxSeats: 6,
    levels: [level(1, 1, 2)],
    minBuyIn: 40,
    maxBuyIn: 200,
    startingStack: 0,
    rebuys: { allowed: true, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    showAllInEquity: true,
    ...over,
  };
}

function tournamentSettings(over: Partial<GameSettingsInput> = {}): GameSettingsInput {
  return {
    kind: 'tournament',
    maxSeats: 9,
    levels: [level(1, 10, 20), level(2, 15, 30), level(3, 25, 50, { ante: 5, anteKind: 'bigBlind' })],
    minBuyIn: 0,
    maxBuyIn: 0,
    startingStack: 1500,
    turnSeconds: 30,
    timeBankSeconds: 120,
    timeBankTopUpSeconds: 5,
    rebuys: { allowed: true, untilLevel: 2 },
    payouts: [50, 30, 20],
    seatApproval: true,
    autoStart: false,
    showAllInEquity: true,
    ...over,
  };
}

const seatView: SeatView = {
  seat: 0,
  playerId: PLAYER,
  name: 'Alice',
  avatarUrl: null,
  stack: 100,
  bet: 2,
  folded: false,
  allIn: false,
  sittingOut: false,
  connected: true,
  cardsVisible: null,
  hasCards: true,
};

const legal = {
  seat: 0,
  canFold: true,
  canCheck: false,
  callAmount: 1,
  canBet: false,
  canRaise: true,
  minTo: 4,
  maxTo: 100,
};

function tableView(): TableView {
  return {
    gameId: GAME,
    settings: GameSettingsSchema.parse(cashSettings()),
    status: 'running',
    seats: [seatView, { ...seatView, seat: 3, cardsVisible: [12, 51] }],
    board: [0, 5, 10],
    pots: [{ amount: 4, eligible: [0, 3] }],
    handId: HAND,
    handNumber: 7,
    buttonSeat: 3,
    toAct: 0,
    legal,
    deadline: 1_700_000_000_000,
    mySeat: 0,
    myHole: [20, 21],
    commitment: COMMIT,
    chat: [{ gameId: GAME, id: 'm1', playerId: PLAYER, name: 'Alice', text: 'hi', at: 1_700_000_000_000 }],
    seatRequests: [{ playerId: PLAYER, name: 'Bob' }],
  };
}

describe('GameSettings', () => {
  it('accepts a valid cash game and applies defaults', () => {
    const s = GameSettingsSchema.parse(cashSettings());
    expect(s.turnSeconds).toBe(20);
    expect(s.timeBankSeconds).toBe(60);
    expect(s.timeBankTopUpSeconds).toBe(10);
    expect(s.autoStart).toBe(true);
  });

  it('accepts a valid tournament and keeps explicit values', () => {
    const s = GameSettingsSchema.parse(tournamentSettings());
    expect(s.turnSeconds).toBe(30);
    expect(s.autoStart).toBe(false);
    expect(s.levels).toHaveLength(3);
  });

  it('rejects payouts not summing to 100', () => {
    bad(GameSettingsSchema, tournamentSettings({ payouts: [50, 30] }));
    bad(GameSettingsSchema, tournamentSettings({ payouts: [60, 30, 20] }));
  });

  it('rejects non-integer or non-positive payouts', () => {
    bad(GameSettingsSchema, tournamentSettings({ payouts: [100, 0] }));
    bad(GameSettingsSchema, tournamentSettings({ payouts: [50.5, 49.5] }));
  });

  it('rejects cash with 2 levels', () => {
    bad(GameSettingsSchema, cashSettings({ levels: [level(1, 1, 2), level(2, 2, 4)] }));
  });

  it('rejects minBuyIn > maxBuyIn', () => {
    bad(GameSettingsSchema, cashSettings({ minBuyIn: 300, maxBuyIn: 200 }));
  });

  it('rejects each blind-level rule violation', () => {
    const t = (levels: BlindLevel[]) => bad(GameSettingsSchema, tournamentSettings({ levels }));
    t([]); // at least one level
    t([level(2, 10, 20)]); // numbers must start at 1
    t([level(1, 10, 20), level(3, 15, 30)]); // numbers in order
    t([level(1, 0, 2)]); // sb >= 1
    t([level(1, 10, 10)]); // bb > sb
    t([level(1, 10, 20), level(2, 5, 15)]); // bb non-decreasing
    t([level(1, 10, 20, { ante: -1 })]); // ante >= 0
    t([level(1, 10, 20, { durationMinutes: 0 })]); // duration >= 1
  });

  it('accepts equal big blinds across levels', () => {
    ok(GameSettingsSchema, tournamentSettings({ levels: [level(1, 10, 20), level(2, 10, 20)] }));
  });

  it('enforces turnSeconds bounds (min is 1 under test)', () => {
    expect(MIN_TURN_SECONDS).toBe(1);
    ok(GameSettingsSchema, cashSettings({ turnSeconds: 1 }));
    ok(GameSettingsSchema, cashSettings({ turnSeconds: 120 }));
    bad(GameSettingsSchema, cashSettings({ turnSeconds: 0 }));
    bad(GameSettingsSchema, cashSettings({ turnSeconds: 121 }));
  });

  it('enforces other numeric bounds', () => {
    bad(GameSettingsSchema, cashSettings({ maxSeats: 1 }));
    bad(GameSettingsSchema, cashSettings({ maxSeats: 10 }));
    bad(GameSettingsSchema, cashSettings({ timeBankSeconds: 601 }));
    bad(GameSettingsSchema, cashSettings({ timeBankTopUpSeconds: 121 }));
    bad(GameSettingsSchema, cashSettings({ minBuyIn: -1 }));
  });

  it('requires showAllInEquity to be literally true', () => {
    bad(GameSettingsSchema, { ...cashSettings(), showAllInEquity: false });
  });

  it('rejects unknown keys', () => {
    bad(GameSettingsSchema, { ...cashSettings(), extra: 1 });
  });
});

describe('client -> server messages', () => {
  it('table:join', () => {
    ok(TableJoinSchema, { gameId: GAME });
    bad(TableJoinSchema, { gameId: 'not-a-uuid' });
    bad(TableJoinSchema, {});
    bad(TableJoinSchema, { gameId: GAME, extra: true });
  });

  it('table:join ack', () => {
    ok(TableJoinAckSchema, { ok: true, view: tableView() });
    ok(TableJoinAckSchema, { ok: false, error: 'no such game' });
    bad(TableJoinAckSchema, { ok: true });
    bad(TableJoinAckSchema, { ok: false });
  });

  it('table:sit', () => {
    ok(TableSitSchema, { gameId: GAME, seat: 8, buyIn: 100, clientSeed: SEED });
    bad(TableSitSchema, { gameId: GAME, seat: 9, buyIn: 100, clientSeed: SEED });
    bad(TableSitSchema, { gameId: GAME, seat: 0, buyIn: -1, clientSeed: SEED });
    bad(TableSitSchema, { gameId: GAME, seat: 0, buyIn: 1.5, clientSeed: SEED });
    bad(TableSitSchema, { gameId: GAME, seat: 0, buyIn: Number.MAX_SAFE_INTEGER + 1, clientSeed: SEED });
  });

  it('rejects clientSeed with uppercase or wrong length', () => {
    bad(TableSitSchema, { gameId: GAME, seat: 0, buyIn: 100, clientSeed: SEED.toUpperCase() });
    bad(TableSitSchema, { gameId: GAME, seat: 0, buyIn: 100, clientSeed: SEED.slice(1) });
  });

  it('table:leave', () => {
    ok(TableLeaveSchema, { gameId: GAME });
    bad(TableLeaveSchema, { gameId: 42 });
  });

  it('table:action', () => {
    ok(TableActionSchema, { gameId: GAME, handId: HAND, kind: 'fold' });
    ok(TableActionSchema, { gameId: GAME, handId: HAND, kind: 'raise', amount: 40 });
    bad(TableActionSchema, { gameId: GAME, handId: HAND, kind: 'shove' });
    bad(TableActionSchema, { gameId: GAME, handId: HAND, kind: 'bet', amount: -5 });
    bad(TableActionSchema, { gameId: GAME, handId: 'h1', kind: 'check' });
  });

  it('table:clientSeed', () => {
    ok(TableClientSeedSchema, { gameId: GAME, handNumber: 0, clientSeed: SEED });
    bad(TableClientSeedSchema, { gameId: GAME, handNumber: -1, clientSeed: SEED });
    bad(TableClientSeedSchema, { gameId: GAME, handNumber: 1, clientSeed: 'xyz' });
  });

  it('table:useTimeBank', () => {
    ok(TableUseTimeBankSchema, { gameId: GAME });
    bad(TableUseTimeBankSchema, { gameId: GAME, seat: 1 });
  });

  it('table:rebuy', () => {
    ok(TableRebuySchema, { gameId: GAME });
    bad(TableRebuySchema, {});
  });

  it('chat:send trims and enforces length', () => {
    expect(ChatSendSchema.parse({ gameId: GAME, text: '  hello  ' }).text).toBe('hello');
    ok(ChatSendSchema, { gameId: GAME, text: 'x'.repeat(200) });
    ok(ChatSendSchema, { gameId: GAME, text: `  ${'x'.repeat(200)}  ` });
    bad(ChatSendSchema, { gameId: GAME, text: 'x'.repeat(201) });
    bad(ChatSendSchema, { gameId: GAME, text: '   ' });
    bad(ChatSendSchema, { gameId: GAME, text: '' });
  });

  it('host:command start/pause/resume/end/kick/approveSeat', () => {
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'start' } });
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'pause' } });
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'resume' } });
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'end' } });
    bad(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'end', now: true } });
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'kick', playerId: PLAYER } });
    ok(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'approveSeat', playerId: PLAYER, approve: false } });
    bad(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'explode' } });
    bad(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'kick' } });
    bad(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'approveSeat', playerId: PLAYER } });
    bad(HostCommandMessageSchema, { gameId: GAME, command: { kind: 'start', extra: 1 } });
    bad(HostCommandMessageSchema, { gameId: GAME });
  });

  it('host:command updateSettings accepts a partial object without filling defaults', () => {
    const r = HostCommandSchema.parse({ kind: 'updateSettings', settings: { maxSeats: 4, turnSeconds: 15 } });
    expect(r).toEqual({ kind: 'updateSettings', settings: { maxSeats: 4, turnSeconds: 15 } });
    expect(PartialGameSettingsSchema.parse({})).toEqual({});
    // cross-field rules are not applied to partials
    ok(PartialGameSettingsSchema, { payouts: [50] });
    // field-level rules still are
    bad(HostCommandSchema, { kind: 'updateSettings', settings: { maxSeats: 12 } });
    bad(HostCommandSchema, { kind: 'updateSettings', settings: { turnSeconds: 0 } });
    bad(HostCommandSchema, { kind: 'updateSettings', settings: { bogus: 1 } });
  });

  it('ClientEventSchemas covers every client event', () => {
    expect(Object.keys(ClientEventSchemas).sort()).toEqual(
      [
        'chat:send',
        'host:command',
        'table:action',
        'table:clientSeed',
        'table:join',
        'table:leave',
        'table:rebuy',
        'table:sit',
        'table:useTimeBank',
      ].sort(),
    );
    ok(ClientEventSchemas['table:join'], { gameId: GAME });
  });
});

describe('server -> client messages', () => {
  it('table:view', () => {
    ok(TableViewSchema, tableView());
    ok(TableViewSchema, {
      ...tableView(),
      status: 'waiting',
      handId: null,
      buttonSeat: null,
      toAct: null,
      legal: null,
      deadline: null,
      mySeat: null,
      myHole: [],
      commitment: null,
    });
    bad(TableViewSchema, { ...tableView(), status: 'done' });
    bad(TableViewSchema, { ...tableView(), board: [52] });
    bad(TableViewSchema, { ...tableView(), commitment: 'A'.repeat(64) });
    bad(TableViewSchema, { ...tableView(), settings: { ...tableView().settings, payouts: [90] } });
  });

  it('hand:event', () => {
    const events = [
      {
        type: 'handStarted',
        handId: HAND,
        handNumber: 1,
        buttonSeat: 0,
        stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none' },
        seats: [{ seat: 0, playerId: PLAYER, stack: 100 }],
        commitment: COMMIT,
        cardCommitments: [COMMIT],
      },
      { type: 'postAnte', seat: 1, amount: 1 },
      { type: 'postBlind', seat: 1, blind: 'small', amount: 1 },
      { type: 'dealHole', seat: 1, cards: [] },
      { type: 'toAct', seat: 0, legal, deadline: 123 },
      { type: 'action', seat: 0, kind: 'call', amount: 2, stackAfter: 98, auto: 'timeout' },
      { type: 'street', street: 'flop', cards: [1, 2, 3] },
      { type: 'uncalledReturned', seat: 0, amount: 10 },
      { type: 'potsFormed', pots: [{ amount: 10, eligible: [0, 1] }] },
      { type: 'showCards', seat: 0, cards: [4, 5], handName: 'Pair of Twos' },
      { type: 'muck', seat: 1 },
      { type: 'equity', street: 'turn', equities: [{ seat: 0, win: 0.5, tie: 0.1 }] },
      { type: 'potAwarded', potIndex: 0, seats: [0], amounts: [10] },
      { type: 'cardProof', position: 3, card: 7, salt: 'abc' },
      { type: 'handEnded', stacks: [{ seat: 0, stack: 110 }], clientSeeds: [SEED], nextCommitment: COMMIT },
    ];
    for (const event of events) ok(HandEventMessageSchema, { gameId: GAME, event });
    bad(HandEventMessageSchema, { gameId: GAME, event: { type: 'nope' } });
    bad(HandEventMessageSchema, { gameId: GAME, event: { type: 'postBlind', seat: 1, blind: 'medium', amount: 1 } });
    bad(HandEventSchema, { type: 'action', seat: 0, kind: 'call', amount: 2 });
  });

  it('hand:commitment', () => {
    ok(HandCommitmentSchema, { gameId: GAME, handNumber: 2, commitment: COMMIT });
    bad(HandCommitmentSchema, { gameId: GAME, handNumber: 2, commitment: 'a'.repeat(63) });
    bad(HandCommitmentSchema, { gameId: GAME, handNumber: 2, commitment: 'A'.repeat(64) });
  });

  it('table:seats', () => {
    ok(TableSeatsSchema, { gameId: GAME, seats: [seatView] });
    bad(TableSeatsSchema, { gameId: GAME, seats: [{ ...seatView, cardsVisible: [99] }] });
  });

  it('table:clock', () => {
    ok(TableClockSchema, { gameId: GAME, seat: 2, deadline: 1_700_000_000_000, timeBankMs: 60000, usingTimeBank: false });
    bad(TableClockSchema, { gameId: GAME, seat: 2, deadline: 1, timeBankMs: -1, usingTimeBank: false });
  });

  it('table:status', () => {
    ok(TableStatusMessageSchema, { gameId: GAME, status: 'paused' });
    ok(TableStatusMessageSchema, { gameId: GAME, status: 'running', level: level(2, 15, 30), nextLevelAt: 1 });
    bad(TableStatusMessageSchema, { gameId: GAME, status: 'stopped' });
  });

  it('table:results', () => {
    ok(TableResultsSchema, { gameId: GAME, results: [{ userId: PLAYER, name: 'A', place: 1, prize: 500 }] });
    bad(TableResultsSchema, { gameId: GAME, results: [{ userId: PLAYER, name: 'A', place: 0, prize: 500 }] });
  });

  it('chat:message', () => {
    ok(ChatMessageSchema, { gameId: GAME, id: 'm1', playerId: PLAYER, name: 'A', text: 'gg', at: 5 });
    bad(ChatMessageSchema, { gameId: GAME, id: 'm1', playerId: PLAYER, name: 'A', text: 'gg' });
  });

  it('notify', () => {
    ok(NotifySchema, { id: 'n1', kind: 'invite', text: 'Join!', link: '/game/1' });
    ok(NotifySchema, { id: 'n2', kind: 'integrityFlag', text: 'flag' });
    bad(NotifySchema, { id: 'n3', kind: 'spam', text: 'x' });
  });

  it('error', () => {
    ok(ErrorMessageSchema, { code: 'BAD_INPUT', message: 'nope' });
    bad(ErrorMessageSchema, { code: 'BAD_INPUT' });
  });

  it('ServerEventSchemas covers every server event', () => {
    expect(Object.keys(ServerEventSchemas)).toHaveLength(10);
  });
});

describe('engine shape schemas', () => {
  it('validate engine values', () => {
    ok(BlindLevelSchema, level(1, 1, 2));
    ok(PotSchema, { amount: 0, eligible: [] });
    ok(LegalActionsSchema, legal);
    bad(LegalActionsSchema, { ...legal, minTo: -1 });
  });
});
