import { z } from 'zod';
import type {
  ActionKind,
  AnteKind,
  BlindLevel,
  Card,
  Chips,
  HandEvent,
  LegalActions,
  Pot,
  SeatIndex,
  SeatInput,
  Stakes,
  Street,
} from '@poker/engine';

export type {
  ActionKind,
  AnteKind,
  BlindLevel,
  Card,
  Chips,
  HandEvent,
  LegalActions,
  Pot,
  SeatIndex,
  SeatInput,
  Stakes,
  Street,
};

// ---------------------------------------------------------------------------
// Compile-time type equality helpers
// ---------------------------------------------------------------------------

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UuidSchema = z.uuid();
/** Safe non-negative integer (z.int() is restricted to safe integers). */
export const ChipsSchema = z.int().nonnegative();
export const CardSchema = z.int().min(0).max(51);
export const SeatIndexSchema = z.int().min(0).max(8);
export const HandNumberSchema = z.int().nonnegative();
export const ClientSeedSchema = z.string().regex(/^[0-9a-f]{32}$/, 'clientSeed must be 32 lowercase hex chars');
export const CommitmentSchema = z.string().regex(/^[0-9a-f]{64}$/, 'commitment must be 64 lowercase hex chars');
export const TimestampSchema = z.int().nonnegative();
export const ChatTextSchema = z.string().trim().min(1).max(200);

// ---------------------------------------------------------------------------
// Engine shapes (structurally compatible with @poker/engine types)
// ---------------------------------------------------------------------------

export const ActionKindSchema = z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']);
export const AnteKindSchema = z.enum(['none', 'every', 'bigBlind']);
export const StreetSchema = z.enum(['preflop', 'flop', 'turn', 'river', 'showdown']);

export const StakesSchema = z.object({
  smallBlind: ChipsSchema,
  bigBlind: ChipsSchema,
  ante: ChipsSchema,
  anteKind: AnteKindSchema,
});

export const BlindLevelSchema = z.object({
  level: z.int(),
  smallBlind: ChipsSchema,
  bigBlind: ChipsSchema,
  ante: ChipsSchema,
  anteKind: AnteKindSchema,
  durationMinutes: z.int(),
});

export const LegalActionsSchema = z.object({
  seat: SeatIndexSchema,
  canFold: z.boolean(),
  canCheck: z.boolean(),
  callAmount: ChipsSchema,
  canBet: z.boolean(),
  canRaise: z.boolean(),
  minTo: ChipsSchema,
  maxTo: ChipsSchema,
});

export const PotSchema = z.object({
  amount: ChipsSchema,
  eligible: z.array(SeatIndexSchema),
});

export const SeatInputSchema = z.object({
  seat: SeatIndexSchema,
  playerId: z.string(),
  stack: ChipsSchema,
});

