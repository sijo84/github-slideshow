// Card: integer 0..51. rank = card >> 2 (0 = deuce ... 12 = ace). suit = card & 3 (0 c, 1 d, 2 h, 3 s).
export type Card = number;
export type Chips = number;          // always a non-negative integer
export type SeatIndex = number;      // 0 .. maxSeats-1
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type AnteKind = 'none' | 'every' | 'bigBlind';

export interface Stakes { smallBlind: Chips; bigBlind: Chips; ante: Chips; anteKind: AnteKind }
export interface BlindLevel extends Stakes { level: number; durationMinutes: number }

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';
/** amount = the player's TOTAL contribution on this street after the action ("raise to"). Ignored for fold/check. */
export interface PlayerAction { seat: SeatIndex; kind: ActionKind; amount?: Chips }

export interface LegalActions {
  seat: SeatIndex;
  canFold: boolean; canCheck: boolean;
  callAmount: Chips;            // extra chips needed to call (0 if canCheck)
  canBet: boolean; canRaise: boolean;
  minTo: Chips; maxTo: Chips;   // bounds for bet/raise "to" amounts; maxTo = all-in
}

export interface Pot { amount: Chips; eligible: SeatIndex[] }

export interface SeatInput { seat: SeatIndex; playerId: string; stack: Chips }

export interface HandConfig {
  handId: string;
  handNumber: number;
  maxSeats: number;             // 2..9
  buttonSeat: SeatIndex;        // already moved for this hand by the caller (see blinds.nextButton)
  stakes: Stakes;
  seats: SeatInput[];           // only players dealt in, stack > 0
  deck: Card[];                 // 52 distinct cards, already shuffled
}

export type HandEvent =
  | { type: 'handStarted'; handId: string; handNumber: number; buttonSeat: SeatIndex; stakes: Stakes; seats: SeatInput[]; commitment: string; cardCommitments: string[] }
  | { type: 'postAnte'; seat: SeatIndex; amount: Chips }
  | { type: 'postBlind'; seat: SeatIndex; blind: 'small' | 'big'; amount: Chips }
  | { type: 'dealHole'; seat: SeatIndex; cards: Card[] }          // cards = [] in any view not entitled to them
  | { type: 'toAct'; seat: SeatIndex; legal: LegalActions; deadline?: number }
  | { type: 'action'; seat: SeatIndex; kind: ActionKind; amount: Chips; stackAfter: Chips; auto?: 'timeout' }
  | { type: 'street'; street: Street; cards: Card[] }               // the cards newly dealt to the board
  | { type: 'uncalledReturned'; seat: SeatIndex; amount: Chips }
  | { type: 'potsFormed'; pots: Pot[] }
  | { type: 'showCards'; seat: SeatIndex; cards: Card[]; handName: string }
  | { type: 'muck'; seat: SeatIndex }
  | { type: 'equity'; street: Street; equities: { seat: SeatIndex; win: number; tie: number }[] }
  | { type: 'potAwarded'; potIndex: number; seats: SeatIndex[]; amounts: Chips[]; handName?: string }
  | { type: 'cardProof'; position: number; card: Card; salt: string }   // sent only to viewers entitled to that card (see F1)
  | { type: 'handEnded'; stacks: { seat: SeatIndex; stack: Chips }[]; clientSeeds: string[]; nextCommitment: string };

/** Full record, server-side only. Views given to clients are made by redact() in the server. */
export interface HandRecord {
  handId: string; gameId: string; handNumber: number; startedAt: string; endedAt: string;
  events: HandEvent[];
  hole: Record<SeatIndex, Card[]>;   // all hole cards, including folded hands
  playerIds: Record<SeatIndex, string>;
  board: Card[];
}
