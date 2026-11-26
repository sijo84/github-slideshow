/**
 * Table contracts (W0, final; PLAN I-11 item 2). Shared by every checkpoint-8 table task.
 * `TableState = TableData & TableActions`; `initialTableState()` returns the data part at its empty values.
 */
import type { BlindLevel, Card, Chips, HandEvent, LegalActions, Pot, SeatIndex } from '@poker/engine';
import type {
  ChatMessage,
  GameSettings,
  HandCommitment,
  ResultEntry,
  SeatRequest,
  SeatView,
  TableClock,
  TableStatus,
  TableStatusMessage,
  TableView,
} from '@poker/protocol';

export type CardPlace =
  | { at: 'deck' }
  | { at: 'seat'; seat: SeatIndex; index: 0 | 1 }
  | { at: 'board'; index: number }
  | { at: 'muck' };

/** id: `card:<handId>:<seat>:<0|1>` for hole cards, `card:<handId>:board:<0..4>` for board cards. */
export interface CardEntity {
  id: string;
  place: CardPlace;
  spawnFrom?: CardPlace;
  card: Card | null /* null = hidden from this viewer */;
  faceUp: boolean;
  order: number /* stagger index inside its step */;
  fading: boolean;
}

export type ChipPlace = { at: 'seat'; seat: SeatIndex } | { at: 'bet'; seat: SeatIndex } | { at: 'pot'; index: number };

/** ids: `chips:bet:<seat>` (a seat's bet this street), `chips:inc:<stepId>` (chips on their way to join a bet),
 *  `chips:pot:<index>`, `chips:award:<stepId>:<seat>` (a pot share on its way to a winner), `chips:return:<stepId>`. */
export interface ChipEntity {
  id: string;
  amount: Chips;
  place: ChipPlace;
  spawnFrom?: ChipPlace;
  order: number;
}

export type StepKind =
  | 'newHand'
  | 'bet'
  | 'deal'
  | 'turn'
  | 'action'
  | 'fold'
  | 'collect'
  | 'return'
  | 'pots'
  | 'board'
  | 'flip'
  | 'muck'
  | 'equity'
  | 'award'
  | 'handEnd';

/** One queued unit of play. `events` are the hand events it covers (a step may batch several, e.g. all blinds, or every dealHole). */
export interface AnimStep {
  id: number;
  kind: StepKind;
  events: HandEvent[];
  seat?: SeatIndex;
  cards?: Card[];
  amount?: Chips;
  potIndex?: number;
  durationMs: number;
}

export interface Equity {
  win: number;
  tie: number;
}

export interface LogLine {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

/** Every non-action field of the table state. */
export interface TableData {
  gameId: string | null;
  settings: GameSettings | null;
  status: TableStatus;
  level: BlindLevel | null;
  nextLevelAt: number | null;
  handId: string | null;
  handNumber: number;
  buttonSeat: SeatIndex | null;
  seats: SeatView[]; // as DISPLAYED: stack/bet/folded/allIn/hasCards change on consume
  board: Card[];
  pots: Pot[]; // as displayed
  toAct: SeatIndex | null;
  legal: LegalActions | null;
  deadline: number | null;
  timeBank: { seat: SeatIndex; ms: number; using: boolean } | null;
  mySeat: SeatIndex | null;
  /** The signed-in user's id (set by connectTable); `applySeats` derives `mySeat` from it. */
  myPlayerId: string | null;
  myHole: Card[];
  myEquity: Equity | null;
  allInEquity: Record<number, Equity> | null;
  chat: ChatMessage[];
  chatError: string | null;
  seatRequests: SeatRequest[];
  results: ResultEntry[] | null;
  commitment: string | null;
  handLog: LogLine[];
  verified: 'pending' | 'ok' | 'failed' | null;
  lastError: string | null;
  cards: CardEntity[];
  chips: ChipEntity[];
  queue: AnimStep[];
  playing: AnimStep | null;
  animate: boolean; // animate false: steps are applied at once (replayer rebuild, tests)
}

export interface TableActions {
  applyView(view: TableView): void; // full snapshot: replaces everything, clears the queue, entities appear in place
  applyEvent(event: HandEvent): void; // enqueues steps (cardProof is checked at once, never queued)
  applySeats(seats: SeatView[]): void;
  applyClock(c: TableClock): void;
  applyStatus(s: TableStatusMessage): void;
  applyCommitment(c: HandCommitment): void;
  applyResults(r: ResultEntry[]): void;
  addChat(m: ChatMessage): void;
  setChatError(e: string | null): void;
  setError(e: string | null): void;
  setMyEquity(e: Equity | null): void;
  begin(id: number): void;
  consume(id: number): void;
  flush(): void;
  reset(): void;
}

export type TableState = TableData & TableActions;

/** A fresh data part: every field at its empty value (fresh arrays on every call). */
export function initialTableState(): TableData {
  return {
    gameId: null,
    settings: null,
    status: 'waiting',
    level: null,
    nextLevelAt: null,
    handId: null,
    handNumber: 0,
    buttonSeat: null,
    seats: [],
    board: [],
    pots: [],
    toAct: null,
    legal: null,
    deadline: null,
    timeBank: null,
    mySeat: null,
    myPlayerId: null,
    myHole: [],
    myEquity: null,
    allInEquity: null,
    chat: [],
    chatError: null,
    seatRequests: [],
    results: null,
    commitment: null,
    handLog: [],
    verified: null,
    lastError: null,
    cards: [],
    chips: [],
    queue: [],
    playing: null,
    animate: true,
  };
}

/** Base step durations (ms). `deal` and `board` get +DEAL_STAGGER_MS per extra card, added by the store. */
export const STEP_MS: Record<StepKind, number> = {
  newHand: 350,
  bet: 300,
  deal: 380,
  turn: 0,
  action: 0,
  fold: 300,
  collect: 450,
  return: 300,
  pots: 0,
  board: 380,
  flip: 300,
  muck: 300,
  equity: 0,
  award: 600,
  handEnd: 0,
};

export const DEAL_STAGGER_MS = 90;