export const HandEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('handStarted'),
    handId: z.string(),
    handNumber: HandNumberSchema,
    buttonSeat: SeatIndexSchema,
    stakes: StakesSchema,
    seats: z.array(SeatInputSchema),
    commitment: z.string(),
    cardCommitments: z.array(z.string()),
  }),
  z.object({ type: z.literal('postAnte'), seat: SeatIndexSchema, amount: ChipsSchema }),
  z.object({
    type: z.literal('postBlind'),
    seat: SeatIndexSchema,
    blind: z.enum(['small', 'big']),
    amount: ChipsSchema,
  }),
  z.object({ type: z.literal('dealHole'), seat: SeatIndexSchema, cards: z.array(CardSchema) }),
  z.object({
    type: z.literal('toAct'),
    seat: SeatIndexSchema,
    legal: LegalActionsSchema,
    deadline: z.number().optional(),
  }),
  z.object({
    type: z.literal('action'),
    seat: SeatIndexSchema,
    kind: ActionKindSchema,
    amount: ChipsSchema,
    stackAfter: ChipsSchema,
    auto: z.literal('timeout').optional(),
  }),
  z.object({ type: z.literal('street'), street: StreetSchema, cards: z.array(CardSchema) }),
  z.object({ type: z.literal('uncalledReturned'), seat: SeatIndexSchema, amount: ChipsSchema }),
  z.object({ type: z.literal('potsFormed'), pots: z.array(PotSchema) }),
  z.object({
    type: z.literal('showCards'),
    seat: SeatIndexSchema,
    cards: z.array(CardSchema),
    handName: z.string(),
  }),
  z.object({ type: z.literal('muck'), seat: SeatIndexSchema }),
  z.object({
    type: z.literal('equity'),
    street: StreetSchema,
    equities: z.array(z.object({ seat: SeatIndexSchema, win: z.number(), tie: z.number() })),
  }),
  z.object({
    type: z.literal('potAwarded'),
    potIndex: z.int().nonnegative(),
    seats: z.array(SeatIndexSchema),
    amounts: z.array(ChipsSchema),
    handName: z.string().optional(),
  }),
  z.object({
    type: z.literal('cardProof'),
    position: z.int().nonnegative(),
    card: CardSchema,
    salt: z.string(),
  }),
  z.object({
    type: z.literal('handEnded'),
    stacks: z.array(z.object({ seat: SeatIndexSchema, stack: ChipsSchema })),
    clientSeeds: z.array(z.string()),
    nextCommitment: z.string(),
  }),
]);

// Compile-time checks that the zod schemas match the engine types exactly.
export type _CheckActionKind = Expect<Equal<z.infer<typeof ActionKindSchema>, ActionKind>>;
export type _CheckAnteKind = Expect<Equal<z.infer<typeof AnteKindSchema>, AnteKind>>;
export type _CheckStreet = Expect<Equal<z.infer<typeof StreetSchema>, Street>>;
export type _CheckStakes = Expect<Equal<z.infer<typeof StakesSchema>, Stakes>>;
export type _CheckBlindLevel = Expect<Equal<z.infer<typeof BlindLevelSchema>, BlindLevel>>;
export type _CheckLegalActions = Expect<Equal<z.infer<typeof LegalActionsSchema>, LegalActions>>;
export type _CheckPot = Expect<Equal<z.infer<typeof PotSchema>, Pot>>;
export type _CheckSeatInput = Expect<Equal<z.infer<typeof SeatInputSchema>, SeatInput>>;
export type _CheckHandEvent = Expect<Equal<z.infer<typeof HandEventSchema>, HandEvent>>;

// ---------------------------------------------------------------------------
// Game settings
// ---------------------------------------------------------------------------

const IS_TEST_ENV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
/** Minimum allowed turnSeconds; 1 under NODE_ENV=test (resolved at module load), else 5. */
export const MIN_TURN_SECONDS: number = IS_TEST_ENV ? 1 : 5;

export const GameKindSchema = z.enum(['cash', 'tournament']);
export const RebuysSchema = z.strictObject({
  allowed: z.boolean(),
  untilLevel: z.int().nonnegative(),
});

/** Field schemas without defaults; used for both the full and the partial schema. */
const gameSettingsShape = {
  kind: GameKindSchema,
  maxSeats: z.int().min(2).max(9),
  levels: z.array(BlindLevelSchema).min(1),
  minBuyIn: ChipsSchema,
  maxBuyIn: ChipsSchema,
  startingStack: ChipsSchema,
  turnSeconds: z.int().min(MIN_TURN_SECONDS).max(120),
  timeBankSeconds: z.int().min(0).max(600),
  timeBankTopUpSeconds: z.int().min(0).max(120),
  rebuys: RebuysSchema,
  payouts: z.array(z.int().positive()).min(1),
  seatApproval: z.boolean(),
  autoStart: z.boolean(),
  showAllInEquity: z.literal(true),
};

export const GameSettingsBaseSchema = z.strictObject({
  ...gameSettingsShape,
  turnSeconds: gameSettingsShape.turnSeconds.default(20),
  timeBankSeconds: gameSettingsShape.timeBankSeconds.default(60),
  timeBankTopUpSeconds: gameSettingsShape.timeBankTopUpSeconds.default(10),
  autoStart: gameSettingsShape.autoStart.default(true),
});

/**
 * Partial settings for host `updateSettings`. Built from the default-less shape so that
 * omitted fields stay omitted (no defaults filled in), and without the cross-field rules.
 */
export const PartialGameSettingsSchema = z.strictObject(gameSettingsShape).partial();
export type PartialGameSettings = z.infer<typeof PartialGameSettingsSchema>;

/** Returns human-readable problems with a blind schedule; empty when valid. */
function levelProblems(levels: readonly BlindLevel[]): string[] {
  // keep in sync with engine/blinds.validateLevels
  const problems: string[] = [];
  if (levels.length === 0) problems.push('at least one level is required');
  let prevBb = 0;
  levels.forEach((l, i) => {
    if (l.level !== i + 1) problems.push(`level ${i + 1}: level number must be ${i + 1}`);
    if (l.smallBlind < 1) problems.push(`level ${i + 1}: smallBlind must be >= 1`);
    if (l.bigBlind <= l.smallBlind) problems.push(`level ${i + 1}: bigBlind must be > smallBlind`);
    if (i > 0 && l.bigBlind < prevBb) problems.push(`level ${i + 1}: bigBlind must not decrease`);
    if (l.ante < 0) problems.push(`level ${i + 1}: ante must be >= 0`);
    if (l.durationMinutes < 1) problems.push(`level ${i + 1}: durationMinutes must be >= 1`);
    prevBb = l.bigBlind;
  });
  return problems;
}

export const GameSettingsSchema = GameSettingsBaseSchema.superRefine((s, ctx) => {
  const sum = s.payouts.reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    ctx.addIssue({ code: 'custom', path: ['payouts'], message: `payouts must sum to 100 (got ${sum})` });
  }
  if (s.kind === 'cash' && s.levels.length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['levels'], message: 'cash games must have exactly 1 level' });
  }
  if (s.minBuyIn > s.maxBuyIn) {
    ctx.addIssue({ code: 'custom', path: ['minBuyIn'], message: 'minBuyIn must be <= maxBuyIn' });
  }
  for (const message of levelProblems(s.levels)) {
    ctx.addIssue({ code: 'custom', path: ['levels'], message });
  }
});
export type GameSettings = z.infer<typeof GameSettingsSchema>;
/** Input shape (fields with defaults are optional). */
export type GameSettingsInput = z.input<typeof GameSettingsSchema>;

// ---------------------------------------------------------------------------
// Shared view types
// ---------------------------------------------------------------------------

export const TableStatusSchema = z.enum(['waiting', 'running', 'paused', 'finished']);
export type TableStatus = z.infer<typeof TableStatusSchema>;

export const SeatViewSchema = z.object({
  seat: SeatIndexSchema,
  playerId: UuidSchema,
  name: z.string(),
  avatarUrl: z.string().nullable(),
  stack: ChipsSchema,
  bet: ChipsSchema,
  folded: z.boolean(),
  allIn: z.boolean(),
  sittingOut: z.boolean(),
  connected: z.boolean(),
  cardsVisible: z.array(CardSchema).nullable(),
  hasCards: z.boolean(),
});
export type SeatView = z.infer<typeof SeatViewSchema>;

export const ChatMessageSchema = z.object({
  gameId: UuidSchema,
  id: z.string().min(1),
  playerId: UuidSchema,
  name: z.string(),
  text: ChatTextSchema,
  at: TimestampSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SeatRequestSchema = z.object({ playerId: UuidSchema, name: z.string() });
export type SeatRequest = z.infer<typeof SeatRequestSchema>;

export const TableViewSchema = z.object({
  gameId: UuidSchema,
  settings: GameSettingsSchema,
  status: TableStatusSchema,
  seats: z.array(SeatViewSchema),
  board: z.array(CardSchema),
  pots: z.array(PotSchema),
  handId: UuidSchema.nullable(),
  handNumber: HandNumberSchema,
  buttonSeat: SeatIndexSchema.nullable(),
  toAct: SeatIndexSchema.nullable(),
  legal: LegalActionsSchema.nullable(),
  deadline: TimestampSchema.nullable(),
  mySeat: SeatIndexSchema.nullable(),
  myHole: z.array(CardSchema),
  commitment: CommitmentSchema.nullable(),
  chat: z.array(ChatMessageSchema),
  seatRequests: z.array(SeatRequestSchema),
});
export type TableView = z.infer<typeof TableViewSchema>;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const TableJoinSchema = z.strictObject({ gameId: UuidSchema });
export type TableJoin = z.infer<typeof TableJoinSchema>;

export const TableJoinAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), view: TableViewSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type TableJoinAck = z.infer<typeof TableJoinAckSchema>;

export const TableSitSchema = z.strictObject({
  gameId: UuidSchema,
  seat: SeatIndexSchema,
  buyIn: ChipsSchema,
  clientSeed: ClientSeedSchema,
});
export type TableSit = z.infer<typeof TableSitSchema>;

export const TableLeaveSchema = z.strictObject({ gameId: UuidSchema });
export type TableLeave = z.infer<typeof TableLeaveSchema>;

export const TableActionSchema = z.strictObject({
  gameId: UuidSchema,
  handId: UuidSchema,
  kind: ActionKindSchema,
  amount: ChipsSchema.optional(),
});
export type TableAction = z.infer<typeof TableActionSchema>;

export const TableClientSeedSchema = z.strictObject({
  gameId: UuidSchema,
  handNumber: HandNumberSchema,
  clientSeed: ClientSeedSchema,
});
export type TableClientSeed = z.infer<typeof TableClientSeedSchema>;

export const TableUseTimeBankSchema = z.strictObject({ gameId: UuidSchema });
export type TableUseTimeBank = z.infer<typeof TableUseTimeBankSchema>;

export const TableRebuySchema = z.strictObject({ gameId: UuidSchema });
export type TableRebuy = z.infer<typeof TableRebuySchema>;

export const ChatSendSchema = z.strictObject({ gameId: UuidSchema, text: ChatTextSchema });
export type ChatSend = z.infer<typeof ChatSendSchema>;

export const HostCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start') }),
  z.strictObject({ kind: z.literal('pause') }),
  z.strictObject({ kind: z.literal('resume') }),
  z.strictObject({ kind: z.literal('end') }),
  z.strictObject({ kind: z.literal('kick'), playerId: UuidSchema }),
  z.strictObject({ kind: z.literal('approveSeat'), playerId: UuidSchema, approve: z.boolean() }),
  z.strictObject({ kind: z.literal('updateSettings'), settings: PartialGameSettingsSchema }),
]);
export type HostCommand = z.infer<typeof HostCommandSchema>;

export const HostCommandMessageSchema = z.strictObject({ gameId: UuidSchema, command: HostCommandSchema });
export type HostCommandMessage = z.infer<typeof HostCommandMessageSchema>;

/** Payload schema for every client -> server event, for generic validation on the server. */
export const ClientEventSchemas = {
  'table:join': TableJoinSchema,
  'table:sit': TableSitSchema,
  'table:leave': TableLeaveSchema,
  'table:action': TableActionSchema,
  'table:clientSeed': TableClientSeedSchema,
  'table:useTimeBank': TableUseTimeBankSchema,
  'table:rebuy': TableRebuySchema,
  'chat:send': ChatSendSchema,
  'host:command': HostCommandMessageSchema,
} as const;
export type ClientEventName = keyof typeof ClientEventSchemas;
export type ClientEventPayload<E extends ClientEventName> = z.infer<(typeof ClientEventSchemas)[E]>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const HandEventMessageSchema = z.object({ gameId: UuidSchema, event: HandEventSchema });
export type HandEventMessage = z.infer<typeof HandEventMessageSchema>;

export const HandCommitmentSchema = z.object({
  gameId: UuidSchema,
  handNumber: HandNumberSchema,
  commitment: CommitmentSchema,
});
export type HandCommitment = z.infer<typeof HandCommitmentSchema>;

export const TableSeatsSchema = z.object({ gameId: UuidSchema, seats: z.array(SeatViewSchema) });
export type TableSeats = z.infer<typeof TableSeatsSchema>;

export const TableClockSchema = z.object({
  gameId: UuidSchema,
  seat: SeatIndexSchema,
  deadline: TimestampSchema,
  timeBankMs: z.int().nonnegative(),
  usingTimeBank: z.boolean(),
});
export type TableClock = z.infer<typeof TableClockSchema>;

export const TableStatusMessageSchema = z.object({
  gameId: UuidSchema,
  status: TableStatusSchema,
  level: BlindLevelSchema.optional(),
  nextLevelAt: TimestampSchema.optional(),
});
export type TableStatusMessage = z.infer<typeof TableStatusMessageSchema>;

export const ResultEntrySchema = z.object({
  userId: UuidSchema,
  name: z.string(),
  place: z.int().positive(),
  prize: ChipsSchema,
});
export type ResultEntry = z.infer<typeof ResultEntrySchema>;

export const TableResultsSchema = z.object({ gameId: UuidSchema, results: z.array(ResultEntrySchema) });
export type TableResults = z.infer<typeof TableResultsSchema>;

export const NotifyKindSchema = z.enum(['invite', 'gameStarting', 'friendRequest', 'seatRequest', 'integrityFlag']);
export const NotifySchema = z.object({
  id: z.string().min(1),
  kind: NotifyKindSchema,
  text: z.string(),
  link: z.string().optional(),
});
export type Notify = z.infer<typeof NotifySchema>;

export const ErrorMessageSchema = z.object({ code: z.string(), message: z.string() });
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

/** Payload schema for every server -> client event (handy for tests and client-side checks). */
export const ServerEventSchemas = {
  'table:view': TableViewSchema,
  'hand:event': HandEventMessageSchema,
  'hand:commitment': HandCommitmentSchema,
  'table:seats': TableSeatsSchema,
  'table:clock': TableClockSchema,
  'table:status': TableStatusMessageSchema,
  'table:results': TableResultsSchema,
  'chat:message': ChatMessageSchema,
  notify: NotifySchema,
  error: ErrorMessageSchema,
} as const;
export type ServerEventName = keyof typeof ServerEventSchemas;

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

export interface ClientEvents {
  'table:join': (payload: TableJoin, ack: (res: TableJoinAck) => void) => void;
  'table:sit': (payload: TableSit) => void;
  'table:leave': (payload: TableLeave) => void;
  'table:action': (payload: TableAction) => void;
  'table:clientSeed': (payload: TableClientSeed) => void;
  'table:useTimeBank': (payload: TableUseTimeBank) => void;
  'table:rebuy': (payload: TableRebuy) => void;
  'chat:send': (payload: ChatSend) => void;
  'host:command': (payload: HostCommandMessage) => void;
}

export interface ServerEvents {
  'table:view': (payload: TableView) => void;
  'hand:event': (payload: HandEventMessage) => void;
  'hand:commitment': (payload: HandCommitment) => void;
  'table:seats': (payload: TableSeats) => void;
  'table:clock': (payload: TableClock) => void;
  'table:status': (payload: TableStatusMessage) => void;
  'table:results': (payload: TableResults) => void;
  'chat:message': (payload: ChatMessage) => void;
  notify: (payload: Notify) => void;
  error: (payload: ErrorMessage) => void;
}

// Every client event has a schema and vice versa.
export type _CheckClientEventKeys = Expect<Equal<keyof ClientEvents, ClientEventName>>;
export type _CheckServerEventKeys = Expect<Equal<keyof ServerEvents, ServerEventName>>;
