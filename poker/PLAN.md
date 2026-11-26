# Plan: Private Texas Hold'em for friends

Repo: `sijo84/github-slideshow`, branch `ccr-f5339883-mfcgzv`. All app code lives under `poker/`. The existing Jekyll slideshow at the repo root must keep working and must not be changed except for one line in `_config.yml` (task S0.2).

This file is the single source of truth for the build. The session that runs it follows "How to run it" exactly and records results under "Progress".

---

## Goal and done

### User story

As someone who plays poker with friends, I want a private web app where I can schedule cash games and tournaments, invite my friends, and play No-Limit Texas Hold'em at a smooth, good-looking semi-3D table with a fair automated dealer, so that our home game runs itself, we can review hands afterwards, and at the end we know exactly who owes whom for our friendly side bets, without the app ever touching real money.

### Decisions already made (with the user, 2026-11-24)

- Location: new folder `poker/` in this repo. The slideshow stays untouched.
- Stack: TypeScript web app. React 19 + `@react-three/fiber` (semi-3D table), a hand-written easing/tween module (no CSS jumps), Node 22 + Fastify 5 + Socket.IO 4, PostgreSQL 16, Vitest + Playwright.
- Win probability: each player sees **their own** equity against random opponent hands live during the hand (computed in their browser from cards they already know). **Everyone's** exact equity is shown to everyone only once all remaining players are all-in with cards face up, and in the replayer.
- Scope: the full app, built in staged checkpoints.
- "Certified RNG" means a cryptographically secure shuffle with a verifiable commit-reveal log. A paid lab certification (e.g. GLI/iTech) is out of scope.
- The settlement calculator only works out who pays whom. The app never takes, holds or sends real money, and the in-game currency can never be bought or cashed out.
- (2026-11-24, after review) Chips are shown as play-money dollars: 1 chip = $1, written `$1,250`. Settlement lists who owes whom **in these play dollars** ("Ben owes Ana $1,250"), with no real-money conversion in the app. Players settle real money among themselves outside the app. Every money-looking figure carries the label "play money" somewhere visible on the page.
- (2026-11-24, after review) Shuffle seeds are revealed **when the game ends**, not after each hand, so folded cards cannot be rebuilt during play. During play, every card a player receives is checked against a per-card commitment published at the start of the hand. See Review findings F1.

### Assumptions made by the planner (the user may veto before the build)

- Game type: No-Limit Hold'em only, 2 to 9 seats, one table per game. Multi-table tournaments are out of scope.
- Accounts: email + password (argon2id). No email sending: invites and reminders are in-app notifications only.
- Avatars: uploaded PNG/JPEG/WebP up to 1 MB stored on the server's disk. Without an upload, a generated initials avatar is shown.
- Collusion detection flags suspicious patterns to the host. It never bans anyone automatically, because friends often share Wi-Fi.
- Desktop browsers first. The table must still be usable at 390 px wide (phone), but no native app.
- Single server process. No horizontal scaling (fine for groups of friends).

### Acceptance criteria

Each one has a test in "Proof".

- **AC1 Private games.** Only the host and invited users can see or join a game. A non-invited user's REST and socket join requests are rejected.
- **AC2 Scheduling.** A host can schedule a cash game or tournament for a future time, invite friends, and friends can RSVP. At the start time the table opens and RSVP'd players get an in-app notification. An `.ics` file can be downloaded.
- **AC3 Table view.** A semi-3D table (perspective camera, oval felt) shows, at each occupied seat: profile picture, name, chip stack, current bet, and hole cards (face up for the viewer's own seat, face down for others until shown). The board and pot(s) are shown in the middle.
- **AC4 Smooth motion.** Card dealing, chip bets, pot collection, pot awards, card flips, seat changes and panel transitions all move through eased tweens. No element jumps more than 2× the average per-frame step of its tween, and no table object changes position without a tween.
- **AC5 Turn indicator.** Exactly one seat is highlighted as the active player while a decision is pending, with a countdown ring for the turn timer and a separate indication when the time bank is being used.
- **AC6 Correct dealer.** The engine implements NLHE rules: button movement, small/big blind (heads-up: button posts small blind and acts first preflop), antes (none / every player / big-blind ante), min-bet and min-raise rules, short all-ins that do not reopen betting, uncalled bets returned, side pots, showdown order, split pots with odd chips going to the first eligible seat left of the button. Chips are always conserved.
- **AC7 Fair shuffle.** Each hand's deck comes from a CSPRNG server seed combined with players' client seeds. The SHA-256 commitment of the server seed is published before client seeds are collected. At hand start the server also publishes 52 per-card commitments; every card a player receives (hole and board) comes with its salt, and the browser checks it. All hand seeds are revealed when the game ends, and any player can then verify every deck in the browser.
- **AC8 Anti-cheating.** The server is the only authority: clients never receive the deck or other players' hidden cards. Every action is validated against `legalActions`. Actions and chat are rate-limited. One account can hold only one seat per table. Several accounts sharing an IP address or device id in one game are flagged.
- **AC9 Collusion detection.** After each hand (and on demand), the analyser flags chip dumping, soft play, and shared IP/device for the host's integrity panel, with the evidence hands listed.
- **AC10 Timers.** When the turn timer runs out, the player's time bank is used automatically. When both are gone, the server checks if possible, otherwise folds. The time bank tops up as the host configured.
- **AC11 Friends.** Users can send, accept, decline and remove friend requests, invite friends to games, and see each friend's stats (hands, VPIP, PFR, aggression factor, net chips, tournaments won).
- **AC12 Chat.** Real-time table chat, 200 characters per message, 5 messages per 10 s per user, stored with the game, shown as text only.
- **AC13 Notes.** A user can write a private note and colour tag on any other player. Only its author can read it. It shows from the seat's popover.
- **AC14 Hand history and replayer.** Every hand is stored as an event log. Users can list hands of games they played and replay any of them step by step (play/pause/step/speed) on the same 3D table. They see only cards they were entitled to see at the time, plus cards shown at showdown.
- **AC15 Host controls.** Before and during a game the host can set the blind level schedule, min/max buy-in, ante type and size, turn timer, time bank, rebuys, starting stack and payouts. The host can also pause/resume, approve seats and remove a player. Changes made during play take effect from the next hand.
- **AC16 Virtual currency.** Every user has a chip wallet backed by a double-entry ledger. Chips come from a signup grant and host grants only, and there is no purchase path. Buy-ins and cash-outs move chips between wallet and table. Balances never go negative and the ledger always sums to zero.
- **AC17 Settlement.** For a game, the calculator takes each player's net chip result (cash: sum of hand nets; tournament: prize − buy-in − rebuys) and outputs at most n−1 transfers in play dollars ("Ben owes Ana $1,250") that sum exactly to zero, plus a copyable text summary and the notice "Play money only. Settle any real-money arrangements among yourselves, outside this app."
- **AC18 Tournaments.** Blind levels rise on the host's schedule, eliminated players get finishing places (ties by starting stack size of the hand, then split), and the prize pool of virtual chips is paid out by the payout table.

### Done means

All checkpoints committed, every command in "Proof → whole-build checks" passes, every mutation check in "Proof" was seen to fail and then restored, and the manual walkthrough at the end of "Proof" was done in a real browser and recorded under Progress.

### Out of scope

Real-money payments, purchases of in-game currency, multi-table tournaments, native mobile apps, email/SMS sending, horizontal scaling, formal RNG lab certification.

---

## Read first

The builder must read these before starting. The repo has no app code yet, so most of the "code to copy" is the interfaces and snippets written in this plan.

### Repo files (they constrain where and how we build)

| File | Lines | Why |
|---|---|---|
| `_config.yml` | 104–116 | Jekyll's `exclude:` list. Jekyll copies every folder not starting with `_` into the site, so `poker/` (and its `node_modules`) must be added here or the slideshow build breaks or bloats. This is the only root file we change. |
| `.editorconfig` | 1–20 | Root config says `root = false` and tabs for `[*]`, spaces only for json/js/css/yml/html. `.ts`/`.tsx` would fall under tabs, so `poker/.editorconfig` (task S0.1) sets `root = true` and 2-space indentation for everything under `poker/`. |
| `.gitignore` | 1–4 | Only ignores Jekyll output. `poker/.gitignore` must ignore `node_modules`, `dist`, `data/`, `test-results/`, `playwright-report/`. |
| `circle.yml`, `script/cibuild` | all | Old CircleCI 1.0 config for the Jekyll site. Do not touch. The poker app has its own commands (see "How to run it"). |
| `.gitmodules` | all | `reveal.js` is a submodule. Never run `git submodule` commands or edit `reveal.js/`. |

### Environment facts (checked 2026-11-24 in this container)

- Node v22.23.5, npm 10.9.9. 4 CPUs, 15 GB RAM.
- PostgreSQL 16 is installed but stopped. Start it with `pg_ctlcluster 16 main start`. Admin: `su postgres -c "psql ..."`.
- Chromium and Playwright **1.63.0** are preinstalled. Pin `@playwright/test` to exactly `1.63.0`. **Never** run `playwright install`.
- Docker exists but is not needed.
- npm registry is reachable. Versions to pin (from `npm view`): react/react-dom 19.3.1, @react-three/fiber 9.8.2 (peer: react <19.4), @react-three/drei 10.7.9, three 0.187.0, @types/three 0.187.0, zustand 5.1.0, react-router 8.5.2, vite 8.3.8, @vitejs/plugin-react 6.3.0, vitest 5.1.1, fast-check 4.11.0, typescript **6.0.3** (not 7.x, because typescript-eslint 8.74.0 needs `<6.1.0`), eslint 10.15.0, typescript-eslint 8.74.0, fastify 5.12.8, @fastify/cookie 11.1.5, @fastify/multipart 10.1.9, @fastify/static 10.1.12, @fastify/rate-limit 11.3.0, socket.io / socket.io-client 4.8.4, pg 8.23.1, @types/pg 8.23.1, argon2 0.45.2, zod 4.6.7, @noble/hashes 2.4.0, luxon 3.7.2, ics 3.12.1, tsx 4.23.15, @types/node 22 (match the runtime, not 26).

### Docs (read the named section before the task that uses it)

| Doc | Section | Why / task |
|---|---|---|
| Robert's Rules of Poker v13 (https://www.briggsoft.com/docs/pmavens/Robert%27s_Rules_of_Poker.pdf) | Section 3 "Button and Blind Use", Section 6 "No-Limit and Pot-Limit" (rules 4–6 on raises and short all-ins), Section 2 "Showdown" | Rules E5, E7 must follow: heads-up blinds, min-raise, incomplete raise not reopening action, showdown order. |
| TDA Rules 2024 (https://www.pokertda.com/view-poker-tda-rules/) | Rule 20 "Odd chips", Rule 43 "Raise amounts", Rule 4 "Big blind ante" | Odd-chip placement (E4/E7) and BB-ante posting order (E5). |
| Fisher–Yates shuffle (https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle) | "Modulo bias" under "Potential sources of bias" | E2 must use rejection sampling, not `% n`. |
| @noble/hashes README (https://github.com/paulmillr/noble-hashes#readme) | `sha256`, `hmac` usage | E2 runs in both Node and the browser. |
| Socket.IO v4 docs (https://socket.io/docs/v4/) | "Rooms", "Middlewares" (`io.use`), "Emitting to a specific socket" | S12: per-socket emits so hole cards only reach their owner. |
| Fastify v5 docs (https://fastify.dev/docs/latest/) | "Plugins", "Hooks → preHandler", "Testing → inject" | S2–S7 route plugins and their tests. |
| @fastify/multipart README | "Handling stream" + `limits.fileSize` | S4 avatar upload. |
| react-three-fiber docs (https://r3f.docs.pmnd.rs/) | "Canvas", "Hooks → useFrame", "Performance → on-demand rendering" | W5–W8. |
| drei docs (https://drei.docs.pmnd.rs/) | `Html`, `RoundedBox`, `Text` | Seat HUD overlay (W8), chips/cards (W6/W7). |
| Easing functions (https://easings.net/) | easeInOutCubic, easeOutBack, easeOutQuart formulas | W2. |
| Playwright docs (https://playwright.dev/docs/) | "Browser contexts" (multi-user), "Auto-waiting", `page.evaluate` | W-checkpoint e2e tests. |
| RFC 5545 via `ics` package README | `createEvent` | S14 `.ics` export. |

### Code to copy

There is no existing app code. The interfaces below are binding. Every task codes against them so tasks in one checkpoint can run in parallel. Changing any interface means editing this plan first (see "How to run it").

#### I-1 Engine types: `poker/packages/engine/src/types.ts` (written verbatim by S0.1)

```ts
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
```

Notes: `toAct`, `equity`, `cardProof`, `handStarted.commitment`/`cardCommitments` and the seed fields of `handEnded` are filled in by the server (S8). The engine emits them with `deadline` unset, `commitment: ''`, `cardCommitments: []`, `clientSeeds: []`, `nextCommitment: ''`, and the server overwrites them. The engine never emits `equity` or `cardProof`. `cardCommitments` holds 52 hex strings, see F1.

#### I-2 Engine module signatures (each task implements its own file)

```ts
// cards.ts (E1)
export const RANKS = '23456789TJQKA'; export const SUITS = 'cdhs';
export function rankOf(c: Card): number; export function suitOf(c: Card): number;
export function parseCard(s: string): Card;            // "As" -> 51, throws on bad input
export function formatCard(c: Card): string;           // 51 -> "As"
export function parseCards(s: string): Card[];         // "As Kd" or "AsKd"
export function fullDeck(): Card[];                    // [0..51]

// rng.ts (E2) – isomorphic (Node 22 + browser), uses @noble/hashes and globalThis.crypto.getRandomValues
export function newServerSeed(): string;               // 32 random bytes, lowercase hex
export function newClientSeed(): string;               // 16 random bytes, lowercase hex
export function commit(serverSeed: string): string;    // sha256(utf8(serverSeed)) hex
export function deckFromSeeds(serverSeed: string, clientSeeds: string[], handNumber: number): Card[];
  // stream = HMAC-SHA256(key = serverSeed, msg = `${sorted(clientSeeds).join('|')}:${handNumber}:${counter}`), counter 0,1,2...
  // read 4-byte big-endian uint32s; Fisher–Yates from i = 51 down to 1, j uniform in [0, i] by rejection sampling
export function verifyDeck(commitment: string, serverSeed: string, clientSeeds: string[], handNumber: number, deck: Card[]): boolean;

// evaluator.ts (E3)
export interface HandValue { score: number; category: HandCategory; name: string } // higher score wins; equal score = tie
export type HandCategory = 'highCard'|'pair'|'twoPair'|'trips'|'straight'|'flush'|'fullHouse'|'quads'|'straightFlush';
export function evaluate5(cards: Card[]): HandValue;
export function evaluate7(cards: Card[]): HandValue;    // best 5 of 5..7 cards
export function compare(a: HandValue, b: HandValue): number; // >0 if a wins

// pots.ts (E4)
export function buildPots(contrib: { seat: SeatIndex; total: Chips; folded: boolean }[]): Pot[];
  // folded players' chips stay in pots but they are not eligible; pots with one eligible seat are still returned
export function splitPot(amount: Chips, winners: SeatIndex[], buttonSeat: SeatIndex, maxSeats: number): Chips[];
  // equal shares; odd chips one each to winners in seat order starting left of the button

// blinds.ts (E5)
export function nextButton(prevButton: SeatIndex | null, occupied: SeatIndex[], maxSeats: number): SeatIndex;
export function blindSeats(button: SeatIndex, dealtIn: SeatIndex[], maxSeats: number): { sb: SeatIndex; bb: SeatIndex; firstToActPreflop: SeatIndex; firstToActPostflop: SeatIndex };
export function forcedBets(stakes: Stakes, button: SeatIndex, dealtIn: SeatInput[], maxSeats: number): { antes: { seat: SeatIndex; amount: Chips }[]; blinds: { seat: SeatIndex; blind: 'small'|'big'; amount: Chips }[] };
  // amounts capped at stack; 'bigBlind' ante is posted by the big blind seat, before the blind, and is dead money
export function levelAt(levels: BlindLevel[], startedAtMs: number, nowMs: number, pausedMs: number): { index: number; msLeft: number };
export function validateLevels(levels: BlindLevel[]): string[]; // [] if valid: level numbers 1..n in order, sb >= 1, bb > sb, bb non-decreasing, ante >= 0, durationMinutes >= 1

// settlement.ts (E6)
export interface Transfer { from: string; to: string; chips: number }   // replaces the cents version above
export function settle(net: { playerId: string; chips: number }[]): { transfers: Transfer[] };
  // net chips must sum to 0 (throw otherwise). Greedy: largest debtor pays largest creditor; ties by playerId. Result has <= n-1 transfers.
export function formatPlayMoney(chips: number): string;  // 1250 -> "$1,250", -40 -> "-$40"
export function settlementText(transfers: Transfer[], names: Record<string, string>): string; // lines "Ben owes Ana $1,250" + the play-money notice

// hand.ts (E7)
export interface HandState { /* opaque to callers; JSON-serialisable */ }
export class IllegalActionError extends Error {}
export function startHand(cfg: HandConfig): { state: HandState; events: HandEvent[] };
export function toAct(state: HandState): SeatIndex | null;      // null when no decision is pending
export function legalActions(state: HandState, seat: SeatIndex): LegalActions;
export function applyAction(state: HandState, action: PlayerAction): { state: HandState; events: HandEvent[] };
export function isComplete(state: HandState): boolean;
export function holeCards(state: HandState): Record<SeatIndex, Card[]>;
export function board(state: HandState): Card[];
export function allInRunout(state: HandState): boolean;        // true when every remaining player but at most one is all-in and betting is closed
export function timeoutAction(state: HandState, seat: SeatIndex): PlayerAction; // check if legal, else fold

// equity.ts (E8)
export function equityVsRandom(hole: Card[], board: Card[], opponents: number, iterations: number, rand?: () => number): { win: number; tie: number };
export function equityExact(holes: Card[][], board: Card[]): { win: number; tie: number }[];
  // exhaustive over remaining board cards when board.length >= 3, Monte Carlo with 50_000 samples preflop (seeded for determinism when rand given)

// stats.ts (E11)
export interface PlayerStats { hands: number; vpip: number; pfr: number; af: number; wtsd: number; wonAtShowdown: number; netChips: number }
export function computeStats(records: HandRecord[], playerId: string): PlayerStats;

// collusion.ts (E10)
export type FlagKind = 'chipDumping' | 'softPlay' | 'sharedIp' | 'sharedDevice';
export interface IntegrityFlag { kind: FlagKind; players: [string, string]; score: number; evidenceHandIds: string[]; summary: string }
export function analyse(records: HandRecord[], bigBlind: Chips): IntegrityFlag[];
export function sharedNetwork(sessions: { playerId: string; ip: string; deviceId: string }[]): IntegrityFlag[];
```

**I-2 amendments (lead, checkpoint 2, written before the build):**
- `hand.ts` adds `advance(state): { state; events }`. During an all-in runout it deals the next street, and after the river it finishes the hand. S8 needs it to pace runout streets and emit `equity` between them; without it the engine would deal the whole board in one step. In a runout `toAct` is null and `isComplete` is false until the last `advance`.
- `equity.ts`: `equityExact` takes an optional third parameter `rand`, and the file exports `mulberry32(seed)` for seeded tests and the fixed-seed preflop default.

`packages/engine/src/index.ts` (written by S0.1) re-exports every module above with `export * from './x.js'`. Stub files are created by S0.1 and each throw `new Error('not implemented')`, so imports compile from the start.

#### I-3 Socket protocol: `poker/packages/protocol/src/index.ts` (P1)

zod schemas plus inferred types. The server validates **every** inbound message with them, and the web client uses the types.

Client → server (event name: payload):
- `table:join` `{ gameId: string }` → ack `{ ok: true, view: TableView } | { ok: false, error: string }`
- `table:sit` `{ gameId, seat: number, buyIn: number, clientSeed: string }`
- `table:leave` `{ gameId }`
- `table:action` `{ gameId, handId, kind: ActionKind, amount?: number }`
- `table:clientSeed` `{ gameId, handNumber: number, clientSeed: string }` (sent automatically when `hand:commitment` arrives)
- `table:useTimeBank` `{ gameId }` (optional manual use; timeout uses it automatically)
- `chat:send` `{ gameId, text: string }` (1–200 chars after trim)
- `host:command` `{ gameId, command: HostCommand }`, where `HostCommand` = `{ kind:'pause' } | { kind:'resume' } | { kind:'kick', playerId } | { kind:'approveSeat', playerId, approve: boolean } | { kind:'updateSettings', settings: Partial<GameSettings> }`

Server → client:
- `table:view` `TableView` (full snapshot on join/reconnect)
- `hand:event` `{ gameId, event: HandEvent }` (already redacted for this socket)
- `hand:commitment` `{ gameId, handNumber, commitment }`
- `table:seats` `{ gameId, seats: SeatView[] }`
- `table:clock` `{ gameId, seat, deadline: number, timeBankMs: number, usingTimeBank: boolean }`
- `table:status` `{ gameId, status: 'waiting'|'running'|'paused'|'finished', level?: BlindLevel, nextLevelAt?: number }`
- `chat:message` `{ gameId, id, playerId, name, text, at }`
- `notify` `{ id, kind: 'invite'|'gameStarting'|'friendRequest'|'seatRequest'|'integrityFlag', text, link? }`
- `error` `{ code: string, message: string }`

Shared types: `GameSettings` `{ kind: 'cash'|'tournament'; maxSeats: 2..9; levels: BlindLevel[] (cash: exactly 1); minBuyIn; maxBuyIn; startingStack (tournament); turnSeconds: 5..120 (default 20); timeBankSeconds: 0..600 (default 60); timeBankTopUpSeconds: 0..120 per level/100 hands (default 10); rebuys: { allowed: boolean; untilLevel: number }; payouts: number[] (percent, sums to 100); seatApproval: boolean; showAllInEquity: true }`, plus `SeatView` `{ seat, playerId, name, avatarUrl, stack, bet, folded, allIn, sittingOut, connected, cardsVisible: Card[] | null, hasCards: boolean }` and `TableView` `{ gameId, settings, status, seats: SeatView[], board: Card[], pots: Pot[], handId: string|null, handNumber, buttonSeat, toAct: SeatIndex|null, legal: LegalActions|null, deadline: number|null, mySeat: SeatIndex|null, myHole: Card[], commitment: string|null, chat: ChatMessage[] }`.

#### I-4 Database schema: `poker/apps/server/migrations/001_init.sql` (S1)

```sql
create extension if not exists pgcrypto;
create table users (id uuid primary key default gen_random_uuid(), email text unique not null, password_hash text not null,
  display_name text not null check (length(display_name) between 2 and 24), avatar_path text, created_at timestamptz not null default now());
create table sessions (id text primary key, user_id uuid not null references users on delete cascade, ip text not null,
  device_id text not null, created_at timestamptz not null default now(), expires_at timestamptz not null);
create table friendships (requester uuid not null references users on delete cascade, addressee uuid not null references users on delete cascade,
  status text not null check (status in ('pending','accepted')), created_at timestamptz not null default now(),
  primary key (requester, addressee), check (requester <> addressee));
create table notes (author uuid not null references users on delete cascade, subject uuid not null references users on delete cascade,
  text text not null default '' check (length(text) <= 2000), color text check (color in ('red','orange','yellow','green','blue','purple')),
  updated_at timestamptz not null default now(), primary key (author, subject));
create table games (id uuid primary key default gen_random_uuid(), host uuid not null references users, name text not null,
  settings jsonb not null, starts_at timestamptz not null, status text not null default 'scheduled'
  check (status in ('scheduled','open','running','paused','finished','cancelled')), created_at timestamptz not null default now());
create table game_invites (game_id uuid not null references games on delete cascade, user_id uuid not null references users on delete cascade,
  rsvp text not null default 'pending' check (rsvp in ('pending','yes','no','maybe')), primary key (game_id, user_id));
create table ledger_accounts (id uuid primary key default gen_random_uuid(), kind text not null check (kind in ('wallet','table','bank')),
  user_id uuid references users, game_id uuid references games, unique (kind, user_id, game_id));
create table ledger_entries (id bigserial primary key, tx_id uuid not null, account_id uuid not null references ledger_accounts,
  amount bigint not null check (amount <> 0), reason text not null, created_at timestamptz not null default now());
create index on ledger_entries (account_id);
create table hands (id uuid primary key, game_id uuid not null references games on delete cascade, hand_number int not null,
  record jsonb not null, started_at timestamptz not null, ended_at timestamptz not null, unique (game_id, hand_number));
create table hand_players (hand_id uuid not null references hands on delete cascade, user_id uuid not null references users,
  seat int not null, net bigint not null, primary key (hand_id, user_id));
create table chat_messages (id bigserial primary key, game_id uuid not null references games on delete cascade,
  user_id uuid not null references users, text text not null, created_at timestamptz not null default now());
create table notifications (id bigserial primary key, user_id uuid not null references users on delete cascade, kind text not null,
  text text not null, link text, read boolean not null default false, created_at timestamptz not null default now());
create table integrity_flags (id bigserial primary key, game_id uuid not null references games on delete cascade, kind text not null,
  players uuid[] not null, score real not null, evidence uuid[] not null, summary text not null, created_at timestamptz not null default now(),
  unique (game_id, kind, players));
create table tournament_results (game_id uuid not null references games on delete cascade, user_id uuid not null references users,
  place int not null, prize bigint not null, primary key (game_id, user_id));
create table schema_migrations (name text primary key, applied_at timestamptz not null default now());
```

Ledger rule: every transaction is ≥ 2 rows with the same `tx_id` summing to 0. There is one `bank` account (user_id and game_id null) that is the source of grants. Wallet balance = sum of its entries and must stay ≥ 0, enforced in `ledger.transfer` with `SELECT ... FOR UPDATE` on the account row inside one transaction.

#### I-5 Server module seams (S2 creates these as stubs so no two tasks share a file)

- `apps/server/src/app.ts` exports `buildApp(deps: { pool: Pool; config: Config; clock?: () => number }): Promise<FastifyInstance>`. It registers cookie, multipart, rate-limit, static avatars, then **all** route plugins from the start: `auth, profile, friends, notes, wallet, games, history, stats, integrity, notifications`, each `import x from './routes/x.js'`, mounted under `/api`. Stubs are `export default async function (app) {}`.
- `apps/server/src/auth/session.ts` exports `createSession(pool, userId, ip, deviceId)`, `destroySession`, `userFromRequest(req)`, `requireUser` (a preHandler that sets `req.user = { id, displayName }` or replies 401), and `userFromCookieHeader(pool, cookieHeader)` for sockets. Cookie `sid`: httpOnly, SameSite=Lax, Secure when `config.secureCookies`, 30-day expiry. Device id comes from header `x-device-id` (the web client creates a UUID in localStorage), else `'unknown'`.
- `apps/server/src/realtime/socket.ts` exports `attachSockets(app, deps)`. It is called from `src/main.ts` after `buildApp`.
- `apps/server/src/realtime/tableManager.ts` exports `class TableManager { constructor(deps: { pool; clock; setTimer; clearTimer; emitTo(userId, event, payload); emitRoom(gameId, event, payload) }); open(gameId); join(gameId, userId): TableView; sit(...); leave(...); act(...); setClientSeed(...); useTimeBank(...); host(gameId, userId, cmd); onHandEnded(listener) }`. Times are injected so tests use fake timers.
- `apps/server/src/test/helpers.ts` exports `testDb()` (creates a fresh schema per test file: `create schema t_<random>; set search_path`, runs migrations, returns `{ pool, cleanup }`), `makeUser(pool, name)`, `authed(app, user)` (returns cookie header), and `fakeClock()`.

#### I-6 Web module seams (S0.1 creates the stubs)

- `apps/web/src/App.tsx` has routes for `/login`, `/`, `/friends`, `/profile`, `/games/:id` (lobby details + RSVP + host panel), `/table/:id`, `/history`, `/history/:handId`, `/wallet`, `/settle/:gameId`, `/stats/:userId`. Each imports a page file that S0.1 creates as a stub returning `<h1>{name}</h1>`.
- Extra stubs S0.1 creates: `src/pages/HostPanel.tsx` (exports `HostPanel({ gameId })`), `src/pages/Login.tsx`, `Profile.tsx`, `Lobby.tsx`, `Friends.tsx`, `GameDetail.tsx`, `TablePage.tsx`, `History.tsx`, `HandReplay.tsx`, `Wallet.tsx`, `Settlement.tsx`, `Stats.tsx`.
- `apps/web/src/table/useTableStore.ts` (W11) is the zustand store. It exports both `useTableStore` (the live table) and `createTableStore()` (a fresh, independent store for the replayer). Components read only these selectors: `seats`, `board`, `pots`, `toAct`, `legal`, `deadline`, `timeBank`, `mySeat`, `myHole`, `myEquity`, `allInEquity`, `chat`, `status`, plus the **animation queue** `queue: AnimStep[]` and `consume(id)`. `AnimStep` = `{ id, kind: 'deal'|'bet'|'collect'|'award'|'flip'|'board'|'return', seat?, cards?, amount?, potIndex? }`. Socket events are turned into steps, and components play steps through the tween module, then call `consume`. The store's numbers (stacks, bets) update when a step is consumed, not when the event arrives, so text and motion stay in sync.
- `apps/web/src/anim/tween.ts` (W2) exports `easeInOutCubic, easeOutCubic, easeOutBack, easeOutQuart`, `tween({ id, from, to, durationMs, ease, onUpdate, onDone })` driven by one `requestAnimationFrame` loop, `useTween` hook, and `trace`. When `window.__POKER_TRACE__ = true`, `trace` records `{ id, t, value }` samples into `window.__animTrace` for tests. Vectors are `[x, y, z]` or numbers.
- `apps/web/src/table/layout.ts` (W5) exports `seatPosition(seat, maxSeats): [x,y,z]` around an ellipse (radii 4.2 × 2.4, seat 0 at bottom centre, clockwise as seen by the viewer, rotated so the viewer's seat is always at bottom centre), plus `dealerPosition`, `potPosition(index)`, `boardPosition(i)` and `betPosition(seat, maxSeats)`.

#### I-8 Server seams in detail (lead, checkpoint 3, written before the build; overrides I-4/I-5 where they differ)

- **Schema (S1):** `001_init.sql` is I-4 without the `create extension` line (F12), and `ledger_accounts` uses `unique nulls not distinct (kind, user_id, game_id)`, so the single bank account (both null) really is unique.
- **Config (S2 takes over `apps/server/src/config.ts`):** adds `trustProxy` (env `TRUST_PROXY`, default `'loopback'`), `registration` (`REGISTRATION=open|invite`, default `'invite'`), `production` (`NODE_ENV === 'production'`). A relative `AVATAR_DIR` and the default are resolved against the server package root (`apps/server`), not the working directory.
- **App deps:** `buildApp` decorates `app.deps = { pool, config, clock }` (`clock: () => number`, default `Date.now`). Route plugins read the pool from `app.deps.pool`. `types.d.ts` declares `deps`, `tables: TableManager` and `req.user`.
- **Sessions (`auth/session.ts`):**
  ```ts
  export interface SessionUser { id: string; displayName: string }
  export const SESSION_COOKIE = 'sid';
  export function createSession(pool: Pool, userId: string, ip: string, deviceId: string): Promise<{ value: string; expiresAt: Date }>; // value = 32 CSPRNG bytes base64url; the row id is sha256(value) hex
  export function destroySession(pool: Pool, cookieValue: string): Promise<void>;
  export function setSessionCookie(reply: FastifyReply, config: Config, session: { value: string; expiresAt: Date }): void;
  export function clearSessionCookie(reply: FastifyReply, config: Config): void;
  export function userFromRequest(req: FastifyRequest): Promise<SessionUser | null>;
  export function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void>; // preHandler: sets req.user or replies 401 { error: 'Not signed in' }
  export function userFromCookieHeader(pool: Pool, cookieHeader: string | undefined): Promise<SessionUser | null>;
  export function deviceIdFrom(req: FastifyRequest): string; // header x-device-id (max 64 chars), else 'unknown'
  ```
- **Errors:** every REST error body is `{ error: string }`.
- **Test helpers (`src/test/helpers.ts`, S1):**
  ```ts
  export function testDb(): Promise<{ pool: Pool; schema: string; cleanup: () => Promise<void> }>;
  export function testConfig(overrides?: Partial<Config>): Config;      // loadConfig({}) + registration 'open' + a temp avatarDir + overrides
  export function makeUser(pool: Pool, name: string): Promise<{ id: string; email: string; displayName: string }>;
  export function authed(app: FastifyInstance, user: { id: string }): Promise<{ cookie: string; origin: string }>; // headers for app.inject: a real session cookie plus the Origin the CSRF hook accepts
  export function fakeClock(startMs?: number): { now: () => number; setTimer: (fn: () => void, ms: number) => number; clearTimer: (h: unknown) => void; advance: (ms: number) => Promise<void> }; // advance fires due timers in time order and awaits microtasks between them
  ```
- **Migrations:** `db/migrate.ts` exports `migrate(pool: Pool, dir?: string): Promise<string[]>` (names applied now). Later migrations: `002_seeds.sql` (S8), `003_invites.sql` (S3).
- **Stubs S2 creates (bodies throw `new Error('not implemented')` unless noted):**
  ```ts
  // wallet/ledger.ts (S7)
  export type Queryable = Pool | PoolClient;
  export type AccountKind = 'wallet' | 'table' | 'bank';
  export class InsufficientFundsError extends Error {}
  export function ensureAccount(db: Queryable, kind: AccountKind, userId?: string | null, gameId?: string | null): Promise<string>; // account id
  export function transfer(client: PoolClient, fromAcct: string, toAcct: string, amount: number, reason: string): Promise<string>; // tx id; the caller owns the transaction
  export function balance(db: Queryable, acct: string): Promise<number>;
  export function walletBalance(db: Queryable, userId: string): Promise<number>;
  export function grant(pool: Pool, userId: string, amount: number, reason: string): Promise<void>;       // bank → wallet
  export function buyIn(pool: Pool, userId: string, gameId: string, amount: number): Promise<void>;       // wallet → table account (kind 'table', that user, that game)
  export function cashOut(pool: Pool, userId: string, gameId: string, amount: number): Promise<void>;     // table account → wallet
  // notify.ts (S10)
  export type NotifyKind = 'invite' | 'gameStarting' | 'friendRequest' | 'seatRequest' | 'integrityFlag';
  export interface NotifyPayload { id: string; kind: NotifyKind; text: string; link?: string }
  export function setNotifyEmitter(fn: ((userId: string, payload: NotifyPayload) => void) | null): void;
  export function notify(pool: Pool, userId: string, kind: NotifyKind, text: string, link?: string): Promise<NotifyPayload>;
  // realtime/hostControls.ts (S17)
  export type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';
  export type HostEffect = 'start' | 'kick' | 'pause' | 'resume' | 'approve' | 'reject';
  export function applyHostCommand(settings: GameSettings, status: GameStatus, cmd: HostCommand, actor: string, hostId: string): { settings: GameSettings; status: GameStatus; effects: HostEffect[] } | { error: string };
  // games/scheduler.ts (S15) – the stub returns a no-op stop function
  export interface SchedulerDeps { pool: Pool; clock: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; tables: { open(gameId: string): Promise<void> }; notify: typeof notify }
  export function startScheduler(deps: SchedulerDeps): () => void;
  // games/tournament.ts (S16)
  export interface TournamentControllerLike {
    levelFor(now: number): BlindLevel;
    onHandEnded(stacks: { userId: string; startStack: number; endStack: number }[], now: number): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }>;
    canRebuy(userId: string, now: number): boolean;
    rebuy(userId: string, now: number): Promise<number>;   // chips added to the stack
    results(): Promise<ResultEntry[]>;
  }
  export class TournamentController implements TournamentControllerLike { constructor(deps: { pool: Pool; gameId: string; settings: GameSettings; startedAtMs: number; pausedMs: () => number }); /* methods throw */ }
  export function prizes(prizePool: number, payouts: number[], finishOrder: string[][]): { userId: string; place: number; prize: number }[]; // finishOrder: best first; an inner array is a tie
  // realtime/tableManager.ts (S8 replaces it in checkpoint 5)
  export interface TableManagerDeps { pool: Pool; clock: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void;
    emitTo: (userId: string, event: ServerEventName, payload: unknown) => void; emitRoom: (gameId: string, event: ServerEventName, payload: unknown) => void;
    seedWaitMs?: number; runoutPacingMs?: number }
  export class TableManager {
    constructor(deps: TableManagerDeps);
    open(gameId: string): Promise<void>; isOpen(gameId: string): boolean;
    join(gameId: string, userId: string): Promise<TableView>;
    sit(gameId: string, userId: string, seat: number, buyIn: number, clientSeed: string): Promise<void>;
    leave(gameId: string, userId: string): Promise<void>;
    act(gameId: string, userId: string, handId: string, kind: ActionKind, amount?: number): Promise<void>;
    setClientSeed(gameId: string, userId: string, handNumber: number, clientSeed: string): void;
    useTimeBank(gameId: string, userId: string): Promise<void>;
    rebuy(gameId: string, userId: string): Promise<void>;
    host(gameId: string, userId: string, cmd: HostCommand): Promise<void>;
    setConnected(gameId: string, userId: string, connected: boolean): void;
    pendingSeatRequests(gameId: string): { playerId: string; name: string }[];
    results(gameId: string): Promise<ResultEntry[]>;
    onHandEnded(listener: (gameId: string, record: HandRecord) => void): void;
  }
  ```
  Route stubs: `routes/{auth,profile,friends,notes,wallet,games,history,stats,integrity,notifications,results}.ts`, each `export default async function (app: FastifyInstance): Promise<void> {}`, all registered under the prefix `/api`.

#### I-9 Real-time table in detail (lead, checkpoint 5, written before the build; overrides S8/S12/S13 task text and I-8 where they differ)

**Ownership this checkpoint.** S8: `realtime/tableManager.ts`, `migrations/002_seeds.sql`, `test/tableManager.test.ts`, plus type-only edits to two stubs: `realtime/hostControls.ts` (`HostEffect` gains `'end'`) and `games/tournament.ts` (`TournamentControllerLike` and the stub class gain `nextLevelAt(now: number): number | null`). S12: `realtime/socket.ts`, `server.ts` (new), `main.ts`, `test/socket.test.ts`, and `packages/protocol/src/index.ts` + its test (only to add the host command `{ kind: 'end' }`). S13: `test/integration.table.test.ts`, `test/bots.ts`.

**Server wiring (S12).** `apps/server/src/server.ts` exports
```ts
export interface TableOptions { seedWaitMs?: number; runoutPacingMs?: number; handDelayMs?: number; autoStartMs?: number; rebuyWaitMs?: number }
export function createServer(opts: { pool: Pool; config: Config; clock?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; tableOptions?: TableOptions; scheduler?: boolean }):
  Promise<{ app: FastifyInstance; io: Server; tables: TableManager; close: () => Promise<void> }>;
```
It calls `buildApp` (passing `config.rateLimitMax`), builds the `TableManager` with `emitTo = io.to('user:' + id).emit` and `emitRoom = io.to('game:' + id).emit`, does `app.decorate('tables', manager)`, `attachSockets(app, { tables, pool, config })`, `setNotifyEmitter` (emits `notify` to room `user:<id>`), and `startScheduler` unless `scheduler: false`. It does not listen and does not migrate. `main.ts` = load config, pool, `migrate`, `createServer`, `listen`, clean shutdown; in production (F11) it also serves `apps/web/dist` with an SPA fallback for non-`/api`, non-`/avatars`, non-`/socket.io` GETs. `close()` stops the scheduler, closes io and the app, and calls `tables.shutdown()`.

**TableManager deps (final).** `{ pool, clock, setTimer, clearTimer, emitTo, emitRoom, seedWaitMs = 2000, runoutPacingMs = 1500, handDelayMs = 3000, autoStartMs = 5000, rebuyWaitMs = 15000, tournamentFactory?: (a: { pool; gameId; settings; startedAtMs; pausedMs: () => number }) => TournamentControllerLike }` (default factory: `new TournamentController(a)`). Extra methods: `shutdown(): void` (clears all timers), `viewFor(gameId, userId): TableView`.

**Errors.** `export class TableError extends Error { constructor(public code: string, message: string, public statusCode = 400) }`. Codes: `not_found`, `forbidden`, `seat_taken`, `already_seated`, `bad_buy_in`, `not_enough_chips`, `not_your_turn`, `stale_hand`, `illegal_action`, `not_seated`, `closed`, `bad_state`. The socket layer turns any thrown error into an `error` event `{ code, message }` for that socket (unknown errors → code `internal`, generic message, logged).

**Access (AC1).** Only the game's host and users with a `game_invites` row may `join`, `sit`, or receive anything. Others get `forbidden`.

**Statuses.** DB `games.status`: `scheduled → open → running ⇄ paused → finished` (or `cancelled`). Table status in views: `waiting` (DB `open`), `running`, `paused`, `finished`. `open(gameId)` loads the game (settings parsed with `GameSettingsSchema`), sets DB status `open` if it was `scheduled`, and is idempotent. `join` opens the table lazily when the DB status is `open`, `running` or `paused` (after a restart a `running`/`paused` game comes back as `waiting` with empty seats). On `open`, any positive `table` ledger balance left for a **cash** game by a crash is cashed out to its owner's wallet.

**Chips and the ledger (AC16).** A player's stack always equals the balance of their `table` ledger account for that game. `sit` → `ledger.buyIn`. At the end of every hand, inside the same DB transaction that inserts `hands`, `hand_players` and `hand_seeds`, chips move between the players' table accounts to match the hand's nets: compute pairwise transfers with the engine's `settle(nets)` and apply each with `ledger.transfer(client, loserTableAcct, winnerTableAcct, chips, 'hand ' + handNumber)`. Lock order: before the transfers, lock all involved account rows in one statement ordered by id. Cash game `leave` (or being unseated) → `ledger.cashOut` of the whole stack. A cash player whose stack is 0 after a hand is unseated automatically.

**Seating.** Seat free, user not already seated (AC8), status not `finished`. Cash: `minBuyIn ≤ buyIn ≤ maxBuyIn`, allowed while `waiting`, `running` or `paused` (dealt in from the next hand). Tournament: `buyIn` must equal `startingStack`, only while `waiting`. With `seatApproval` on and the user not the host: the request `{ playerId, name, seat, buyIn, clientSeed }` is queued (one per user), the host gets `notify(…, 'seatRequest', …)` and a fresh `table:view`; `approveSeat` performs the sit (or drops the request with an `error` event to the player if it no longer fits) and `approve: false` drops it. At each sit, run `sharedNetwork` over the latest `sessions` row of each seated player and upsert the flags (F7).

**Starting (F4).** Host command `start` (only in `waiting`, needs ≥ 2 seated) → `running`. Cash games with `settings.autoStart` start by themselves `autoStartMs` after the second player sits (cancelled if seats drop below 2). `pause` takes effect after the current hand; `resume` continues. `end` (new host command, any non-finished status): after the current hand, cash games cash every player out; the game becomes `finished`, DB status `finished`, `table:status` and `table:results` are emitted (cash: `results` lists each player who played with `place` by net result and `prize: 0`; tournament: the controller's results). A tournament finishes by itself when the controller says so; a host `end` of a running tournament is rejected with `bad_state`.

**Hand loop.** When status is `running`, no hand is in progress and ≥ 2 seated players have chips: (1) take the pending server seed (create it and a `saltKey` if missing: `newServerSeed()` each); emit `hand:commitment { gameId, handNumber, commitment }` to the room; (2) wait until every seated player has sent `table:clientSeed` for this `handNumber` or `seedWaitMs` passed (missing seeds are skipped; duplicates from one player: last wins); (3) `deck = deckFromSeeds(serverSeed, clientSeeds, handNumber)`, `button = nextButton(prev, occupiedSeatsWithChips, maxSeats)`, stakes from the settings (cash: `levels[0]`; tournament: `controller.levelFor(now)`), apply pending settings first (AC15), `startHand`; (4) fill `handStarted.commitment` and `cardCommitments = cardCommitments(deck, saltKey)`. Events go out through `emitTo(userId, 'hand:event', { gameId, event: redact(event, viewerSeat) })` to every seated player and every watcher (a watcher = a user who joined and is not seated; viewerSeat null). `cardProof { position, card, salt }` events are emitted (not stored in the record): each hole card to its owner right after their `dealHole`; each board card to everyone right after its `street` event; a shown hand's two hole cards to everyone right after its `showCards`. Never for folded or mucked hands or burns. Positions come from `dealPositions(n)`. On `handEnded`: fill `clientSeeds` (sorted, as used) and `nextCommitment = commit(newly generated next seed)`; persist (see below); wait `handDelayMs`; loop.
- Record: `HandRecord.events` = every engine event as sent to the hand's own viewers **unredacted** (with the filled-in fields), plus the `equity` events; no `cardProof` events. `hole`, `board`, `playerIds` from the engine state.
- `002_seeds.sql`: `create table hand_seeds (hand_id uuid primary key references hands on delete cascade, server_seed text not null, salt_key text not null);`. Seeds leave the server only through S19's fairness route after the game is `finished`.
- All-in runout: when `allInRunout(state)` and ≥ 2 players remain: emit `showCards` for each remaining player (server-made events, with `handName` from `evaluate7` of the cards so far, or `''` preflop) and their card proofs; then before each street an `equity` event (`equityExact(holes, board)`, `street` = the street about to be dealt) when `settings.showAllInEquity`; then `advance(state)`; pace streets `runoutPacingMs` apart. The engine's own `showCards`/`muck` at the end are sent as they come (a second `showCards` for the same seat is harmless).
- Timers (AC10): on each `toAct`, `deadline = now + turnSeconds·1000`; the `toAct` event sent out carries `deadline`; also emit `table:clock { gameId, seat, deadline, timeBankMs, usingTimeBank: false }`. On expiry, if the player's `timeBankMs > 0`: switch to the bank (`usingTimeBank: true`, `deadline = now + timeBankMs`, emit `table:clock`); when that expires, or at once if the bank is empty, apply `timeoutAction` (event `auto: 'timeout'`) and set the bank to 0. `useTimeBank` switches early. Bank use is charged by elapsed time when the player acts. Each player starts with `timeBankSeconds`; top-up `+timeBankTopUpSeconds` (capped at `timeBankSeconds`) every 100 hands (cash) or at each new level (tournament). Disconnected players get no extra time. A kicked or leaving-mid-hand cash player, and a tournament player who has left, is auto-acted (`timeoutAction`) immediately at their turn.
- `act(gameId, userId, handId, kind, amount?)`: `stale_hand` if `handId` is not the current hand, `not_your_turn`, engine `IllegalActionError` → `illegal_action`.
- Serialisation: all work for one table runs through a per-table promise queue; never `await` between reading the hand state and storing the new one.
- After each hand: `table:seats`, and `analyse(recordsOfThisGame, bigBlind)` (records kept in memory; log the timing; if it took > 50 ms, run it only every 25 hands). Merge flags with the same `(kind, players)` (higher score, summaries joined) and upsert into `integrity_flags`; `notify` the host (`integrityFlag`) for flags that are new.
- Tournaments: `controller.levelFor(now)` gives the stakes; a level change emits `table:status` with `level` and `nextLevelAt`. After a hand, players with 0 chips for whom `controller.canRebuy(userId, now)` is true get `rebuyWaitMs` to send `table:rebuy` (`controller.rebuy` debits the wallet and returns the chips; the stack is set to it); then `controller.onHandEnded(stacks, now)` is called with the final stacks; eliminated players are unseated; `finished` → status `finished`, `table:results` from `controller.results()`. `table:rebuy` at any other time → `bad_state`. Leaving a tournament keeps the seat (the player is auto-folded until blinded out). Kick in a tournament does the same.
- Host commands go through `applyHostCommand(settings, status, cmd, actor, hostId)` (S17 implements it in checkpoint 6; S8's tests mock the module). Effects: `start`, `pause`, `resume`, `end`, `kick` (cash: fold at next turn, cashed out after the hand), `approve`/`reject` (seat requests). Returned `settings` are stored as pending and applied at the next `startHand` (and written to `games.settings`).

**Views.** `viewFor(gameId, userId)`: `TableView` for that viewer (`mySeat`, `myHole`, `legal`/`deadline` only when it is their turn, `seatRequests` only for the host, `chat` = last 50 `chat_messages` joined with user names, `commitment` = the pending hand's commitment or null). `SeatView.cardsVisible`: the viewer's own cards, or cards shown at showdown; otherwise null; `hasCards` = dealt in and not folded. `SeatView.bet` = contribution on the current street.

**Socket layer (S12).** `attachSockets(app, { tables, pool, config }): Server`. `io.use`: `userFromCookieHeader(pool, handshake.headers.cookie)` → reject with `Error('unauthorized')` if none; reject if the handshake `Origin` header is present and not `config.publicOrigin`. Each socket joins `user:<id>`. Handlers validate every payload with `ClientEventSchemas[event]`; invalid → `error { code: 'bad_request', message }` and nothing else happens. `table:join` → `tables.join` then join room `game:<id>`, ack `{ ok: true, view }` or `{ ok: false, error }`. `table:sit/leave/action/clientSeed/useTimeBank/rebuy` and `host:command` → the matching manager method. `chat:send`: sender must have joined that game; insert into `chat_messages`; emit `chat:message` to `game:<id>`. Token buckets per socket: 10 table events/s; chat 5 per 10 s (over the limit → `error { code: 'rate_limited' }`; the chat bucket's capacity must be a named constant `CHAT_BUCKET_CAPACITY = 5`). On disconnect: `tables.setConnected(gameId, userId, false)` for each joined game when it was the user's last socket in that game; on join `true`.

#### I-10 Web foundation in detail (lead, checkpoint 7, written before the build; overrides the W1–W4 and W-E2E-1 task text and I-6 where they differ)

**Extra file ownership in checkpoint 7** (no other task edits these):
- W1 also owns `apps/web/src/App.tsx` (wrap every route except `/login` in `<Shell>`), `apps/web/src/main.tsx` (import `./ui/theme.css`), `apps/web/vite.config.ts` (add a `/avatars` proxy to `http://localhost:3001`; uploaded avatars are served there, outside `/api`), and `apps/web/test/setup.ts` if a shared jest-dom setup is wanted (then W1 tells the lead, who wires `setupFiles` into the root `vitest.config.ts`). W1 does **not** edit `package.json`: F9 already installed testing-library.
- W-E2E-1 also owns `playwright.config.ts` and `e2e/reset-db.ts`.

**REST shapes.** Every server route file starts with a comment block listing its routes, bodies, status codes and response types (`apps/server/src/routes/*.ts`). That block is the contract; web tasks read it and do not guess. Socket payload types come from `@poker/protocol`.

**`src/api/client.ts` (W1):**
```ts
export class ApiError extends Error { readonly status: number; constructor(status: number, message: string) }
/** path starts with '/api/'. JSON in and out. `body` is JSON-encoded unless it is a FormData. 204 → undefined.
 *  A non-2xx answer throws ApiError(status, body.error ?? statusText). Always credentials: 'include' and an `x-device-id` header. */
export function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
export function deviceId(): string; // uuid kept in localStorage under 'poker.deviceId'
```
**`src/api/useMe.ts` (W1):**
```ts
export interface Me { id: string; email: string; displayName: string; avatarUrl: string }
/** One shared fetch of GET /api/auth/me for the whole app. On 401 it navigates to /login (except when already there). */
export function useMe(): { me: Me | null; loading: boolean; refresh(): Promise<void>; setMe(me: Me | null): void };
```
**`src/api/socket.ts` (W1):** `getSocket(): Socket<ServerEvents, ClientEvents>` (one lazy singleton, `withCredentials`, path `/socket.io`), `joinTable(gameId): Promise<TableView>` (emits `table:join`, remembers the id and re-joins after every reconnect), `leaveTableRoom(gameId)`, `disconnectSocket()`.
**`src/ui/Shell.tsx` (W1):** `export function Shell({ children }: { children: React.ReactNode })`. It shows the "Play money" label next to the nav (F13) and a Log out button.

**`src/anim/easing.ts` / `src/anim/tween.ts` (W2):**
```ts
export type Vec3 = [number, number, number];
export type TweenValue = number | Vec3;
export type Ease = (t: number) => number;
export const linear, easeInOutCubic, easeOutCubic, easeOutBack, easeOutQuart, easeInOutSine: Ease; // tween.ts re-exports them
export interface TweenOptions<T extends TweenValue> {
  id: string; from: T; to: T; durationMs: number; ease?: Ease /* default easeInOutCubic */; delayMs?: number;
  onUpdate(value: T): void; onDone?(): void;
}
export interface TweenHandle { cancel(): void; readonly done: Promise<void> }
/** One shared requestAnimationFrame loop, timestamp based. Starting a tween whose id is already running
 *  replaces it and starts from that tween's current value (the new `from` is ignored), so nothing snaps. */
export function tween<T extends TweenValue>(opts: TweenOptions<T>): TweenHandle;
/** React state that eases to `target` whenever it changes (first render: equals target, no motion). */
export function useTween<T extends TweenValue>(target: T, opts: { id: string; durationMs: number; ease?: Ease }): T;
/** F5: like useTween for a position, and it also records the value it returns every frame under `obj:<id>` in the trace,
 *  moving or not. The only way table objects and panels get a position. */
export function useTweenedPosition(id: string, target: Vec3, opts?: { durationMs?: number; ease?: Ease }): Vec3;
export function prefersReducedMotion(): boolean;
export function activeTweenCount(): number;
export function onTweenActivity(listener: (active: number) => void): () => void; // W5 switches the canvas frameloop with it
export const trace: { enabled(): boolean; record(id: string, t: number, value: TweenValue): void; clear(): void };
// window.__POKER_TRACE__ = true → samples { id, t, value, from?, to?, durationMs? } are pushed to window.__animTrace
export function __setRafForTests(raf: (cb: (t: number) => void) => number, caf: (h: number) => void, now: () => number): void;
```
W2 may add to this surface and reports what it added; it does not remove or rename.

**Page facts W3/W4 and the e2e spec agree on** (accessible names; the spec uses `getByRole`/`getByLabel` with exactly these):
- `/login`: `<h1>Login</h1>` in login mode (the smoke test needs it), `<h1>Create account</h1>` in register mode; a button "Create an account" / "I already have an account" toggles. Fields labelled "Email", "Password", and in register mode "Display name" and "Invite code" (optional). Submit buttons "Log in" and "Create account". Errors show in an element with `role="alert"`. On success: navigate to `/`.
- `/friends`: field "Friend's email", button "Send request"; incoming requests list each with buttons "Accept" and "Decline"; friends list with each friend's name linking to `/stats/:userId` and a "Remove" button.
- `/` (Lobby): heading "Lobby", a "New game" button that opens a form with fields "Game name", "Starts at" (`datetime-local`), the `SettingsForm`, and a submit button "Schedule game". After creating, navigate to `/games/:id`. The list shows each game's name as a link to `/games/:id`.
- `/games/:id`: heading = the game name. Host: an "Invite friends" section with a checkbox per friend (label = friend's name) and a button "Send invites". Invited user: RSVP buttons "Yes", "Maybe", "No" (the chosen one has `aria-pressed="true"`). A link "Add to calendar" with `href="/api/games/:id/calendar.ics"`. "Open table" link to `/table/:id` when the status is `open`, `running` or `paused`; the host also gets an "Open table now" button (`POST /api/games/:id/open`) while it is `scheduled`. On a 403 from `GET /api/games/:id` the page shows "You don't have access to this game" (F6).
- Shell: a nav with links "Lobby", "Friends", "History", "Wallet", "Profile"; a button with accessible name "Notifications" (with the unread count in a badge) that opens a list of notification texts; clicking one marks it read and follows its link.

**E2E server setup (W-E2E-1).** Playwright starts `webServer` before `globalSetup`, and the server migrates at boot, so a schema drop in `globalSetup` would pull the tables from under a running server. Instead: `e2e/reset-db.ts` (run with `tsx`) does `drop schema public cascade; create schema public;` on `poker_e2e` as the `poker` role (no pgcrypto, F12), and the server `webServer.command` becomes `npx tsx e2e/reset-db.ts && npm run dev -w @poker/server`. Its env adds `REGISTRATION=open`, `RATE_LIMIT_MAX=100000`, `AUTH_RATE_LIMIT_MAX=100000`. `e2e/global-setup.ts` stays a no-op.

#### I-11 The table in detail (lead, checkpoint 8, written before the build; overrides the W5–W12 and W-E2E-2 task text, I-6 and F10 where they differ)

**Two phases.** Checkpoint 8 starts with one task, **W0 Table contracts**, alone. When it has passed, W5–W12 and W-E2E-2 run in parallel. W0 exists so that every parallel task imports files that are already final and nobody waits on a file another task is still writing.

**The model: a paced, declarative scene.** Components never play animations imperatively. The store holds *where every card and chip stack is* (`cards`, `chips`) and the numbers on display. Each component takes its position from `useTweenedPosition(id, scene.xxxPosition(...), { from, delayMs, durationMs, ease })`, so every change of place is a tween by construction (AC4, F5). Hand events enter a queue as **steps**. One driver, the *director* (W11), plays the queue in order: `begin(id)` moves the entities (the tweens start), then after the step's duration `consume(id)` settles the numbers (stacks, bets, pots, whose turn) and removes entities that are gone. This replaces I-6's "components play steps and call consume": only the director calls `begin`/`consume`.

**W0 Table contracts.** Owns: `apps/web/src/table/types.ts`, `apps/web/src/table/storeContext.tsx`, `apps/web/src/table/sceneContext.ts`, edits to `apps/web/src/anim/tween.ts` + `apps/web/test/useTween.test.tsx`, `apps/web/test/storeContext.test.tsx`, and a stub of every checkpoint-8 component file so imports compile: `table/{Table3D,Felt,Cards,Chips,SeatHud,TurnRing,ActionBar,ChatPanel,NotesPopover}.tsx`, `table/{layout,cardTexture,chipStacks,useTableStore,verify}.ts`, `workers/{equity.worker,useEquity}.ts` (each stub exports the names and prop types below; components return `null`, functions throw `new Error('not implemented')`). Proof: `npx vitest run apps/web/test/useTween.test.tsx apps/web/test/storeContext.test.tsx && npm run typecheck && npm run lint`.

1. `tween.ts`: `useTweenedPosition(id, target, opts?: { durationMs?; ease?; delayMs?; from?: Vec3 })`. `from`: the value on the first render; the hook then tweens to `target` at once (a spawn). Without `from` the first render equals `target` as now. `delayMs` is passed to every tween the hook starts. Tests: mounting with `from` starts at `from` and ends at `target` with every traced `obj:` sample in between `active: true`; `delayMs` holds the value at the start for that long.
2. `table/types.ts` (final, verbatim apart from imports):
```ts
export type CardPlace = { at: 'deck' } | { at: 'seat'; seat: SeatIndex; index: 0 | 1 } | { at: 'board'; index: number } | { at: 'muck' };
/** id: `card:<handId>:<seat>:<0|1>` for hole cards, `card:<handId>:board:<0..4>` for board cards. */
export interface CardEntity { id: string; place: CardPlace; spawnFrom?: CardPlace; card: Card | null /* null = hidden from this viewer */; faceUp: boolean; order: number /* stagger index inside its step */; fading: boolean }
export type ChipPlace = { at: 'seat'; seat: SeatIndex } | { at: 'bet'; seat: SeatIndex } | { at: 'pot'; index: number };
/** ids: `chips:bet:<seat>` (a seat's bet this street), `chips:inc:<stepId>` (chips on their way to join a bet),
 *  `chips:pot:<index>`, `chips:award:<stepId>:<seat>` (a pot share on its way to a winner), `chips:return:<stepId>`. */
export interface ChipEntity { id: string; amount: Chips; place: ChipPlace; spawnFrom?: ChipPlace; order: number }
export type StepKind = 'newHand' | 'bet' | 'deal' | 'turn' | 'action' | 'fold' | 'collect' | 'return' | 'pots' | 'board' | 'flip' | 'muck' | 'equity' | 'award' | 'handEnd';
/** One queued unit of play. `events` are the hand events it covers (a step may batch several, e.g. all blinds, or every dealHole). */
export interface AnimStep { id: number; kind: StepKind; events: HandEvent[]; seat?: SeatIndex; cards?: Card[]; amount?: Chips; potIndex?: number; durationMs: number }
export interface Equity { win: number; tie: number }
export interface LogLine { id: number; text: string; tone: 'info' | 'good' | 'bad' }
export interface TableState {
  gameId: string | null; settings: GameSettings | null; status: TableStatus; level: BlindLevel | null; nextLevelAt: number | null;
  handId: string | null; handNumber: number; buttonSeat: SeatIndex | null;
  seats: SeatView[];            // as DISPLAYED: stack/bet/folded/allIn/hasCards change on consume
  board: Card[]; pots: Pot[];   // as displayed
  toAct: SeatIndex | null; legal: LegalActions | null; deadline: number | null;
  timeBank: { seat: SeatIndex; ms: number; using: boolean } | null;
  mySeat: SeatIndex | null; myHole: Card[]; myEquity: Equity | null; allInEquity: Record<number, Equity> | null;
  chat: ChatMessage[]; chatError: string | null; seatRequests: SeatRequest[]; results: ResultEntry[] | null;
  commitment: string | null; handLog: LogLine[]; verified: 'pending' | 'ok' | 'failed' | null; lastError: string | null;
  cards: CardEntity[]; chips: ChipEntity[];
  queue: AnimStep[]; playing: AnimStep | null; animate: boolean; // animate false: steps are applied at once (replayer rebuild, tests)
  // actions
  applyView(view: TableView): void;           // full snapshot: replaces everything, clears the queue, entities appear in place
  applyEvent(event: HandEvent): void;         // enqueues steps (cardProof is checked at once, never queued)
  applySeats(seats: SeatView[]): void; applyClock(c: TableClock): void; applyStatus(s: TableStatusMessage): void;
  applyCommitment(c: HandCommitment): void; applyResults(r: ResultEntry[]): void;
  addChat(m: ChatMessage): void; setChatError(e: string | null): void; setError(e: string | null): void; setMyEquity(e: Equity | null): void;
  begin(id: number): void; consume(id: number): void; flush(): void; reset(): void;
}
export function initialTableState(): Omit<TableState, /* the actions */ ...>;
export const STEP_MS: Record<StepKind, number>; // base durations: newHand 350, bet 300, deal 380 (+90 per extra card, added by the store), turn 0, action 0, fold 300, collect 450, return 300, pots 0, board 380 (+90 per extra card), flip 300, muck 300, equity 0, award 600, handEnd 0
export const DEAL_STAGGER_MS = 90;
```
3. `table/storeContext.tsx` (final): `TableStoreContext` (React context of a zustand `StoreApi<TableState>`), `TableStoreProvider({ store, children })`, `useTable<T>(selector: (s: TableState) => T): T` (zustand `useStore` on the context store; throws without a provider), `useTableStoreApi(): StoreApi<TableState>`, and `createBareTableStore(overrides?: Partial<TableState>): StoreApi<TableState>` (vanilla zustand store with `initialTableState()` and inert actions; component tests build their hand-made state with it, and W11 builds the real store on the same shape). **Every component reads the store only through `useTable`/`useTableStoreApi`**, never by importing `useTableStore`, so the replayer (checkpoint 9) can give the same components a different store.
4. `table/sceneContext.ts` (final): `export interface Scene { maxSeats: number; mySeat: SeatIndex | null; seatPosition(seat): Vec3; betPosition(seat): Vec3; potPosition(index): Vec3; boardPosition(index): Vec3; buttonPosition(seat): Vec3; dealerPosition: Vec3; muckPosition: Vec3 }`, `SceneContext = createContext<Scene | null>(null)`, `useScene(): Scene` (throws outside a provider), and `cardPlacePosition(scene, place: CardPlace): Vec3` / `chipPlacePosition(scene, place: ChipPlace): Vec3` (deck → `dealerPosition`; a seat's two hole cards sit side by side, ±0.22 on x from `seatPosition` lifted toward the table centre; muck → `muckPosition`).

**Exports and props the parallel tasks keep (W0 stubs them):**
- W5 `layout.ts`: `seatPosition(seat, maxSeats, mySeat)`, `betPosition(seat, maxSeats, mySeat)`, `buttonPosition(seat, maxSeats, mySeat)`, `potPosition(index)`, `boardPosition(index)`, `dealerPosition`, `muckPosition`, `makeScene(maxSeats, mySeat): Scene`, `cameraFor(aspect): { position: Vec3; fov: number; lookAt: Vec3 }`. The table lies in the XZ plane, y is up. With `mySeat === null` seat 0 is at bottom centre. `Table3D.tsx`: `export function Table3D({ children, overlay }: { children?: ReactNode; overlay?: ReactNode })`: provides `SceneContext` from the store's `settings.maxSeats` and `mySeat`, renders the `<Canvas>` (children inside it) and, on top of it, `overlay` (plain DOM). The scene provider wraps both. The root element has `data-testid="table-3d"`.
- W6 `Cards.tsx`: `export function Cards()` (inside the Canvas; renders `cards` from the store). W7 `Chips.tsx`: `export function Chips()` (inside the Canvas; renders `chips`; amount labels via drei `<Html>` with `data-testid="bet-<seat>"` on `chips:bet:<seat>` and `data-testid="pot-<index>"` on `chips:pot:<index>`, text in play dollars via `formatPlayMoney`). `chipStacks.ts`: `chipStacks(amount, bigBlind): { denom: number; color: string; count: number }[]`.
- W8 `SeatHud.tsx`: `export function SeatHud({ seat }: { seat: SeatIndex })` (inside the Canvas: a group at `useTweenedPosition('seat:' + seat, scene.seatPosition(seat))` holding a drei `<Html center>` with the DOM part) and `export function SeatHudView({ seat })` (the DOM part alone; the unit test renders this, without a Canvas). Also `export function DealerButton()` (the "D" marker at `useTweenedPosition('button', scene.buttonPosition(buttonSeat))`). `TurnRing.tsx`: `export function TurnRing({ seat })`, rendered by `SeatHudView` for the active seat.
- W9 `ActionBar.tsx`: `export function ActionBar({ gameId })` (plain DOM, in the overlay). W10 `ChatPanel.tsx`: `export function ChatPanel({ gameId })`; `NotesPopover.tsx`: `export function NotesPopover({ subjectId, name, onClose })`, `export function useNotes(): Record<string, { text: string; color: string | null }>` (one shared fetch of `GET /api/notes`, updated on save).
- W11 `useTableStore.ts`: `createTableStore(): StoreApi<TableState>`, `tableStore` (the live singleton), `useTableStore` (zustand hook bound to it), `connectTable(gameId, store?): () => void` (joins, wires every socket event to the store actions, answers `hand:commitment` with a fresh client seed, uses `onRejoin`; returns a disconnect function), `useDirector(store?)` (the hook that plays the queue; mounted once by TablePage). `verify.ts`: `checkCardProof(commitments: string[], proof: { position; card; salt }): boolean`, `expectedPosition(...)` per F10, `verifyGame(fairness, hands): { handNumber; ok: boolean; problem?: string }[]`.
- W12 `useEquity.ts`: `export function useEquity(): (req: { hole: Card[]; board: Card[]; opponents: number } | null) => void` (null clears; results go to `setMyEquity` of the context store). TablePage calls it from an effect whenever `myHole`, `board`, the number of opponents still in the hand, or my folded state change.

**Step rules (W11).** Mapping, with what moves at `begin` and what settles at `consume`:
- `handStarted` → `newHand`: begin sends every card of the previous hand to the muck (`fading`); consume removes them and all leftover chips, sets `handId`, `handNumber`, `buttonSeat`, clears `board`, `pots`, equities, sets `verified: 'pending'`.
- consecutive `postAnte`/`postBlind` → one `bet` step: begin spawns `chips:inc:*` from each seat to its bet place; consume merges them into `chips:bet:<seat>` and updates `stack`/`bet`.
- all `dealHole` events of a hand → one `deal` step: begin spawns the hole cards from the deck, `order` = deal order (F10: round by round, starting left of the button); my cards carry their values and `faceUp: true`. consume sets `hasCards`, `myHole`.
- `toAct` → `turn` (sets `toAct`, `legal`, `deadline`). `action`: fold → `fold` (cards to the muck, then `folded`); check → `action` (log only); call/bet/raise/allIn → `bet`.
- `uncalledReturned` → `return`. `potsFormed` → `collect` (begin moves every `chips:bet:*` to pot 0; consume removes them, sets `pots` and one `chips:pot:<i>` per pot, zeroes the bets). If there are no bet chips on the table the step takes 0 ms.
- `street` → `board` (spawn from the deck, face up; flop staggered). `showCards` → `flip` (sets the card values, `faceUp`, and `cardsVisible`). `muck` → `muck`. `equity` → `equity` (sets `allInEquity`).
- `potAwarded` → `award`: begin replaces `chips:pot:<i>` with one `chips:award:*` per winner, spawned at the pot, heading to the seat; consume removes them and raises the stacks.
- `handEnded` → `handEnd`: sets the stacks from the event (the source of truth), clears `toAct`, writes "✓ Cards verified" (tone `good`) or a red warning to `handLog` according to the card proofs received this hand.
- `toAct`, `legal`, `deadline`, `timeBank` are cleared when an `action` step for that seat begins. `table:clock` applies at once if its seat is the displayed `toAct`, else it is kept and applied when that `turn` step is consumed.
- Catch-up: if more than 8 steps are waiting, the director plays at half duration; more than 20, at a quarter. With `animate: false` or `flush()`, every step is begun and consumed at once.
- The director waits with a scalar `tween({ id: 'step:' + id, from: 0, to: 1, durationMs, ease: linear })`, so it shares the tween clock (fake rAF in tests, reduced motion, canvas frame loop).
- `applyView` while steps are queued (a reconnect): the snapshot wins; the queue is dropped.

**DOM facts the components and `e2e/table.spec.ts` agree on** (exact test ids and accessible names):
- Seat (`SeatHudView`): root `data-testid="seat-<n>"` with `data-active="true|false"` and `data-me="true|false"`; avatar `<img alt="<name>">`; name; stack `data-testid="stack-<n>"` in play dollars (`$1,250`, counting with a tween); status chips with the texts "Folded", "All-in", "Away"; equity badge `data-testid="equity-<n>"` with text `Win 63%`; turn ring `data-testid="turn-ring"` (only on the active seat). Hole cards as text for tests and screen readers: my seat has `data-testid="my-hole"` containing one `<span data-card="As">` per card I hold; every other seat with cards has `data-testid="hole-<n>"` with `data-face="down"` and no `data-card` children until its cards are shown (then `data-face="up"` and the spans). These spans carry the class `sr-only`.
- An empty seat (TablePage overlay or SeatHud, owned by **W8**: `SeatHud` renders it when no player sits there and the viewer is not seated): button with accessible name `Sit at seat <n+1>`. It calls `onSit(seat)` from a small context W0 defines in `sceneContext.ts`: `SeatActionsContext = createContext<{ onSit(seat): void; onOpenNotes(playerId, name): void }>`.
- TablePage (W11): sit dialog `role="dialog"` named "Sit down" with a field labelled "Buy-in" and a button "Sit down" (a tournament shows the fixed starting stack). Buttons "Leave table", "Start game" (host, status waiting, at least 2 seated; sends host command `start`), "Host panel" (host only; toggles a slide-over that contains `<HostPanel gameId>`; the slide-over is positioned with `useTweenedPosition('panel:host', …)` and has `data-testid="host-panel"` with `data-open`). Board as text: `data-testid="board"` with one `<span data-card>` per board card on display (`sr-only`). Hand log `data-testid="hand-log"`. Status banner `data-testid="table-status"` ("Waiting for players", "Paused", "Level 3 · next level in 04:12", "Game over"). The page title area shows the "Play money" label (F13).
- ActionBar (W9): root `data-testid="action-bar"` with `data-enabled="true|false"`. Buttons named exactly "Fold", "Check", `Call $<n>`, `Bet $<n>` or `Raise to $<n>` (the amount currently chosen; when the amount equals `maxTo` the name is `All-in $<n>`). Number field labelled "Amount"; presets "½ pot", "¾ pot", "Pot", "All-in" only set the amount. "Use time bank". Pre-action checkboxes "Check/Fold" and "Call any".
- Chat (W10): field labelled "Message", button "Send", list `data-testid="chat-list"`, counter like `12/200`.

**Trace check (W-E2E-2 (e), F5, with the checkpoint 7 decisions).** For every tween series and every `obj:*` series in `window.__animTrace`: for consecutive samples of one series, a change in value needs `active: true` on the later sample, and |Δ| ≤ 1.25 × `EASE_PEAK_SLOPE[ease]` × (|to − from| × Δt / durationMs) + ε, where |·| is the Euclidean length for vectors, Δt the real time between the two samples, and ε = 0.02 world units (1 for scalar series such as counting numbers). A sample pair that spans the end of one tween and the start of the next is judged against the later sample's tween. The spec asserts that the trace holds series for cards (`obj:card:`), chips (`obj:chips:`), seats (`obj:seat:`) and the host panel (`obj:panel:host`), and that `window.__animTraceDropped` is 0 or undefined.

**E2E setup (W-E2E-2).** Also owns `e2e/helpers.ts`: users, friendships, the game, invites and opening the table are made through the REST API (`request.newContext` with an `Origin: http://localhost:5173` header), then each browser context gets its session cookie. Only the table itself is driven through the UI. The game is created with `autoStart: false`, so the host clicks "Start game" after all three sit. `turnSeconds: 30`.

**Ownership notes.** `apps/web/src/table/table.css` (shared table styles) belongs to W11; W8, W9 and W10 each own a css file named after their component (`seatHud.css`, `actionBar.css`, `chat.css`). No task edits `theme.css`, `package.json` or another task's file; anything missing is reported to the lead.

---

## Tasks

Every task lists: files it owns (only these), what to do, code to copy, pitfalls, and its proof command. All paths are relative to `poker/` unless they start with `/`. Commands run from `poker/`.

General rules for every task:
- Use TypeScript strict mode, ES modules, and `.js` extensions in relative imports (`moduleResolution: nodenext` for server/engine/protocol, `bundler` for web).
- Chips and cents are integers. Never use floats for money or chips. Use `Number.isSafeInteger` checks at boundaries.
- Tests live next to their task: `test/<module>.test.ts` in the same package. Each task owns its test files.
- If a task depends on another task in the same checkpoint, code against the interface in "Read first" and use a fake in your own test. The checkpoint check proves they fit together.

### Checkpoint 0: Scaffold

**S0.1 Workspace scaffold.** Owns: `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `.editorconfig`, `.gitignore`, `.nvmrc`, `vitest.config.ts`, `playwright.config.ts`, `packages/engine/{package.json,tsconfig.json,src/*.ts}`, `packages/protocol/{package.json,tsconfig.json,src/index.ts}`, `apps/server/{package.json,tsconfig.json,src/main.ts,src/config.ts}`, `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx,src/pages/*.tsx}`, `e2e/smoke.spec.ts`, `e2e/global-setup.ts`.
- npm workspaces: `packages/*`, `apps/*`. Package names: `@poker/engine`, `@poker/protocol`, `@poker/server`, `@poker/web`. Engine and protocol are consumed as TS source through `exports: { ".": "./src/index.ts" }` (server runs with `tsx`, web through Vite), so no build step is needed for them.
- Root scripts: `lint` (`eslint .`), `typecheck` (`tsc -b` over all packages, or `npm run typecheck --workspaces`), `test` (`vitest run`), `e2e` (`playwright test --trace off`), `dev` (server + web in parallel via `npm-run-all2` or two `&` processes in a `scripts/dev.sh`), `db:migrate`.
- Pin every version listed in "Environment facts". Use `--save-exact`.
- Write `packages/engine/src/types.ts` verbatim from I-1, a stub for each module in I-2 (signatures exported, bodies throw), and `index.ts` re-exporting all of them.
- `packages/protocol/src/index.ts`: stub `export {}`.
- `apps/server/src/config.ts`: reads `PORT` (default 3001), `DATABASE_URL` (default `postgres://poker:poker@localhost:5432/poker_dev`), `SECURE_COOKIES` (default false), `AVATAR_DIR` (default `apps/server/data/avatars`), `PUBLIC_ORIGIN` (default `http://localhost:5173`). `main.ts` logs "not wired yet".
- Web: Vite + React with `server.proxy` for `/api` and `/socket.io` (ws: true) to `http://localhost:3001`. `App.tsx` and page stubs per I-6.
- `playwright.config.ts`: `globalSetup: './e2e/global-setup.ts'` (S0.1 writes it as a no-op; W-E2E-1 fills it), `webServer` starts `npm run dev` with env `DATABASE_URL=postgres://poker:poker@localhost:5432/poker_e2e` (reuseExistingServer: false), baseURL `http://localhost:5173`, one Chromium project, `use: { trace: 'off' }`. `e2e/smoke.spec.ts` opens `/login` and expects the stub heading.
- `.editorconfig`: `root = true`, `[*] indent_style = space, indent_size = 2, end_of_line = lf, insert_final_newline = true, charset = utf-8`.
- Pitfalls: TypeScript must be 6.0.3. `@types/node` must match Node 22. Do not install Playwright browsers. vitest workspace must give the web package `environment: 'jsdom'` (add `jsdom`, pin the current version from `npm view jsdom version`) and engine/server/protocol `node`. Do not touch files outside `poker/`.
- Proof: `npm ci && npm run lint && npm run typecheck && npx vitest run --passWithNoTests && npm run e2e`.

**S0.2 Exclude poker from Jekyll.** Owns: `/_config.yml` (repo root). Add `"poker"` to the `exclude:` array at lines 104–116, keeping the existing entries and formatting. Pitfall: YAML list inside `[ ]`, so mind the commas. Proof: `ruby -ryaml -e 'p YAML.load_file("_config.yml")["exclude"].include?("poker")'` prints `true` (run from repo root; if Ruby is missing, `python3 -c "import yaml;print('poker' in yaml.safe_load(open('_config.yml'))['exclude'])"`).

S0.1 and S0.2 run in parallel (different files).

### Checkpoint 1: Engine primitives + protocol (all parallel)

All tasks code against I-1/I-2 and own only their `src/<module>.ts` and `test/<module>.test.ts` in `packages/engine` (or `packages/protocol` for P1).

**E1 cards.** Owns `packages/engine/src/cards.ts`, `test/cards.test.ts`. Implement per I-2. Test: round-trip all 52 cards, reject "1x", "", "AsK". Proof: `npx vitest run packages/engine/test/cards.test.ts`.

**E2 rng.** Owns `src/rng.ts`, `test/rng.test.ts`. Implement per I-2 with `@noble/hashes/hmac.js` + `sha2.js` and `globalThis.crypto.getRandomValues`. Rejection sampling: for range `n = i+1`, `limit = 2^32 - (2^32 % n)`, draw again while `x >= limit`, then `j = x % n`. Tests: (a) same seeds + handNumber give the same deck, a different client seed gives a different deck; (b) the deck is a permutation of 0..51; (c) `verifyDeck` true for the real deck, false if one card is swapped or the commitment is wrong; (d) uniformity: 52,000 decks from seeds `seed-${k}`, then chi-square of card 0's position over 52 bins has p > 0.001 (critical value for df 51 at 0.001 is 90.57, so assert statistic < 90.57), and the same check for position 0's card; (e) `newServerSeed()` is 64 hex chars and two calls differ. Pitfalls: never `Math.random`; never `% n` without rejection; sort client seeds so their order does not matter; must work in jsdom/browser (no `node:crypto` import). Proof: `npx vitest run packages/engine/test/rng.test.ts`.

**E3 evaluator.** Owns `src/evaluator.ts`, `test/evaluator.test.ts`. Approach: score = category × 13^5 + tiebreak ranks in base 13. `evaluate7` takes the max over the 21 five-card subsets (fast enough: ~1 µs × 21). Wheel straight A-2-3-4-5 ranks below 2-6. `name` like "Full house, Kings over Fours". Tests: (a) **exhaustive**: over all C(52,5) = 2,598,960 hands, category counts must be exactly straightFlush 40, quads 624, fullHouse 3,744, flush 5,108, straight 10,200, trips 54,912, twoPair 123,552, pair 1,098,240, highCard 1,302,540 (mark the test with a 120 s timeout); (b) 20 hand-picked comparisons including wheel vs six-high straight, kicker ties, board plays (tie), flush vs flush by 5th card; (c) evaluate7 picks the best 5. Pitfall: the exhaustive test is the bar, so don't skip it for speed. Proof: `npx vitest run packages/engine/test/evaluator.test.ts`.

**E4 pots.** Owns `src/pots.ts`, `test/pots.test.ts`. Layered side pots by distinct all-in levels among non-folded contributors, with folded chips included in each layer up to that level. Merge adjacent pots with identical eligible sets. Tests: 3-way with two all-ins of different sizes, a folded player who contributed more than a short all-in, everyone equal (one pot), `splitPot(101, [2,5], button 3, 9)` gives seat 5 51 and seat 2 50 (seat 5 is first left of the button among the winners). Fast-check property: sum of pots == sum of contributions. Proof: `npx vitest run packages/engine/test/pots.test.ts`.

**E5 blinds.** Owns `src/blinds.ts`, `test/blinds.test.ts`. Simplified moving button: the button moves to the next occupied seat clockwise; SB is the next dealt-in seat after the button, BB the next after that; heads-up: button = SB and acts first preflop, BB acts first postflop. No dead-button rule (document this in a comment). Antes are capped at the stack. With `bigBlind` antes, the BB seat posts both; if it cannot cover both, the blind is filled first and the rest goes to the ante (TDA Rule 4), with a test for it. `levelAt` handles paused time. Tests cover 2, 3 and 9 players, wraparound and short stacks. Proof: `npx vitest run packages/engine/test/blinds.test.ts`.

**E6 settlement.** Owns `src/settlement.ts`, `test/settlement.test.ts`. Implement per I-2. Tests: (a) `[A +3000, B -1000, C -2000]` gives `B→A 1000`, `C→A 2000`; (b) 6 players with random nets give ≤ 5 transfers; (c) fast-check: for any nets that sum to 0, transfers balance each player exactly; (d) throws when the nets do not sum to 0; (e) `formatPlayMoney` cases; (f) `settlementText` lists the lines and contains "Play money only." Proof: `npx vitest run packages/engine/test/settlement.test.ts`.

**P1 protocol.** Owns `packages/protocol/src/index.ts`, `packages/protocol/test/protocol.test.ts`. zod schemas for every message in I-3, with `export type X = z.infer<typeof X>`. Export `ClientEvents`/`ServerEvents` maps for Socket.IO typing. Re-export the engine types it needs from `@poker/engine` (types only: `import type`). Limits: text 1–200 after trim, ids are UUID strings, amounts are safe non-negative integers, clientSeed `/^[0-9a-f]{32}$/`. `GameSettingsSchema` has `.superRefine`: payouts sum 100, cash has exactly 1 level, `minBuyIn <= maxBuyIn`, and the levels pass the same rules as `validateLevels`. **Reimplement the rule inline here** (the engine stub would throw at this checkpoint) and note the duplication with a comment `// keep in sync with engine/blinds.validateLevels`. Tests: valid and invalid samples for each message. Proof: `npx vitest run packages/protocol`.

Parallel: all 7 at once (no shared files). E7, E8, E10 and E11 wait for checkpoint 2 because they need a working evaluator/pots/blinds to test.

### Checkpoint 2: Engine game flow (all parallel)

**E7 hand state machine.** Owns `src/hand.ts`, `test/hand.test.ts`, `test/sim.test.ts`. Implements I-2 using cards/pots/blinds/evaluator. Deal order: 2 hole cards one at a time starting left of the button. Burn one card before flop/turn/river. Betting: the min bet is the big blind; the min raise increment is the largest previous bet/raise increment this street; an all-in below a full raise does not reopen raising for players who already acted (they may only call or fold); the BB has the option preflop. The street ends when every non-folded, non-all-in player has acted and matched the highest bet. Uncalled excess is returned before pots form. Showdown order: the last aggressor on the river shows first, otherwise the first seat left of the button. Losers who are not all-in may muck, but simplify: **the server auto-shows all hands at showdown that are still eligible for a pot they could win, and auto-mucks the others**, and document this. Winning hands are named. If everyone but one folds, award without showdown. HandState must be plain JSON (for persistence and tests). Tests: 25 scripted hands from the rule docs (heads-up blinds; BB option; short all-in not reopening; three-way side pots; split pot with odd chip; all fold preflop; BB walk; ante kinds; player all-in by posting a blind). `sim.test.ts`: fast-check over 2–9 seats, random stacks 1–10,000 and random legal actions, run 2,000 hands. Invariants: chips conserved, no negative stack, `toAct` is null only when complete or in an all-in runout, every action returned by legalActions is accepted and anything outside the bounds throws `IllegalActionError`, and the board ends with 5 cards whenever there is a showdown. Pitfalls: a raise "to" amount compared with the current street contribution, not the stack; heads-up postflop order; a player all-in for less than the BB preflop. Proof: `npx vitest run packages/engine/test/hand.test.ts packages/engine/test/sim.test.ts`.

**E8 equity.** Owns `src/equity.ts`, `test/equity.test.ts`. Tests (tolerances): AsAh vs KsKh preflop ≈ 0.82 win (±0.01 with a seeded rand); AhKh vs 2c2d preflop ≈ 0.50 (±0.02); on the flop exact: As Ks vs Qh Qd on board Qs 7h 2c gives a known exact value; compute it with a brute-force loop in the test itself (C(45,2)=990 runouts) and assert equality. `equityVsRandom(AsAh, [], 1)` ≈ 0.85 (±0.02 with 20,000 iterations). The river result is 0 or 1 (or a tie). Must run in a browser worker (no Node APIs). Proof: `npx vitest run packages/engine/test/equity.test.ts`.

**E10 collusion.** Owns `src/collusion.ts`, `test/collusion.test.ts`. Heuristics (documented in the file header):
- **chipDumping**: a "strong fold" is when player A folds on the turn or river to a bet/raise from B, where A's hole + board at that moment beats B's at that moment (evaluate7 on the cards available, using `record.hole`) and the pot ≥ 10 BB. Flag the pair if strong folds A→B ≥ 3 in the records, **or** the net chips flowing A→B in hands only they contested postflop ≥ 50 BB with ≥ 2 strong folds. Score = strongFolds + netBB/50.
- **softPlay**: for each pair, postflop aggression ratio (bets + raises) / (calls + checks) in heads-up postflop pots against each other vs. against everyone else. Flag when ≥ 15 such heads-up hands and ratio_vs_each_other < 0.25 × min(ratio_vs_others of each). Score = 1 − ratio quotient.
- `sharedNetwork`: any two different players with the same ip → `sharedIp`; same deviceId ≠ 'unknown' → `sharedDevice`. Score 1.
- Players are always reported sorted, so the pair key is stable. The evidence is a list of hand ids (max 20).
Tests: synthetic records built with a small builder in the test (one with 3 strong folds → flagged; normal play → no flags; soft-play pattern → flagged; 14 hands → not flagged). Proof: `npx vitest run packages/engine/test/collusion.test.ts`.

**E11 stats.** Owns `src/stats.ts`, `test/stats.test.ts`. VPIP = voluntarily put money in preflop (call/bet/raise, not blinds) / hands dealt; PFR = preflop raise / hands; AF = (bets + raises) / calls postflop; with zero calls AF = bets + raises (documented in the file); WTSD = went to showdown / saw flop; wonAtShowdown = won ≥1 pot at showdown / showdowns; netChips = sum(stack end − stack start). Tests with 5 hand-built records. Proof: `npx vitest run packages/engine/test/stats.test.ts`.

Parallel: E7, E8, E10, E11 together. They use only checkpoint-1 modules. E10's test builder makes `HandRecord`s by hand, so it does not need E7.

### Checkpoint 3: Server foundation (parallel)

Before this checkpoint the lead runs the DB setup in "How to run it → Database" once.

**S1 Database.** Owns `apps/server/migrations/001_init.sql` (I-4 verbatim), `apps/server/src/db/pool.ts` (`makePool(url)`), `apps/server/src/db/migrate.ts` (applies `migrations/*.sql` in name order inside a transaction, records each in `schema_migrations`, idempotent; CLI entry `npm run db:migrate -w @poker/server`), `apps/server/src/test/helpers.ts` (I-5), `apps/server/test/migrate.test.ts`. Test: migrating twice is a no-op; all tables exist. Pitfall: `testDb` must set `search_path` on **every** pool connection (`pool.on('connect', c => c.query('set search_path to ...'))`) and `create extension pgcrypto` must be in `public` (create it once in setup, not per schema). Proof: `npx vitest run apps/server/test/migrate.test.ts`.

**S2 App shell + sessions.** Owns `apps/server/src/app.ts`, `apps/server/src/auth/session.ts`, stubs that later tasks replace: `apps/server/src/wallet/ledger.ts` (exports I-5/S7 signatures, bodies throw), `apps/server/src/notify.ts` (S10 signatures), `apps/server/src/realtime/hostControls.ts` (S17 signature), `apps/server/src/games/scheduler.ts` (`startScheduler` returns a no-op stop function), `apps/server/src/games/tournament.ts` (S16 class, methods throw), `apps/server/src/routes/{auth,profile,friends,notes,wallet,games,history,stats,integrity,notifications}.ts` (empty plugins, except `routes/health` inline in app.ts: `GET /api/health → { ok: true }`), `apps/server/src/types.d.ts` (Fastify `req.user` augmentation), `apps/server/test/app.test.ts`. Security headers: set `x-content-type-options: nosniff`, `referrer-policy: same-origin`, and a CSP on API responses. CSRF: an `onRequest` hook rejects state-changing requests (POST/PUT/PATCH/DELETE) whose `Origin` header is present and not `config.publicOrigin`. Rate limit: global 300 req/min per IP, 10/min on `/api/auth/*` (set in auth.ts later via route config, so wire the plugin with `global: true` here). Tests: health 200; a POST with a foreign Origin gets 403; `requireUser` without a cookie gets 401 (mount a test route in the test). Proof: `npx vitest run apps/server/test/app.test.ts`.

S1 ∥ S2: S2's test uses `testDb()` from S1. Its sub-agent writes against I-5 and may run its test only after S1 lands; the lead runs both in the checkpoint check.

### Checkpoint 4: Accounts, social, wallet (REST; all parallel)

Each task owns `apps/server/src/routes/<name>.ts`, any `apps/server/src/<name>/*.ts` helper it lists, and `apps/server/test/<name>.test.ts`. Tests use `buildApp` + `app.inject` + `testDb()`.

**S3 auth.** `routes/auth.ts`: `POST /api/auth/register {email, password (≥10 chars), displayName}`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. argon2id hashing. Registration grants 10,000 chips by calling `grant` from `../wallet/ledger.js` (S7 implements it; S2 creates its stub). In this task's own test, mock `grant` with `vi.mock`; the real wallet row is proved in the checkpoint check. Login errors are generic ("Invalid email or password"). Route-level rate limit 10/min. Proof: `npx vitest run apps/server/test/auth.test.ts`.

**S4 profile + avatars.** `routes/profile.ts`, `src/storage/avatars.ts`. `GET /api/users/:id` (public profile: name, avatarUrl), `PATCH /api/profile {displayName}`, `POST /api/profile/avatar` (multipart, limit 1 MB, check magic bytes for PNG/JPEG/WebP, store as `<userId>-<random>.<ext>` in `AVATAR_DIR`, delete the old file), served at `/avatars/*` by @fastify/static with `cache-control: public, max-age=86400`. Without an avatar, `avatarUrl` = `/api/users/:id/avatar.svg`, a generated SVG with initials and a colour from the user id hash (escape the initials). Tests: upload a tiny PNG, reject a `.png` file containing HTML, reject 1.1 MB. Proof: `npx vitest run apps/server/test/profile.test.ts`.

**S5 friends.** `routes/friends.ts`. `GET /api/friends` (accepted + incoming + outgoing), `POST /api/friends/requests {email | userId}`, `POST /api/friends/requests/:userId/accept|decline`, `DELETE /api/friends/:userId`. A reverse pending request auto-accepts. Creates a `friendRequest` notification row (S10's notifications route reads it; you insert directly into `notifications`). Tests cover the whole lifecycle and that you cannot friend yourself. Proof: `npx vitest run apps/server/test/friends.test.ts`.

**S6 notes.** `routes/notes.ts`. `GET /api/notes` (my notes), `GET /api/notes/:subjectId`, `PUT /api/notes/:subjectId {text, color}`, `DELETE`. Only the author's own notes are ever returned. Test: user B cannot read A's note on C (it returns B's own empty note). Proof: `npx vitest run apps/server/test/notes.test.ts`.

**S7 wallet + ledger.** `routes/wallet.ts`, `src/wallet/ledger.ts`. `ledger.ts`: `ensureAccount(client, kind, userId?, gameId?)`, `transfer(client, fromAcct, toAcct, amount, reason)` (in a transaction; locks both accounts in id order to avoid deadlock; rejects if the source is a wallet/table and its balance < amount), `grant(pool, userId, amount, reason)` (bank → wallet), `balance(client, acct)`, `buyIn(pool, userId, gameId, amount)` (wallet → table), `cashOut(pool, userId, gameId, amount)` (table → wallet). Routes: `GET /api/wallet` (balance + last 50 entries), `POST /api/games/:id/grant {userId, amount}` (host only, max 1,000,000 per call). Tests: concurrency (20 parallel buy-ins of 1,000 from a 10,000 wallet: exactly 10 succeed), sum of all entries == 0, no negative balances. Proof: `npx vitest run apps/server/test/wallet.test.ts`.

**S10 notifications.** `routes/notifications.ts`, `src/notify.ts` (`notify(pool, userId, kind, text, link)` inserts and calls an optional emitter registered by the socket layer later: `setNotifyEmitter(fn)`). `GET /api/notifications`, `POST /api/notifications/:id/read`. Proof: `npx vitest run apps/server/test/notifications.test.ts`.

Parallel: S3–S7 and S10 all at once (separate files). S3 depends on S7's `grant` and S5 writes notifications rows directly, so both are proved together in the checkpoint check.

### Checkpoint 5: Real-time table (parallel)

**S8 TableManager.** Owns `apps/server/src/realtime/tableManager.ts`, `apps/server/test/tableManager.test.ts`. Responsibilities:
- `open(gameId)` loads the game and its settings; status `open`.
- `sit` checks the user is host or invited (AC1). If `seatApproval` is on and the user is not the host, it queues a request instead of seating. It checks the seat is free, the user is not already seated (AC8), and `minBuyIn ≤ buyIn ≤ maxBuyIn` (cash) or buyIn = startingStack (tournament, debited at the game's buy-in price = startingStack), then calls `ledger.buyIn`.
- Hand loop: when ≥ 2 seated with chips and status running, generate `serverSeed` (if none pending), emit `hand:commitment` to the room, wait up to 2,000 ms for `table:clientSeed` from each seated player (missing = skip), `deckFromSeeds`, `nextButton`, `startHand`. Fill `handStarted.commitment` and `cardCommitments` (per F1). Emit `cardProof` for each card to exactly the viewers entitled to it. On `handEnded`, fill `clientSeeds` and `nextCommitment` (generate the next seed now). Keep the server seeds in the `hand_seeds` table (F1) and reveal them only when the game finishes.
- Redaction: a pure function `redact(event, viewerSeat)` exported from the same file. `dealHole` for other seats → `cards: []`. Everything else passes through. The engine never puts hole cards anywhere else, except `showCards` which is public.
- Emits each event per socket via `emitTo(userId, 'hand:event', redact(...))`. Spectators (host not seated) get the viewerSeat=null view.
- All-in equity: when `allInRunout(state)` becomes true and ≥ 2 players remain, emit `showCards` for each, then an `equity` event per street via `equityExact` (preflop with a fixed-seed rand for 50k samples) before each board card is dealt, pacing streets 1,500 ms apart so the UI can animate.
- Timers: on `toAct`, set `deadline = now + turnSeconds*1000` and emit `table:clock`. When it fires, if `timeBankMs > 0`, switch to the time bank (`usingTimeBank: true`, new deadline = now + timeBankMs) and emit `table:clock`. When that fires, apply `timeoutAction` with `auto: 'timeout'` and set timeBankMs to 0. Time bank used is deducted by actual elapsed time. Top-up: `+timeBankTopUpSeconds` every 100 hands (cash) or each new level (tournament), capped at `timeBankSeconds`.
- Disconnected players keep their timers (no extra time).
- Host changes (`updateSettings`) are stored and applied at the next `startHand` (AC15). Pause takes effect after the current hand. Kick folds the player at their next turn and cashes them out after the hand.
- Persistence: on hand end, insert `hands` (full `HandRecord`) and `hand_players` (net per user) in one transaction. Cash-out on leave (table → wallet, full stack). After each hand, run `collusion.analyse` over the game's records and upsert `integrity_flags`; for new flags, `notify` the host (`integrityFlag`). Every 25 hands is fine if analysis takes > 50 ms; log the timing.
- Tournament mode delegates level/elimination/payout logic to `TournamentController` (S16) through the interface `{ levelFor(now): BlindLevel; onHandEnded(stacks): { eliminated: {userId, place}[]; finished: boolean } }`. Use a fake in your tests.
Tests (fake clock, fake emit): 3 users play 200 random hands to completion with conservation of chips across table + wallets; a non-invited user cannot sit; a user cannot take two seats; a spectator never receives non-empty `dealHole` for any seat; the timeout path checks when it can, otherwise folds, after turn+bank; a settings change mid-hand applies next hand; `verifyDeck` passes for every recorded hand. Pitfall: never `await` inside the critical section of applying an action. Serialize per-table work with a simple promise queue so two fast actions cannot interleave. Proof: `npx vitest run apps/server/test/tableManager.test.ts`.

**S12 Socket layer.** Owns `apps/server/src/realtime/socket.ts`, `apps/server/src/main.ts` (now wires: migrate on start, `buildApp`, a real `TableManager`, `app.decorate('tables', manager)`, `attachSockets`, `setNotifyEmitter` (emits `notify` to room `user:<id>`), and `startScheduler({ pool, clock: Date.now, setTimer: setTimeout, tables: manager, notify })`), `apps/server/test/socket.test.ts`. Auth in `io.use`: parse the `sid` cookie with `userFromCookieHeader`, reject without it. Check the `Origin` handshake header against `publicOrigin`. Each user joins room `user:<id>`; `table:join` joins room `game:<id>` after the invite check. Every inbound payload is parsed with the protocol schema; invalid → `error` event, no action. Per-socket token bucket: 10 table actions/s, chat 5 per 10 s (AC12). Store chat in `chat_messages`, and include the last 50 in `TableView`. Disconnect marks the seat disconnected (TableManager method `setConnected`). Test: start a real server on a random port with `testDb()`, connect `socket.io-client` with cookies from `authed()`, and assert: unauthenticated connect fails; invalid payload gets `error`; the 6th chat message within 10 s is rejected; chat reaches the room. Use a fake TableManager in this test. Proof: `npx vitest run apps/server/test/socket.test.ts`.

**S13 integration bots.** Owns `apps/server/test/integration.table.test.ts`, `apps/server/test/bots.ts`. Bots are socket.io-client users who register via REST, befriend the host, accept an invite (insert invite rows directly), sit, send client seeds, and act randomly within `legal`. Scenario: 3 bots play 30 hands on the real server (real TableManager + sockets + DB). Assert: every bot sees others' hole cards only in `showCards`; the final stacks + wallets equal initial wallets; every hand's revealed seed verifies (`verifyDeck`) against the commitment received **before** that hand's `handStarted`; one bot that never acts is auto-folded/checked within turn+bank time (use `turnSeconds: 5, timeBankSeconds: 0` for speed). Proof: `npx vitest run apps/server/test/integration.table.test.ts`.

Parallel: S8, S12, S13. S13's file depends on both, so its sub-agent writes it against I-3/I-5 and the lead runs it in the checkpoint check. If it fails because of S8/S12, that goes back to their owner.

### Checkpoint 6: Games, tournaments, host, history, stats, integrity (server; parallel)

**S14 games routes.** Owns `routes/games.ts`, `test/games.test.ts`. `POST /api/games {name, startsAt, settings}` (validated by `GameSettingsSchema` from protocol; startsAt ≥ now − 5 min), `GET /api/games` (games I host or am invited to), `GET /api/games/:id` (403 if not host/invited, AC1), `PATCH /api/games/:id/settings` (host only; stores the settings and, if the table is live, calls `app.tables.host(id, userId, { kind: 'updateSettings', settings })`. `app.tables` is decorated in `main.ts` by S12; in tests, decorate a fake), `POST /api/games/:id/invites {userIds}` (friends only, else 400), `POST /api/games/:id/rsvp {rsvp}`, `GET /api/games/:id/calendar.ics` (via `ics`), `POST /api/games/:id/cancel`, `GET /api/games/:id/settlement` (net per F2; uses `settle`; host and players only). Proof: `npx vitest run apps/server/test/games.test.ts`.

**S15 scheduler.** Owns `apps/server/src/games/scheduler.ts`, `test/scheduler.test.ts`. A `startScheduler({ pool, clock, setTimer, tables, notify })` loop every 15 s: games with `status='scheduled'` and `starts_at ≤ now + 10 min` get a one-time "starting in 10 minutes" notification (track it in memory and use an idempotent `notifications` check by link+kind); at `starts_at`, `tables.open(id)`, set status `open`, notify RSVP yes/maybe. Proof: `npx vitest run apps/server/test/scheduler.test.ts`.

**S16 tournament controller.** Owns `apps/server/src/games/tournament.ts`, `test/tournament.test.ts`. Implements the interface from S8 plus a `prizes(prizePool, payouts, finishOrder)`. Places: a player who reaches 0 chips is eliminated. Players busting in the same hand are placed by starting stack of that hand (bigger = better place); equal stacks share the places and split those prizes (integer, remainder to the better place). Rebuys allowed while `level ≤ untilLevel` (debit the wallet the buy-in, add a stack). The prize pool = all buy-ins + rebuys. Insert `tournament_results` at the end. Levels follow `levelAt` with paused time excluded. Proof: `npx vitest run apps/server/test/tournament.test.ts`.

**S17 host controls.** Owns `apps/server/src/realtime/hostControls.ts`, `test/hostControls.test.ts`. A pure function `applyHostCommand(settings, status, cmd, actor, hostId) → { settings, status, effects: ('kick'|'pause'|'resume'|'approve'|'reject')[] } | { error }`, used by TableManager.host. Validates with `GameSettingsSchema.partial()`; rejects changes to `kind` and `maxSeats` after the game starts; rejects non-hosts. S2 created this file as a stub in checkpoint 3, and S8's `host()` already calls `applyHostCommand` from `./hostControls.js` (S8's tests mock it). This task replaces the stub with the real function and its tests. Proof: `npx vitest run apps/server/test/hostControls.test.ts`.

**S19 history routes.** Owns `routes/history.ts`, `test/history.test.ts`. `GET /api/hands?gameId=&limit=50&before=` (hands where I played or I am host), `GET /api/hands/:id` returns the record **redacted for the viewer**: `hole` contains only the viewer's own seat; `dealHole` events are redacted like live play; `showCards` stay. Even the host does not see folded cards (AC14 + AC8). Never return `record.hole` fully. Test: player B fetching a hand where A folded gets no A cards. Proof: `npx vitest run apps/server/test/history.test.ts`.

**S20 stats routes.** Owns `routes/stats.ts`, `test/stats.routes.test.ts`. `GET /api/stats/:userId` (self or accepted friend only): `computeStats` over that user's hands in games where the viewer also played or hosted, plus all of the user's hands if the viewer is the user; also tournaments won from `tournament_results`. Proof: `npx vitest run apps/server/test/stats.routes.test.ts`.

**S18 integrity.** Owns `routes/integrity.ts`, `test/integrity.test.ts`. `GET /api/games/:id/integrity` (host only): stored flags + live `sharedNetwork` over the sessions of the seated players (ip, device_id from `sessions` rows created at their latest login). `POST /api/games/:id/integrity/run` re-runs `analyse` over all hands. Proof: `npx vitest run apps/server/test/integrity.test.ts`.

Parallel: S14, S15, S16, S17, S18, S19, S20 all at once.

### Checkpoint 7: Web foundation (parallel)

All web tasks: own the listed files under `apps/web/src/` and their tests `apps/web/test/*.test.ts(x)` (Vitest + jsdom + @testing-library/react; pin versions with `npm view` at task time; S0.1 does not add testing-library, so **W1 adds it** to `apps/web/package.json`; no other CP7 task edits package.json; anything else they need goes back to the lead to add to the plan).

**W1 API + socket clients + shell.** Owns `apps/web/package.json` (deps only), `src/api/client.ts` (fetch wrapper, JSON, throws `ApiError {status, message}`, sends `x-device-id` from localStorage, credentials 'include'), `src/api/socket.ts` (typed `io()` from `socket.io-client` with `ClientEvents/ServerEvents`, reconnect, re-join tables on reconnect), `src/api/useMe.ts` (current user, redirect to /login on 401), `src/ui/Shell.tsx` (nav bar: Lobby, Friends, History, Wallet, Profile; notification bell with unread count from `notify` + REST), `src/ui/theme.css` (CSS variables, dark felt green/charcoal palette, 8 px spacing, focus rings, `prefers-reduced-motion` respected by the tween module), `test/client.test.ts`. Proof: `npx vitest run apps/web/test/client.test.ts`.

**W2 Animation module.** Owns `src/anim/tween.ts`, `src/anim/easing.ts`, `test/tween.test.ts`. Easing functions satisfy f(0)=0, f(1)=1, are monotonic for the in-out/out curves (`easeOutBack` may overshoot ≤ 10%), and have a near-zero slope at both ends for `easeInOutCubic`. Tween uses timestamps, not frame counts (frame drops cannot cause a jump bigger than the time step). Interrupting a tween with a new target starts from the **current** value (no snapping). With `prefers-reduced-motion`, durations are scaled to 0.3× but still eased. Test with a fake rAF: max per-frame delta ≤ 2 × (distance × frameMs / duration) for easeInOutCubic (its peak velocity is 1.5× average); retargeting mid-flight has no discontinuity; trace records when enabled. Proof: `npx vitest run apps/web/test/tween.test.ts`.

**W3 Auth + profile pages.** Owns `src/pages/Login.tsx`, `src/pages/Profile.tsx`, `test/login.test.tsx`. Login/register toggle, validation messages, avatar upload with preview, display name edit. Page transitions use W2's tween for opacity/translate (8 px rise, 220 ms easeOutCubic). Proof: `npx vitest run apps/web/test/login.test.tsx`.

**W4 Lobby + friends + game detail pages.** Owns `src/pages/Lobby.tsx`, `src/pages/Friends.tsx`, `src/pages/GameDetail.tsx`, `src/ui/SettingsForm.tsx` (host settings editor: kind, seats, blind level table with add/remove rows and a "standard structure" preset generator (levels doubling roughly: 25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600 ... with optional BB ante from level 4), buy-ins, ante kind, timers, rebuys, payouts presets (1: 100; 2: 65/35; 3: 50/30/20), seat approval), `test/settingsForm.test.tsx`. GameDetail shows invites, RSVP buttons, the `.ics` link, "Open table" when open, and (host) a Settings panel using SettingsForm. Validation reuses `GameSettingsSchema`. Proof: `npx vitest run apps/web/test/settingsForm.test.tsx`.

**W-E2E-1.** Owns `e2e/social.spec.ts`. Two browser contexts: register Ana and Ben, Ana sends a friend request, Ben accepts, Ana schedules a cash game 1 minute ahead and invites Ben, Ben RSVPs yes and sees a notification, Ben downloads the `.ics` (response content-type `text/calendar`), a third user Cleo gets 403 on the game URL. Fresh DB: this task owns `e2e/global-setup.ts` too (S0.1 left it a no-op) and makes it drop every non-system schema object by `drop schema public cascade; create schema public; create extension pgcrypto;` on `poker_e2e` as the `poker` role (owner), then run the migrations. The config already points the dev server at `poker_e2e`. Proof: `npm run e2e -- e2e/social.spec.ts`.

Parallel: W1, W2, W3, W4, W-E2E-1. W3/W4 import `api/client.ts` and `anim/tween.ts` via the I-6 interfaces and mock them in their unit tests.

### Checkpoint 8: The table (parallel)

**Read I-11 first: it adds task W0 (runs alone, before the others) and overrides the task text below where they differ.**

**W5 Table scene.** Owns `src/table/Table3D.tsx`, `src/table/layout.ts`, `src/table/Felt.tsx`, `test/layout.test.ts`. A `<Canvas>` with `frameloop="demand"` while idle, switching to `"always"` while any tween runs (`invalidate()` from tweens). Perspective camera at ~35° tilt, fov 40, looking at the table centre. Oval felt with a rim (a lathe or extruded ellipse shape), soft shadow, subtle vignette. Responsive: the camera distance adjusts to the aspect ratio so all 9 seats fit at 390 px wide. Exposes `<Table3D>{children}</Table3D>` plus a `SceneContext` with layout helpers. layout test: 9 seats distinct, viewer seat at bottom centre for every `mySeat`, positions symmetric. Proof: `npx vitest run apps/web/test/layout.test.ts`.

**W6 Cards.** Owns `src/table/Cards.tsx`, `src/table/cardTexture.ts`, `test/cards.anim.test.ts`. Cards are thin rounded boxes with canvas-generated face textures (rank + suit pips, large corner index for readability, four-colour deck option) and a patterned back. Deal: each card travels from `dealerPosition` to the seat along a slight arc (y lift 0.3), 380 ms easeOutCubic, staggered 90 ms, with a slight rotation settle using easeOutBack. Flip: rotate on the y axis 0→π, 300 ms easeInOutCubic. The board is dealt flop as 3 staggered, then turn and river. Folded cards slide toward the muck and fade out. Every motion goes through `tween()` with ids `card:<handId>:<seat>:<i>` so they show in the trace. The test checks the generated keyframes (from/to/duration/ease) for a deal step and that no position is set outside a tween (the component reads position only from tween values). Proof: `npx vitest run apps/web/test/cards.anim.test.ts`.

**W7 Chips.** Owns `src/table/Chips.tsx`, `src/table/chipStacks.ts`, `test/chipStacks.test.ts`. `chipStacks(amount, bigBlind)` breaks an amount into denominations (1, 5, 25, 100, 500, 1k, 5k, 25k, 100k; colours white/red/green/black/purple/yellow/pink/blue/grey) giving ≤ 6 stacks of ≤ 10 chips each. Bets slide from the seat to `betPosition` (300 ms easeOutCubic); collect slides bets into the pot (450 ms easeInOutCubic) at street end; award slides the pot to the winner (600 ms easeInOutCubic, split pots fan out); uncalled return slides back. The amount label next to each stack counts up/down with the same tween. Proof: `npx vitest run apps/web/test/chipStacks.test.ts`.

**W8 Seat HUD + turn indicator.** Owns `src/table/SeatHud.tsx`, `src/table/TurnRing.tsx`, `test/seatHud.test.tsx`. drei `<Html>` anchored at `seatPosition`: a round avatar (img with alt = name, fallback initials SVG), name, stack, a "D" button marker that tweens between seats, the equity badge (`myEquity` for my seat: "Win 63%" updating each street; `allInEquity` for all seats during an all-in runout) and status chips (Folded, All-in, Away). Notes: clicking a seat opens `NotesPopover` (W10). TurnRing: an SVG ring around the active avatar with `data-testid="turn-ring"` that drains with the deadline (draws with a CSS transform driven by the tween clock), turns amber at 5 s and red at the time bank, with a gentle glow pulse (opacity tween 1.2 s loop, easeInOutSine) and the seat scaling to 1.06 with easeOutBack when it becomes active. Exactly one seat has `data-active="true"`. Accessibility: `aria-live="polite"` announcement "Your turn" when it's mine. Test: given a store with `toAct=3`, only seat 3 has `data-active="true"` and the ring; equity badge only on my seat when not all-in, on all seats when all-in. Proof: `npx vitest run apps/web/test/seatHud.test.tsx`.

**W9 Action bar.** Owns `src/table/ActionBar.tsx`, `test/actionBar.test.tsx`. Buttons Fold / Check or Call N / Bet or Raise to N, a slider + numeric input bounded by `legal.minTo..maxTo`, presets (½ pot, ¾ pot, pot, all-in) clamped to the bounds, keyboard shortcuts F / C / R / Enter, disabled when not my turn, "Use time bank" button while my turn is running, and pre-actions ("Check/Fold", "Call any") when not my turn. The bar slides up with easeOutCubic 200 ms when it becomes my turn. Sends `table:action` with `handId`. Test: buttons and bounds from various `legal` objects; it never sends an amount outside bounds. Proof: `npx vitest run apps/web/test/actionBar.test.tsx`.

**W10 Chat + notes.** Owns `src/table/ChatPanel.tsx`, `src/table/NotesPopover.tsx`, `test/chat.test.tsx`. Chat: text only (React escapes, never `dangerouslySetInnerHTML`), new messages slide in, auto-scroll unless the user scrolled up, 200 char counter, shows the rate-limit error. Notes popover: textarea + colour tags, autosaves via `PUT /api/notes/:id` debounced 600 ms; the colour tag shows as a dot on the seat (read from a notes map exposed by the popover module: `useNotes()`). Proof: `npx vitest run apps/web/test/chat.test.tsx`.

**W11 Table store + page.** Owns `src/table/useTableStore.ts`, `src/pages/TablePage.tsx`, `src/table/verify.ts`, `test/tableStore.test.ts`. The store applies `table:view`, `hand:event`, `table:clock`, `table:status`, `chat:message` and `hand:commitment` (on commitment: generate `newClientSeed()` and emit `table:clientSeed`; store the commitment). Event → AnimStep mapping per I-6. Numbers update on consume, and the queue is processed in order with no overlap for the same object. Own equity: on `dealHole` for me and on each `street`, post `{hole, board, opponents}` to the equity worker (W12) and set `myEquity` (hide it when I folded). On `equity` events set `allInEquity`. `verify.ts`: on each `cardProof`, check `sha256(salt + ':' + position + ':' + card) === cardCommitments[position]` and that the position matches the deal-order map (F10). On `handEnded`, show "✓ Cards verified" in the hand log if every received card checked out, else a red warning. After the game ends, the Game page offers "Verify whole game", which fetches the revealed seeds (F1) and runs `verifyDeck` and the card commitments for every hand. TablePage composes Table3D + Cards + Chips + SeatHud + TurnRing + ActionBar + ChatPanel, plus `<HostPanel gameId />` when the viewer is the host, a sit-down dialog (seat, buy-in slider within limits), a leave button, a hand log, and a status banner (waiting / paused / level x, next level in mm:ss). Test: feeding a recorded event sequence gives the expected queue and final numbers, and numbers do not change before consume. Proof: `npx vitest run apps/web/test/tableStore.test.ts`.

**W12 Equity worker.** Owns `src/workers/equity.worker.ts`, `src/workers/useEquity.ts`, `test/equity.worker.test.ts`. Runs `equityVsRandom` with 4,000 iterations, then refines to 20,000 and posts again; the latest request cancels older ones. Proof: `npx vitest run apps/web/test/equity.worker.test.ts`.

**W-E2E-2.** Owns `e2e/table.spec.ts`. Fresh DB; Ana hosts a cash game starting now, invites Ben and Cleo; all three sit in three contexts with `window.__POKER_TRACE__ = true` (`addInitScript`). Play one full hand by clicking buttons (preflop calls, flop/turn/river checks). Assert:
(a) the avatar img is visible at each occupied seat;
(b) each player sees their own two cards face up (`data-testid="my-hole"` with 2 card labels) and others face down;
(c) exactly one `[data-active="true"]` at any moment while waiting for an action, and it is the player whose ActionBar is enabled;
(d) the "Win nn%" badge is visible on my seat only;
(e) after the hand, `window.__animTrace` holds deal/bet/collect/award tweens, and for each tween id the samples' max |Δ| between consecutive frames ≤ 2.5 × (|to − from| × 16.7 / duration) + ε, the first sample within 5% of `from` and the last equal to `to`;
(f) the stacks shown sum to the total bought in;
(g) the hand log shows "✓ Cards verified".
Second test: an all-in preflop between two players shows equity badges on both seats before the flop. Proof: `npm run e2e -- e2e/table.spec.ts`.

Parallel: W5–W12 and W-E2E-2 at once. Components depend only on I-6 store selectors and the tween API. Each unit test uses a hand-built store state.

### Checkpoint 9: History, replayer, host panel, wallet, settlement, stats, integrity UI (parallel)

**W13 History + replayer.** Owns `src/pages/History.tsx`, `src/pages/HandReplay.tsx`, `src/replayer/useReplay.ts`, `test/replay.test.ts`. The list groups hands by game with date, pot size, my net and the winning hand. The replayer loads `GET /api/hands/:id`, feeds the events into a separate instance of the table store from `createTableStore()` (W11 exports it, see I-6), and renders `<Table3D>` with the same Cards/Chips/SeatHud components. Controls: play/pause, step back/forward (back rebuilds from the start up to step−1 with animations disabled, then animates the last step), speed 0.5×/1×/2×/4×, a scrubber, and a list of actions with the current step highlighted. All-in equity shown from recorded `equity` events. Test: stepping forward/back produces the same store state as applying N events. Proof: `npx vitest run apps/web/test/replay.test.ts`.

**W14 Host panel.** Owns `src/pages/HostPanel.tsx`, `test/hostPanel.test.tsx`. A slide-over inside TablePage. W11's TablePage renders `<HostPanel gameId={id} />` when the viewer is the host; S0.1 created `HostPanel.tsx` as a stub so this compiles at checkpoint 8. Shows the live level and time to the next level, pause/resume, seat requests approve/reject, kick, an edit-settings form (reuse `SettingsForm` from W4) with a "takes effect next hand" note, a chip grant form, and an integrity flags list (from `/api/games/:id/integrity`) with evidence hand links to the replayer. Proof: `npx vitest run apps/web/test/hostPanel.test.tsx`.

**W15 Wallet + settlement.** Owns `src/pages/Wallet.tsx`, `src/pages/Settlement.tsx`, `test/settlement.page.test.tsx`. Wallet: the balance in play dollars with a count-up tween, the ledger list, and the banner "Play money: these dollars cannot be bought, sold or withdrawn." Settlement: a table of nets in play dollars, the transfers list ("Ben owes Ana $1,250"), a copy-to-clipboard text, and the notice "Play money only. Settle any real-money arrangements among yourselves, outside this app." Proof: `npx vitest run apps/web/test/settlement.page.test.tsx`.

**W16 Stats page.** Owns `src/pages/Stats.tsx`, `test/stats.page.test.tsx`. Shows the friend's stats with plain-language labels and tooltips explaining VPIP/PFR/AF/WTSD, plus a link to shared hands. Proof: `npx vitest run apps/web/test/stats.page.test.tsx`.

**W-E2E-3.** Owns `e2e/history.spec.ts`, `e2e/tournament.spec.ts`. History: after the table spec's hand, Ben opens History, replays the hand, steps through all events, and the board shows 5 cards; Ben never sees Cleo's folded cards. Tournament: host creates a 3-player tournament with `turnSeconds: 5`, starting stack 1,500, levels 2 minutes, payouts 65/35; the players go all-in each hand via the UI until finished; the results page shows places 1–3 and prizes; Settlement shows transfers summing to 0. Proof: `npm run e2e -- e2e/history.spec.ts e2e/tournament.spec.ts`.

Parallel: W13, W14, W15, W16, W-E2E-3.

### Checkpoint 10: Ship it (parallel)

**D1 README.** Owns `README.md` (in `poker/`): what it is, setup, the commands from "How to run it", architecture diagram (ASCII), fairness explanation (commit-reveal and how to verify), the integrity heuristics and their limits (cannot detect ghosting or out-of-band communication), and a money disclaimer.

**D2 Seed script.** Owns `apps/server/src/scripts/seed.ts`, `apps/server/test/seed.test.ts`: creates the demo users ana/ben/cleo/dan (password `pokerpoker1`), friendships and one scheduled game. Idempotent. Script `npm run seed -w @poker/server`. Proof: `npx vitest run apps/server/test/seed.test.ts`.

**D3 CI workflow.** Owns `/.github/workflows/poker.yml`: on push/PR touching `poker/**`, an ubuntu-latest Postgres 16 service, Node 22, `npm ci`, lint, typecheck, test, `npx playwright install --with-deps chromium` (fine on GitHub runners, **not** in this container), e2e. Pitfall: pushing workflow files may be refused if the GitHub token lacks the `workflow` scope. If the push is refused, the lead removes the file in a new commit, records it under Progress, and tells the user to add it by hand.

Parallel: D1, D2, D3.

---

## Checkpoints

| # | Delivers (works on its own) | Check (the lead runs it; all must pass) |
|---|---|---|
| 0 | Empty but working workspace; slideshow unaffected | `cd poker && npm ci && npm run lint && npm run typecheck && npx vitest run --passWithNoTests && npm run e2e`, plus the S0.2 proof from the repo root |
| 1 | Cards, fair shuffle, evaluator, pots, blinds, settlement, protocol schemas | `npm run lint && npm run typecheck && npx vitest run --project engine --project protocol` (amended at checkpoint 1: the bare filter `packages` matches no test file in Vitest 5) |
| 2 | Complete headless poker engine with equity, stats, collusion | `npm run lint && npm run typecheck && npx vitest run --project engine --project protocol` (includes the 2,000-hand simulation) |
| 3 | Server boots, migrates, health, sessions, CSRF | `npx vitest run apps/server && npm run db:migrate -w @poker/server && (npm run dev -w @poker/server & sleep 5; curl -sf localhost:3001/api/health; kill %1)` |
| 4 | REST: accounts, avatars, friends, notes, wallet, notifications | `npm run lint && npm run typecheck && npx vitest run apps/server` |
| 5 | Bots can play full hands over sockets with timers, fairness and redaction | `npx vitest run apps/server` (includes `integration.table.test.ts`) |
| 6 | Scheduling, tournaments, host controls, history, stats, integrity APIs | `npm run lint && npm run typecheck && npx vitest run` |
| 7 | Web: log in, friends, schedule/RSVP | `npx vitest run apps/web && npm run e2e -- e2e/smoke.spec.ts e2e/social.spec.ts` |
| 8 | Playable animated 3D table in the browser | `npx vitest run && npm run e2e -- e2e/table.spec.ts` + screenshots (see Proof, manual) |
| 9 | History/replayer, host panel, wallet, settlement, stats; tournament end to end | `npm run lint && npm run typecheck && npx vitest run && npm run e2e` |
| 10 | Docs, seed data, CI | All "whole-build checks" + the manual walkthrough |

Each checkpoint: run its check → fix until green → check the real files (not reports) → mutation checks for tests written in it → commit → record under Progress.

---

## How to run it

(Instructions for the session that runs the plan.)

1. **Read this whole plan first**, including "Review findings" at the end, which override earlier text where they conflict.
2. **You are the lead. You write no code.** Your jobs: dispatch sub-agents, run checks, review files, do mutation checks, commit, update this plan.
   **Models (user decision, 2026-11-24):** the lead session runs on **Fable** (`claude-fable-5-2`; start the session with that model, e.g. `/model` before saying "Run the plan"). The lead makes the big decisions: interpreting the plan, resolving deviations and questions, deciding fixes when a check fails, and amending this plan. Every sub-agent is started with the Agent tool's `model: "opus"` and does all the building, testing and file editing. If the lead is not running on Fable, it says so to the user before starting checkpoint work.
3. **Environment:** run every session for this plan on the cloud environment **"Poker App"** (personal), not "My apps (cloud)", which is shared with other apps. Its setup script starts Postgres, creates the databases below, and runs `npm ci` in `poker/`. If the setup script did not run (`pg_lsclusters` shows `down`), run the commands below by hand.
   **Database (once, before checkpoint 0; see F23):**
   ```bash
   pg_ctlcluster 16 main start
   su postgres -c "psql -c \"create role poker login password 'poker' createdb\""
   su postgres -c "createdb -O poker poker_dev" && su postgres -c "createdb -O poker poker_test" && su postgres -c "createdb -O poker poker_e2e"
   su postgres -c "psql -d poker_test -c 'create extension if not exists pgcrypto'"
   su postgres -c "psql -d poker_dev -c 'create extension if not exists pgcrypto'"
   su postgres -c "psql -d poker_e2e -c 'create extension if not exists pgcrypto'"
   ```
   Tests use `DATABASE_URL=postgres://poker:poker@localhost:5432/poker_test` (set in `vitest.config.ts` env for the server project). If the container restarted, run `pg_ctlcluster 16 main start` again.
4. **At the start of each checkpoint**, start one sub-agent per task in that checkpoint, **all in one message** so they run in parallel. Pass `model: "opus"` on every one. Each brief contains, and only contains:
   - the task id and its full text copied from this plan;
   - the exact list of files it may create or edit (and "edit no other file");
   - the interfaces it codes against (paste the relevant I-x blocks);
   - the bar: its proof command passes, `npm run lint` and `npm run typecheck` have no errors in its files, no `any` without a comment, no skipped tests;
   - "Do not run git. Do not install Playwright browsers. Do not edit this plan.";
   - the report format: `FILES: <list>` / `PROOF: <command> → <pass/fail + last 20 lines>` / `DEVIATIONS: <anything differing from the plan, or none>` / `QUESTIONS: <or none>`.
5. **When all sub-agents report**, run the checkpoint check yourself. Read the diff (`git diff --stat` and the files) and compare with the plan. Anything that doesn't match goes back to the same sub-agent (continue it with SendMessage), or to a fresh one with the same brief plus the problem. Never accept a report on trust.
6. **Anything not in the plan** (a new file, a changed interface, a new dependency) is written into this plan first, under the relevant task and noted in Progress, and only then built.
7. **Mutation checks** (see Proof): for each test written in this checkpoint that proves an acceptance criterion, make the listed one-line change, run that test, confirm it fails, then undo with the exact reverse edit (Edit tool, old/new swapped). Never `git checkout`/`git restore`/`git stash` to undo.
8. **Commit** when everything passes: `git add poker _config.yml .github` (only what changed) and `git commit -m "poker: checkpoint N — <summary>"` with the attribution lines the session gives you. Push with `git push -u origin ccr-f5339883-mfcgzv`, retrying up to 4 times on network errors.
9. **Record** under Progress: checkpoint, date, commit hash, check output summary (pass counts), mutation results, deviations.
10. **Context:** after each checkpoint, if your context window is half full or more, write "Next: checkpoint N+1" at the end of Progress, commit, push, and stop. A fresh session continues from this plan.
11. **Never**: skip or `.skip` a test to get green, weaken an assertion without writing the reason into this plan, touch files outside `poker/` except `_config.yml` (S0.2) and `.github/workflows/poker.yml` (D3), or run `playwright install`.

### Commands (from `poker/`)

| What | Command |
|---|---|
| Install | `npm ci` |
| Lint | `npm run lint` |
| Types | `npm run typecheck` |
| Unit + integration | `npx vitest run` (one file: `npx vitest run <path>`) |
| E2E | `npm run e2e` (one file: `npm run e2e -- e2e/table.spec.ts`) |
| Migrate | `npm run db:migrate -w @poker/server` |
| Dev | `npm run dev` → web http://localhost:5173, API http://localhost:3001 |
| Seed demo | `npm run seed -w @poker/server` |

---

## Proof

### Acceptance criteria → test → mutation that must make it fail

| AC | Test | One-line mutation (must fail the test, then be reversed) |
|---|---|---|
| AC1 | `apps/server/test/games.test.ts` "non-invited user gets 403"; `tableManager.test.ts` "non-invited cannot sit"; `e2e/social.spec.ts` Cleo 403 | In the invite check in `routes/games.ts`, change `if (!isHost && !invited) return reply.code(403)` to `if (false) return reply.code(403)` |
| AC2 | `scheduler.test.ts` "opens table at starts_at and notifies RSVP yes"; `games.test.ts` ".ics"; `e2e/social.spec.ts` | In `scheduler.ts`, change the due condition `startsAt <= now` to `startsAt < now - 3600_000` |
| AC3 | `e2e/table.spec.ts` (a) (b); `seatHud.test.tsx` | In `SeatHud.tsx`, render `<img>` only when `false &&` (avatar missing) |
| AC4 | `apps/web/test/tween.test.ts` max-delta; `e2e/table.spec.ts` (e) | In `tween.ts`, return `to` immediately (`const v = to;` instead of the eased interpolation) |
| AC5 | `seatHud.test.tsx` "only the active seat"; `e2e/table.spec.ts` (c) | In `SeatHud.tsx`, `data-active={seat === toAct}` → `data-active={true}` |
| AC6 | `hand.test.ts` 25 scripted hands; `sim.test.ts` invariants; `pots.test.ts`; `blinds.test.ts` | In `hand.ts`, set the min-raise increment to `bigBlind` instead of the last raise size; separately in `pots.ts`, drop folded chips (`.filter(c => !c.folded)` before summing) |
| AC7 | `rng.test.ts` (a)–(e); `integration.table.test.ts` verify; `e2e/table.spec.ts` (g) | In `rng.ts`, replace the rejection-sampled `j` with `j = x % (i + 1)` **and** use only `x & 0xff` (bias): the chi-square fails. Also `commit` → `sha256(serverSeed + 'x')`: verification fails |
| AC8 | `tableManager.test.ts` spectator redaction + two-seat check; `integration.table.test.ts` no-leak; `socket.test.ts` invalid payload + rate limit; `history.test.ts` no folded cards; `integrity.test.ts` shared IP | In `redact`, return `event` unchanged; separately in `socket.ts`, skip the schema parse (`const p = raw`) |
| AC9 | `collusion.test.ts` chip-dump & soft-play cases; `integrity.test.ts` | In `collusion.ts`, change the strong-fold threshold `>= 3` to `>= 300` |
| AC10 | `tableManager.test.ts` timeout path; `integration.table.test.ts` idle bot | In `tableManager.ts`, skip the time bank (`if (false && timeBankMs > 0)`) → the "uses time bank" assertion fails |
| AC11 | `friends.test.ts`; `stats.test.ts` + `stats.routes.test.ts`; `e2e/social.spec.ts` | In `routes/friends.ts`, accept → set status `'pending'` |
| AC12 | `socket.test.ts` chat broadcast + rate limit; `chat.test.tsx` | In `socket.ts`, chat bucket capacity 5 → 500 |
| AC13 | `notes.test.ts` "B cannot read A's note" | In `routes/notes.ts`, drop `author = $1` from the WHERE clause |
| AC14 | `history.test.ts` redaction; `replay.test.ts`; `e2e/history.spec.ts` | In `useReplay.ts`, step back without rebuilding (`index--` only) → state mismatch |
| AC15 | `hostControls.test.ts`; `tableManager.test.ts` "applies next hand"; `hostPanel.test.tsx` | In `tableManager.ts`, apply `pendingSettings` immediately instead of at `startHand` |
| AC16 | `wallet.test.ts` concurrency + zero-sum + non-negative | In `ledger.ts`, remove `for update` from the balance select |
| AC17 | `settlement.test.ts` (a)–(f); `games.test.ts` settlement nets (F2); `settlement.page.test.tsx`; `e2e/tournament.spec.ts` | In `settlement.ts`, record the transfer as `chips - 1` (`transfers.push({ ..., chips: chips - 1 })`) → the balance property fails. (Amended at checkpoint 1: the original mutation, paying `Math.min(debt, credit) - 1`, makes `settle` loop forever, so the test hangs instead of failing.) |
| AC18 | `tournament.test.ts` places/prizes/levels; `e2e/tournament.spec.ts` | In `tournament.ts`, place ties by seat number instead of starting stack |

Evaluator correctness (supports AC6): mutation `evaluator.ts` treat the wheel as not a straight → the exhaustive count test fails (straight 10,200 → 9,180).

### Whole-build checks (all must pass before "done")

```bash
cd poker
npm ci
npm run lint
npm run typecheck
npx vitest run                 # all unit + integration
npm run e2e                    # all Playwright specs, --trace off is the config default
cd .. && (bundle exec jekyll build --baseurl "." 2>/dev/null && test ! -e _site/poker && echo "slideshow ok, poker excluded") || echo "jekyll not installed: verify _config.yml exclude by the S0.2 proof instead"
```

### Manual walkthrough (real entry point, at checkpoint 8 and again at 10)

Run `npm run dev`, then with Playwright (headless Chromium, three contexts, screenshots at deviceScaleFactor 2 saved to the scratchpad and sent to the user):
1. Register three users with avatars, become friends, and schedule a cash game now.
2. Sit all three. Play 3 hands by hand-driving clicks, including one all-in with a side pot (give one player a short stack).
3. Look at the screenshots and short screen recordings (`recordVideo`) for: cards visibly travelling from the dealer, chips sliding, no flicker or teleport, the ring on the right player, the equity badge only on own seat, both seats' equity during the all-in, side pot labels, the winner's chips sliding.
4. Open the replayer for the side-pot hand and step through it.
5. Open Settlement for the game and check the transfers by hand against the stacks.
6. Normal use still works: logout/login, the slideshow root `index.html` untouched (`git diff --stat -- . ':!poker' ':!_config.yml' ':!.github'` shows nothing).
Record what was seen, with screenshot paths, under Progress.

---

## Review findings

(Filled in by the plan reviewer. Where a finding changes a task, the change is written here and overrides the task text.)

Review run 2026-11-24 by a fresh sub-agent (checked versions with `npm view` and unpacked vitest 5.1.1). It raised 24 findings, listed below with their resolutions. **Each resolution is binding and overrides any task text that conflicts with it.** The tasks named in a resolution own the extra files or work it adds, and checkpoint file ownership still holds.

**F1 (blocker) The seed reveal after each hand leaks folded cards.** The user decided that seeds are revealed when the game ends.
- I-4: add `create table hand_seeds (hand_id uuid primary key references hands on delete cascade, server_seed text not null, salt_key text not null);` in a new migration, `migrations/002_seeds.sql`, owned by S8.
- Per-card commitments: `salt_p = hex(HMAC-SHA256(saltKey, 'salt:' + p))`, where `saltKey` is a separate per-hand CSPRNG value, and `cardCommitments[p] = sha256(salt_p + ':' + p + ':' + deck[p])`.
- E2 adds `cardCommitments(deck, saltKey): string[]`, `cardSalt(saltKey, p)` and `verifyCard(commitment, salt, position, card)`, with tests that include a known-answer vector.
- S8 emits `cardProof` for hole cards only to their owner. For board cards and shown cards it emits to everyone. It never emits for folded cards or burns.
- When a game finishes (status `finished`), `GET /api/games/:id/fairness` (S19, in `routes/history.ts`) returns `{ handId, handNumber, commitment, serverSeed, saltKey, clientSeeds }[]` to the host and players. It returns 409 before the game ends.
- AC14 now reads: "during the game and until it ends, only entitled cards are visible; after the game ends, the published seeds make every deck reconstructable, and the README says so".
- Tests:
  - S19: `fairness` returns 409 while the game is running.
  - S8 and S13: no viewer ever receives a `cardProof` for another seat's unshown hole card.
- AC7 mutation: in `rng.ts`, change `cardCommitments` to hash `deck[p] + 1`. The card-verify test fails.

**F2 (blocker) Settlement nets are wrong.**
- For a cash game, net = sum of `hand_players.net`.
- For a tournament, net = prize − (buy-in + rebuys) × number of entries.
- S14 tests both, plus a case of a player with a rebuy.

**F3 (blocker) Tournament results, rebuys and payouts have no owner.**
- I-3 adds `table:rebuy { gameId }` (P1). The server sends `table:results { gameId, results: { userId, name, place, prize }[] }` when the game finishes (P1).
- S16 pays prizes bank-to-wallet through `ledger.grant`. Buy-ins and rebuys go wallet → `table` account, and at the end the table account is swept to `bank`, so the ledger still sums to 0.
- S16 also adds `GET /api/games/:id/results` in a new file, `routes/results.ts`, registered by S2 as a stub. Add `results` to S2's list of route stubs.
- W15 adds `src/pages/Results.tsx` (route `/results/:gameId`, stub created by S0.1).
- S8 handles `table:rebuy` through the `TournamentController`.

**F4 (blocker) Nothing starts a game.**
- I-3 `HostCommand` adds `{ kind: 'start' }`, valid only in status `open`.
- S17 validates it and S8 moves the status from `open` to `running`.
- Cash games also auto-start when the host has opted in with `settings.autoStart: boolean` (default true). Auto-start begins once ≥ 2 players are seated, after a 5 s countdown.
- E2E specs click "Start game" as the host.
- W14 adds a "Start game" button.

**F5 (should-fix) AC4 is only half proven.**
- W2's `tween()` is the **only** writer of object transforms. Every animated r3f object and HUD element registers through `useTweenedPosition(id)`, which reports its final value each frame into `window.__animTrace` under an `obj:<id>` key, even when no tween is running.
- The W-E2E-2 assertion (e) runs over all `obj:*` series, including seat-change and panel transitions. Consecutive samples must differ by ≤ 2.5 × the frame-normalised average step of the tween active at that moment. A change with no active tween fails.
- Owners: W2 adds `useTweenedPosition`, and W-E2E-2 adds a step that moves to another seat and opens and closes the host panel.

**F6 (should-fix) Cleo's 403 is untestable on a single-page route.** W-E2E-1 asserts that `GET /api/games/:id` returns 403 and that the page shows "You don't have access to this game".

**F7 (should-fix) Shared-IP flags fire for everyone in dev.**
- S2 sets Fastify `trustProxy: config.trustProxy` (env `TRUST_PROXY`, default `loopback`) so `req.ip` takes `x-forwarded-for` from the Vite proxy.
- `sharedNetwork` ignores loopback IPs (`127.0.0.1`, `::1`) for `sharedIp`, so device id checks still apply in dev.
- S8 runs `sharedNetwork` over seated players at each `sit` and stores the flags, as well as running `analyse` after each hand.
- E10 tests the loopback rule.

**F8 (blocker) `vitest.config.ts` no longer exists in Vitest 4+.**
- S0.1 writes a root `vitest.config.ts` with `test.projects`:
  - `engine` and `protocol`: environment node.
  - `server`: node, `env.DATABASE_URL = postgres://poker:poker@localhost:5432/poker_test`, `testTimeout: 30000`, `fileParallelism: true` (each file has its own schema).
  - `web`: jsdom.
- Replace every mention of `vitest.config.ts` with `vitest.config.ts`.

**F9 (should-fix) Dependencies are under-assigned.** S0.1 installs every dependency for every package up front, so later tasks never edit `package.json`. This also overrides W1's testing-library note: S0.1 adds those too. Pins come from "Environment facts", plus these, each with `npm view` at S0.1 time and `--save-exact`:
- root dev: `eslint`, `@eslint/js`, `typescript-eslint`, `globals`, `typescript`, `vitest`, `fast-check`, `@playwright/test@1.63.0`, `npm-run-all2`, `@types/node@22`
- engine: `@noble/hashes`
- protocol: `zod`
- server: `fastify`, `@fastify/cookie`, `@fastify/multipart`, `@fastify/static`, `@fastify/rate-limit`, `socket.io`, `pg`, `argon2`, `ics`, `luxon`, `tsx`
- server dev: `@types/pg`, `@types/luxon`, `socket.io-client`
- web: `react`, `react-dom`, `react-router`, `three`, `@react-three/fiber`, `@react-three/drei`, `zustand`, `socket.io-client`
- web dev: `@types/react`, `@types/react-dom`, `@types/three`, `vite`, `@vitejs/plugin-react`, `jsdom@31.0.1`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`

  A task that needs anything else stops and asks the lead, who adds it to this plan and installs it.

  Added by the lead at checkpoint 3: `zod@4.6.7` as a direct dependency of `@poker/server` (routes validate request bodies; the version matches `@poker/protocol`).

**F10 (should-fix) Interfaces used but never defined.** Add these as binding I-7, written into the briefs:
- **Deal-order map (E7 implements it, E2/W11 use it).** Positions 0..(2n−1) are hole cards, dealt round by round starting left of the button: position `r*n + k` is seat order k's card r. After them, in order, come burn, flop ×3, burn, turn, burn, river. Export `dealPositions(n): { hole: number[][]; burns: number[]; board: number[] }` from `hand.ts`.
- **Component props (CP8):**
  - `<Cards handId seats mySeat />`
  - `<Chips />` (reads the store)
  - `<SeatHud seat />`
  - `<TurnRing seat />`
  - `<ActionBar gameId />`
  - `<ChatPanel gameId />`
  - `<NotesPopover subjectId anchor onClose />`
  - `SceneContext = { maxSeats, mySeat, seatPosition(seat), betPosition(seat), potPosition(i), boardPosition(i), dealerPosition }`

  Each component reads everything else from the store.
- `useEquity(): (req: { hole: Card[]; board: Card[]; opponents: number }) => void`, which writes `myEquity` to the store.
- I-5 `TableManager` adds `setConnected(gameId, userId, connected)`, `pendingSeatRequests(gameId)` and `results(gameId)`. `TableView` adds `seatRequests: { playerId, name }[]` (host only, else []) and `chat` (TableManager reads the last 50 rows from `chat_messages`).
- S2's `types.d.ts` also augments `FastifyInstance` with `tables: TableManager` (a type-only import).

**F11 (should-fix) There is no production path.**
- S0.1 adds root `build` (`vite build` for web) and `start` (`node --import tsx apps/server/src/main.ts`) scripts.
- S12's `main.ts` serves `apps/web/dist` with @fastify/static, with an SPA fallback to `index.html` for non-`/api` GET requests, when `NODE_ENV=production`.
- S2 sets the CSP (`default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'`) on all responses.
- D1 documents `npm run build && NODE_ENV=production npm start`.

**F12 (nit) pgcrypto is unnecessary.**
- Drop `create extension pgcrypto` from I-4 and from the DB setup commands, because `gen_random_uuid()` is built into PG16.
- `testDb` sets `search_path to t_<id>, public`.

**F13 (should-fix) Money and legal risk.** The user decided: play-money dollars only, with no conversion (see "Decisions"). W15 and W1 show the "play money" label. D1's README says the app has no real-money features.

**F14 (should-fix) Session ids are unspecified.**
- The cookie value is 32 CSPRNG bytes (base64url).
- `sessions.id` stores `sha256(value)` as hex.
- A new session is made at every login, and the old cookie's session is deleted.
- Logout deletes the session.
- S2 tests that the stored id differs from the cookie value.

**F15 (should-fix) CSRF and headers.**
- S2's `onRequest` hook also rejects state-changing requests that have `Sec-Fetch-Site: cross-site`, and requests that have neither `Origin` nor `Sec-Fetch-Site` but carry a cookie (non-browser callers use no cookie anyway).
- S4 sets `x-content-type-options: nosniff`, the CSP `default-src 'none'; img-src 'self'; sandbox` and `content-disposition: inline` on `/avatars/*`.

**F16 (nit) Open registration invites sybil chip farming.**
- Registration needs an invite code. Config `REGISTRATION=open|invite` defaults to `invite`; e2e and dev use `open`.
- Any user can create invite codes (`POST /api/invites` in `routes/auth.ts`, owned by S3; table `invite_codes (code text primary key, created_by uuid references users, used_by uuid, created_at timestamptz default now())` in `migrations/003_invites.sql`, owned by S3).
- The signup grant stays at $10,000. The README notes the chip-dumping risk.

**F17 (blocker) The checkpoint 3 check cannot pass.**
- S2 also owns `apps/server/src/main.ts` in checkpoint 3 (boot: migrate, `buildApp`, listen). S12 takes ownership of it in checkpoint 5.
- S0.1 defines server scripts: `dev` = `tsx watch src/main.ts`, `start`, `db:migrate` = `tsx src/db/migrate.ts`, `seed`.
- New checkpoint 3 check: `npx vitest run apps/server && npm run db:migrate -w @poker/server && (npm run dev -w @poker/server & echo $! > /tmp/pk.pid; for i in $(seq 1 20); do curl -sf localhost:3001/api/health && break; sleep 1; done; kill $(cat /tmp/pk.pid))`.

**F18 (should-fix) E2E specs share state.**
- `playwright.config.ts` uses `workers: 1` and `fullyParallel: false`.
- Every spec makes unique emails (`ana+${Date.now()}@test.local`).
- `history.spec.ts` plays its own hand in `beforeAll` instead of relying on `table.spec.ts`.

**F19 (should-fix) S13 is too slow for vitest.**
- `TableManager` deps add `seedWaitMs` (default 2000) and `runoutPacingMs` (default 1500). S13 sets 50 and 0.
- The idle-bot check is a separate test of 2 hands with `turnSeconds: 1` (protocol min becomes 1 in tests only: allow `turnSeconds >= 1` when `NODE_ENV=test`, else 5).
- Each test sets an explicit `{ timeout: 60_000 }`.

**F20 (should-fix) The AC16 mutation targets code that cannot exist.**
- `ledger.transfer` locks the account rows with `select id from ledger_accounts where id = any($1) order by id for update`, then sums.
- The AC16 test uses a barrier: two clients each `begin`, transfer, then wait on a shared promise before `commit`, so the race is forced deterministically.
- The mutation is to delete the `for update` from that row-lock query; the barrier test then fails because both commit and the balance goes negative.

**F21 (should-fix) The AC7 mutations would not fail their tests.**
- E2 adds known-answer tests:
  - `commit('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`
  - a fixed `deckFromSeeds('00'.repeat(32), ['11'.repeat(16)], 1)` vector, whose first 5 cards are recorded by E2 at implementation time and then frozen in the test
- E2 splits out `uniformInt(n, nextU32)` and tests it with a stubbed stream: for n = 3, the value `0xFFFFFFFF` must be rejected.
- AC7 mutations:
  1. `commit` hashes `serverSeed + 'x'`, so the known-answer test fails.
  2. `uniformInt` drops the rejection loop, so the stub test fails.

**F22 (nit) The AC13 mutation fails for the wrong reason.** The mutation is now `author = $1` → `(author = $1 or true)`.

**F23 (nit) Playwright `webServer` and the database at checkpoint 0.**
- `webServer` is an array: server (`url: http://localhost:3001/api/health`) and web (`url: http://localhost:5173`), each with `timeout: 120_000`.
- At checkpoint 0 the server has no database, so S0.1's server `main.ts` serves `/api/health` without connecting to the database. The lead runs the "Database" setup before checkpoint 0 instead of checkpoint 3.

**F24 (nit) Pins.**
- Pin `jsdom@31.0.1`; it needs Node ^22.22.2, and 22.23.5 satisfies that.
- All other pins checked out.


---

## Progress

(Empty at the start. The lead records each checkpoint here.)

### Checkpoint 0: Scaffold, 2026-11-24 (passed)
- Lead: Opus 5.5. The user's Fable-lead rule arrived during this checkpoint. Sub-agents ran on Opus, inherited.
- Database setup is done (F23): role `poker`; databases `poker_dev`, `poker_test`, `poker_e2e`. No pgcrypto (F12).
- S0.2: `_config.yml` excludes `poker` and the Ruby YAML check prints `true`. Committed separately and early, because a stop hook required committing pending changes.
- S0.1: the lead ran the check itself from `poker/`: `npm ci && npm run lint && npm run typecheck && npx vitest run --passWithNoTests && npm run e2e`. Exit 0, and the Playwright smoke test passed (1 passed). The lead checked `packages/engine/src/types.ts` against I-1 with `diff` (identical) and confirmed that the engine stubs throw, that `.gitignore` covers `node_modules`, `dist`, `data` and the test output, that the pins are TS 6.0.3, @playwright/test 1.63.0, @types/node 22.20.5 and jsdom 31.0.1, and that all page stubs are present, including Results.tsx.
- Deviations accepted:
  - `config.ts` adds `HOST` (default `localhost`) and exports `loadConfig(env)`/`Config`.
  - The engine stubs carry `eslint-disable no-unused-vars` headers. Each owning task deletes them when it replaces its file.
  - `dealPositions` is already stubbed in `hand.ts`.
  - The vitest server project sets `NODE_ENV=test`.
  - The root `dev` script uses `run-p`.
  - Extra pins: @eslint/js 10.0.1, globals 17.14.0, npm-run-all2 9.1.0, @types/luxon 3.7.6, @testing-library/react 16.3.3, @testing-library/user-event 14.6.13, @testing-library/jest-dom 8.0.0.
- Mutation checks: none. This checkpoint has no acceptance-criterion tests.

### Checkpoint 1: Engine primitives + protocol, 2026-11-24 (passed)
- Lead: Fable 5.2 (the session started on Opus 5.5, stopped before any checkpoint work, and the user switched it to Fable). All 7 sub-agents ran on Opus.
- Setup: the Poker App setup script had not run, because the session opened on a branch without `poker/`. The lead started Postgres, re-created the role and the three databases, and ran `npm ci` by hand.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run --project engine --project protocol`: 7 files, 157 tests passed (cards 5, rng 11, evaluator 41, pots 14, blinds 40, settlement 9, protocol 37). The exhaustive 2,598,960-hand evaluator count ran in full.
- Plan amendments:
  - The checkpoint 1 and 2 check command `npx vitest run packages` finds no test files in Vitest 5. It is now `npx vitest run --project engine --project protocol`.
  - The AC17 mutation was changed (see Proof), because the original one loops forever.
- The lead read every source file against I-1/I-2/I-3 and the review findings.
- Mutation checks (each applied with Edit, seen to fail, reversed with the reverse Edit; sha256 of the four files matched afterwards):
  - AC6 pots, drop folded chips: 4 pots tests failed.
  - AC7 `commit` hashes `serverSeed + 'x'`: "(f) commit known answer" failed.
  - AC7 `uniformInt` without the rejection loop: "(g) rejects values >= limit" failed.
  - AC7 `cardCommitments` hashes `card + 1`: both "(h)" tests failed.
  - AC17 original mutation: the test run hung and was killed after 60 s. Amended mutation: 4 settlement tests failed, including the balance property.
  - Evaluator, wheel not a straight: the exhaustive count failed, plus 2 others.
  - AC6 `hand.ts` min-raise mutation belongs to checkpoint 2.
- E2 frozen vectors: `deckFromSeeds('00'×32, ['11'×16], 1)` starts `[31, 51, 38, 6, 11]`; cross-checked by the sub-agent against `node:crypto`.
- Deviations accepted:
  - cards: `parseCard` ignores case; `formatCard` throws outside 0..51; `parseCards('')` returns `[]`.
  - rng: `uniformInt` throws `RangeError` on a bad `n`; `verifyDeck` also checks the deck length.
  - evaluator: throws on duplicate or out-of-range cards; rank 0 is named "Deuce"; an ace-high straight flush is named "Royal flush".
  - pots: also exports `mergeAdjacentPots` and `PotContribution`; all-folded input gives one pot with `eligible: []`; `splitPot` returns `[]` for no winners.
  - blinds: `forcedBets` omits zero-amount entries; `levelAt` returns `msLeft: 0` after the last level and throws on an empty schedule.
  - settlement: `formatPlayMoney` throws on a non-safe-integer; with no transfers `settlementText` starts "Everyone is even."
  - protocol: `PartialGameSettingsSchema` carries no defaults, so `updateSettings` never resets omitted fields. Also exported: `ClientEventSchemas`, `ServerEventSchemas`, `GameSettingsInput`, `MIN_TURN_SECONDS`, and payload types `HostCommandMessage`, `TableStatusMessage`, `HandEventMessage`, `ErrorMessage`, `Notify`. `SeatView.avatarUrl` is `string | null`. Client payloads and `GameSettings` reject unknown keys. Compile-time checks tie the zod schemas to the engine types.

### Checkpoint 2: Engine game flow, 2026-11-24 (passed)
- Lead: Fable 5.2. All 4 sub-agents ran on Opus.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run --project engine --project protocol`: 12 files, 239 tests passed (hand 39, sim 1 covering 2,200 simulated hands, equity 15, collusion 17, stats 10, plus checkpoint 1's 157).
- The lead read `hand.ts`, `collusion.ts` and `stats.ts` in full and the top of `equity.ts`, and checked each deviation below against the rules.
- Mutation checks:
  - AC6 `hand.ts`, min-raise increment set to the big blind: 6 hand tests failed (min-raise sizing and the short all-in cases). Reversed with the reverse Edit.
  - AC9 `collusion.ts`, strong-fold threshold 3 → 300: 2 tests failed. Reversed with the reverse `sed`; sha256 matched the original.
- Plan amendments (written before the build, see "I-2 amendments"): `advance(state)` in `hand.ts`; `equityExact(holes, board, rand?)` and `mulberry32` in `equity.ts`.
- Deviations accepted:
  - hand, big-blind ante: it is kept out of the side-pot layering and added to the main pot. Layering it would hand the ante back to the big blind as a side pot only they can win.
  - hand, several short all-ins: they reopen raising once together they raise the bet by a full min-raise over what the player last acted on (TDA cumulative rule).
  - hand, facing only all-in players: the player only has to match the largest all-in and can only call or fold.
  - hand, uncalled chips: the top street contribution above the second highest is returned, counting folded players.
  - hand: `canFold` is always true; `call` with nothing to call throws; `action.amount` is the street total after the action for every kind; `handEnded.stacks` and `potAwarded.seats` are in ascending seat order; `HandState` fields are public.
  - equity: accepts 1 to 9 hands; exports `Equity`.
  - collusion: a pair that qualifies in both directions gives two `chipDumping` flags with the same sorted `players`. **S8 must merge them before the upsert**, because `integrity_flags` is unique on (game, kind, players): keep the higher score and join the summaries. `sharedNetwork` flags have no evidence hands.
  - stats: the highest preflop contribution starts at the largest blind posted; a hand with no end stack for the player adds 0 to `netChips`.

### Checkpoint 3: Server foundation, 2026-11-24 (passed)
- Lead: Fable 5.2. Both sub-agents ran on Opus.
- Before the build the lead wrote section I-8 (detailed server seams) into this plan and committed it (`f574669`).
- Check, run by the lead (F17 form): `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run --project server`: 2 files, 25 tests passed (migrate 5, app 20). `npm run db:migrate -w @poker/server` ran ("No new migrations." on the second run). The dev server started and `curl -sf localhost:3001/api/health` returned `{"ok":true}`.
- The check command `npx vitest run apps/server` finds no files when used as a bare directory filter; use `npx vitest run --project server` (a file path such as `apps/server/test/app.test.ts` still works).
- The lead read `app.ts`, `auth/session.ts`, `test/helpers.ts` and `db/migrate.ts` in full.
- Mutation checks: none. This checkpoint has no acceptance-criterion tests.
- Dependency added by the lead: `zod@4.6.7` in `@poker/server` (see F9).
- Deviations accepted:
  - S1: `001_init.sql` uses `create table if not exists schema_migrations` (migrate.ts bootstraps that table). `makePool(url, extra?)` takes optional pg options. `bigint` is parsed to a JS number per pool and throws outside the safe range. `testDb` sets the search_path as a connection startup option, with no `connect` handler. The migration lock is per schema.
  - S2: 5xx errors always answer `{ error: 'Internal error' }`. Zod errors are recognised by shape. `Config.trustProxy` is `boolean | number | string`. `buildApp` takes `rateLimitMax` (default 300). `/avatars/*` always carries the strict CSP.
- Open point for checkpoint 7: the global limit of 300 requests a minute per IP may be too low for e2e runs from one machine; if so, add an env override to `config.ts`.

### Checkpoint 4: Accounts, social, wallet, 2026-11-24 (passed)
- Lead: Fable 5.2. All 6 sub-agents ran on Opus.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run --project server`: 8 files, 113 tests passed (migrate 5, app 20, auth 15, profile 15, friends 15, notes 14, wallet 17, notifications 12).
- Live check by the lead (real server, `REGISTRATION=open`, curl): registering Ana and Ben gave each a session; Ana's `GET /api/wallet` showed balance 10000 with one `signup` entry (S3 and S7 together, unmocked); Ana's friend request by email in upper case returned `pending`; Ben's `GET /api/notifications` showed the `friendRequest` row (S5 and S10 together) and his `GET /api/friends` listed Ana under `incoming`; a POST with `Origin: http://evil.example` got 403.
- Sent back and fixed:
  - S1's `migrate.test.ts` hard-coded the table and migration lists and failed once `003_invites.sql` existed. It now reads the migration files from the folder.
  - The lead's S3 brief wrongly put the auth rate limit on all four `/auth/*` routes. It now applies only to register and login, so `GET /auth/me` on every page load is not throttled; a test covers it.
- The lead read `wallet/ledger.ts` and `routes/notes.ts` in full and the header of `routes/friends.ts`.
- Mutation checks:
  - AC11 `routes/friends.ts`, accept sets `'pending'`: the lifecycle test failed.
  - AC13 `routes/notes.ts`, `(author = $1 or true)` in the single-note read: 5 tests failed, including "B cannot read A's note on C".
  - AC16 `wallet/ledger.ts`, `for update` removed from the row-lock query: 3 tests failed (parallel buy-ins, the barrier race at −600, the non-negative invariant).
  - The lead applied and reversed these with `sed`. The reverse substitution for friends.ts was too broad and changed four other lines; the lead found this through the sha256 comparison, restored them, and all three files then matched their pre-mutation hashes and the 113 tests passed again. From now on mutations are applied and reversed with the Edit tool, as step 7 says.
- Plan additions: `Config` gained `authRateLimitMax` (`AUTH_RATE_LIMIT_MAX`, default 10) and `rateLimitMax` (`RATE_LIMIT_MAX`, default 300; S12 wires it into `main.ts`). `storage/avatars.ts` exports `avatarUrlFor`, used by every route that returns a user.
- Deviations accepted:
  - auth: also `GET /api/invites`; login does not check the email format; the signup grant runs after the user transaction commits.
  - profile: also `DELETE /api/profile/avatar`; a non-multipart upload gets 400.
  - friends: an advisory lock per user pair makes simultaneous requests safe; `areFriends(db, a, b)` is exported for later routes.
  - notes: `DELETE` answers `{ ok: true }` for an unknown subject.
  - wallet: entry reasons are `signup`, `host grant`, `buy-in`, `cash-out`; `InsufficientFundsError` maps to 409 "Not enough chips".
  - notifications: also `POST /api/notifications/read-all`.

### Checkpoint 5: Real-time table, 2026-11-24 (passed)
- Lead: Fable 5.2. All 3 sub-agents ran on Opus. Before the build the lead wrote section I-9 into this plan (`8e132f8`).
- Interruption: the S13 sub-agent stopped on the account's usage limit and the session's worker restarted. Files on disk were intact. The lead restarted Postgres, pushed a work-in-progress commit (`007c615`) and resumed S13 after the limit reset.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run` (everything): 23 files, 401 tests passed (tableManager 17, socket 28, integration 3, plus the earlier ones). The real server booted and answered `/api/health` and the Socket.IO handshake.
- Sent back and fixed:
  - S8, after the lead's decisions on its questions: a settings change applies at once when no hand is in progress and waits for the next hand otherwise; `TableView.deadline` and `toAct` are visible to every viewer (only `legal` is private).
  - S13: the "own seed used" check failed under load. Two causes, both in the test: a 50 ms seed window (now 2000 ms; the server proceeds as soon as all seeds are in, measured 1–11 ms) and the bot linking a sit-time seed to the wrong hand.
  - E6 (checkpoint 1): the settlement property test failed on a random seed because a derived net was `-0`. Test-only fix plus a new test that `settle` treats `-0` as even.
- The lead read `redact`, the hand-event emission, the card-proof code and the turn-timer code in `tableManager.ts`, and S12's handler in `socket.ts`.
- Mutation checks (applied and reversed with the Edit tool; both files matched their sha256 afterwards and the 401 tests passed again):
  - AC8 `redact` returns the event unchanged: the `redact` unit test, the spectator test and the 30-hand bot test failed.
  - AC8 `socket.ts` skips the schema parse: all 12 invalid-payload tests failed.
  - AC10 time bank skipped: "switches to the time bank, then checks or folds on timeout" failed.
  - AC12 chat bucket capacity 500: the chat rate-limit test failed.
  - AC15 settings applied immediately mid-hand: "applies a mid-hand settings change from the next hand" failed.
- Deviations accepted:
  - S8: extra `whenIdle(gameId)` and an optional `logger` dep. The manager acts on the `effects` of `applyHostCommand`. A kicked or leaving player is auto-acted with `timeoutAction` (check if free, else fold). The sit-time client seed counts only for a hand whose commitment was already published. The seed wait covers connected, seated players with chips. After a restart, hand numbers continue from the last stored hand and a `running` game reopens as `waiting`. Cash results rank by net, ties share a place. The all-in `river` equity event is computed before the river card, so it is exact but not 0/1.
  - S12: messages from one socket are handled in order through a per-socket queue. A rejected `table:join` acks `{ ok: false, error: <code> }`. `SocketTables` is the subset of manager methods the socket layer uses. Production static serving and SPA fallback were checked by the sub-agent with a real build.
  - S13: `hostControls` is mocked in the integration test until S17 lands (**remove that mock in checkpoint 6**). Bots throttle themselves under the 10 events/s limit and sit again after busting.
- Still open: `playwright.config.ts` must start the server with `REGISTRATION=open` and raised rate limits for e2e (checkpoint 7).

### Checkpoint 6: Games, tournaments, host controls, history, stats, integrity, 2026-11-24 (passed)
- Lead: Fable 5.2. All 7 sub-agents ran on Opus. A work-in-progress commit (`344084e`) was pushed part-way to guard against another restart.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run`: 30 files, 535 tests passed.
- Live check by the lead (real server, curl): Ana and Ben registered and became friends; Ana created a cash game starting 3 s later and invited Ben; Ben RSVP'd yes and downloaded the `.ics` (200, `text/calendar`); after the start time the status was `open` and Ben had the notifications "Friday game is starting now" (link `/table/<id>`), "Ana invited you to Friday game" and the friend request; `GET /api/games/:id/fairness` answered 409 before the game ended.
- Bugs found by the lead and fixed by the owning sub-agents:
  - S15 + S8 together: the "starting now" notifications were never sent, because `TableManager.open` already sets the status to `open` and the scheduler then saw no row change. The scheduler now claims the game first (status update), then opens the table, then notifies; if opening fails it puts the status back. A test with the real TableManager covers it. Found in the live check, not by the unit tests.
  - S16: a player busting in the tournament's first hand could not rebuy, because the controller only knew entrants after the first reported hand. `canRebuy` now allows any player who is not eliminated. (S16 raised this itself.)
  - S8: a `resume` while a pause was still waiting for the hand to end was rejected. The manager now passes the effective status to `applyHostCommand`.
  - S8, found by its new end-to-end test with the real `TournamentController`: after the prize sweep the winner was still shown seated with chips. `finishGame` now unseats remaining tournament players.
- New tests asked for by the lead: a whole tournament through the real TableManager, real controller and real host controls (3 players: prizes 2925 / 1575 / 0; with one rebuy: 3900 / 2100 / 0; wallets, zero table balances and a zero ledger sum checked). S13's integration test now runs against the real `applyHostCommand` (its mock is gone).
- Mutation checks (Edit tool; all six touched files matched their sha256 afterwards and the 535 tests passed again):
  - AC1 `routes/games.ts`, access check `if (false)`: "non-invited user gets 403" failed.
  - AC2 `scheduler.ts`, due condition an hour late: "opens table at starts_at and notifies RSVP yes" and 2 others failed.
  - AC18 `tournament.ts`, ties by user id: both same-hand bust tests failed.
  - AC9 `collusion.ts`, threshold 300: 2 `integrity.test.ts` tests failed.
  - AC8/AC14 `redact` unchanged: 5 `history.test.ts` tests failed, including "player B fetching a hand where A folded gets no A cards".
  - AC17 `settlement.ts`, transfer recorded as `chips - 1`: both F2 settlement tests in `games.test.ts` failed.
- Plan additions (routes beyond the task text): `POST /api/games/:id/open` (host opens the table now, without waiting for the scheduler), `GET /api/games/:id/results` (S16, F3), `GET /api/games/:id/fairness` (S19, F1), `POST /api/games/:id/integrity/run`.
- Deviations accepted:
  - games: the exact 403 line is in `GET /games/:id`; calendar and settlement use a shared member check. Settlement answers 409 "Results are not final yet" when nets do not sum to 0.
  - tournament: prizes of unfilled places go to place 1. Two players busting in the same hand with equal start stacks share a place and split those prizes (AC18), so a 3-way all-in can end 2925 / 788 / 787. **W-E2E-3 must not assume distinct places.** The finish pays prizes with `transfer` inside one transaction, not `grant`.
  - host controls: `pause` only while running, `resume` only while paused; unchanged `kind`/`maxSeats` values are accepted after the start.
  - integrity: flags with non-uuid player ids are not stored; a live flag already stored is listed once.
  - history: the list also takes `before` as an ISO timestamp; fairness is open to the host, invited users and anyone who played.
  - stats: hole cards are stripped in SQL before `computeStats`.

### Checkpoint 7: Web foundation, 2026-11-24 (passed)
- Lead: Fable 5.2. All 5 sub-agents ran on Opus. Before the build the lead wrote section I-10 into this plan (`668f225`). Work-in-progress commits were pushed along the way because a stop hook requires it.
- Check, run by the lead: `npm run lint` exit 0, `npm run typecheck` exit 0, `npx vitest run` (everything): 41 files, 646 tests passed (web: 11 files, 111 tests: client 15, shell 7, tween 16, easing, useTween, login 13, profile 8, settingsForm 19, gameDetail 8, lobby 3, friends 3). `npm run e2e -- e2e/smoke.spec.ts e2e/social.spec.ts`: 2 passed. The bare filter `npx vitest run apps/web` matches nothing; use `--project web`.
- Browser check by the lead (real dev servers, Chromium, 1280 px and 390 px): register, lobby, new-game form, game page, friends, profile. No horizontal page scroll at either width; the only console error is the expected 401 from `GET /api/auth/me` on `/login` before signing in.
- Sent back and fixed (W4):
  - Settings-form checkboxes sat centred above their labels. They are now left-aligned rows; the invite checkboxes too.
  - Found by W4 while checking that: in tournament mode the page was 731 px wide at 390 px (a hidden table header escaped its scroll box). Fixed.
  - Switching a fresh form from cash to tournament kept the cash values (starting stack 200, payouts 100). Untouched fields now take the new kind's defaults in both directions; edited fields are kept. 3 tests added.
- The lead read `anim/easing.ts`, the step function of `anim/tween.ts`, `api/client.ts`, `api/useMe.ts`, `playwright.config.ts`, and checked the grep for `.skip`, `fixme`, `waitForTimeout`, `any` and `dangerouslySetInnerHTML` (none).
- Mutation checks (Edit tool; the three files matched their sha256 afterwards and the full check passed again):
  - AC4 `tween.ts`, eased factor replaced by `1` (value jumps to `to`): 8 tween tests failed, including the max per-frame delta test.
  - AC1 `routes/games.ts`, access check `if (false)`: `e2e/social.spec.ts` failed (Cleo got 200, expected 403).
  - AC11 `routes/friends.ts`, accept sets `'pending'`: `e2e/social.spec.ts` failed (Ben never sees Ana as a friend).
- **Decisions for checkpoint 8 (binding, they amend AC4, W2 and W-E2E-2 (e)):**
  - `easeInOutCubic` is the smoothstep cubic `3t² − 2t³`, whose peak speed is 1.5× the average, as the plan's bounds assume. The usual piecewise `4t³` curve peaks at 3× and could not meet them.
  - The out-curves start faster than 2.5× the average (easeOutCubic 3×, easeOutQuart 4×, easeOutBack 4.6×), so a flat 2.5× bound would fail the very tweens the plan prescribes. W-E2E-2 (e) and F5 therefore bound each sample by its own curve: |Δ| ≤ 1.25 × `EASE_PEAK_SLOPE[sample.ease]` × (|to − from| × Δt / durationMs) + ε, with Δt the real time between the two samples, and `from`/`to`/`durationMs`/`ease` read from the trace sample. A change on an `obj:*` series whose sample has `active: false` still fails. Tweens must pass a named ease from `easing.ts` (the trace records the function name); an inline arrow function is not allowed for table objects.
  - `easeOutBack` uses c = 1.6 (overshoot about 9%).
- Deviations accepted:
  - W1: App.tsx puts every route except `/login` under one layout route with `<Shell><Outlet/></Shell>`; pages render `<div className="page">`, not their own `<main>`. Extra exports: `onRejoin(listener)` and `PokerSocket` (socket.ts), `refreshMe`, `setMeState`, `__resetMeForTests` (useMe.ts), `ApiInit`, `NotificationItem`. `leaveTableRoom` only forgets the id and sends nothing, because the protocol's `table:leave` stands the player up. **W11 calls `onRejoin` to take the fresh `TableView` after a reconnect.** `joinTable` queues until connected and times out after 10 s. theme.css documents its class names at the top (`.btn`, `.card`, `.field`, `.field-inline`, `.row`, `.stack`, `.badge`, `.alert`, `.page`, `.table`, `.sr-only`, …).
  - W2: additions to the surface: `EASE_OUT_BACK_C`, `EASE_OUT_BACK_OVERSHOOT`, `EASE_PEAK_SLOPE`, `TraceSample`, `TraceMeta`, `TRACE_MAX_SAMPLES` (250,000; later samples are dropped and counted in `window.__animTraceDropped`), `REDUCED_MOTION_SCALE`, `DEFAULT_POSITION_MS` (350), `cancelTween(id)`, `isTweening(id)`, `__resetForTests()`. Trace samples also carry `active`, `ease` (function name) and, on `obj:` series, `tween`. `useTweenedPosition`'s internal tween id is `pos:<id>`, its trace series `obj:<id>`. `done` resolves on finish, cancel or replace; `onDone` runs only on a natural finish. Reduced motion scales delays as well as durations. The hooks restart only when the target or id changes.
  - W3: `usePageEnter(name)` in `pages/usePageEnter.ts`; under reduced motion it skips the tween. Login mode checks the password only as required (as the server does). Profile picks the avatar, previews it, then uploads with "Upload avatar". Profile also lists and creates invite codes.
  - W4: SettingsForm also exports `convertKind` and `PAYOUT_PRESETS`. Ante kind is per level. "Save settings" sends only changed keys. GameDetail: inline confirmation for "Cancel game"; finished games link to "Settle up" and "Results"; polling every 5 s only while `scheduled`. Friends: outgoing requests can be cancelled. `usePageRise` in `pages/usePageRise.ts` (W3 and W4 each have their own small page-enter hook; merging them is optional clean-up).
  - W-E2E-1: `reset-db.ts` refuses to run unless the database name ends in `_e2e`. The spec uses the form's default (cash) game type. API calls made outside a page need an `Origin: http://localhost:5173` header (CSRF check); `page.request` from a context works for GETs.
- Note for later e2e specs: the "Game type" select in SettingsForm is labelled "Game type" with options "Cash game" and "Tournament".

### Checkpoint 8: The table, 2026-11-26 (in progress)
- Lead: Fable 5.2 (the session opened on Opus 5.5; the user switched it before any checkpoint work). Sub-agents on Opus.
- Branch: the user decided that this session pushes to `claude/elegant-meitner-a3zy54` (fast-forwarded from `ccr-f5339883-mfcgzv` at `e90495b`), not to `ccr-f5339883-mfcgzv`.
- Setup by hand again (Postgres start, role, databases, `npm ci`): the session opened on a branch without `poker/`.
- WebGL works in this container's headless Chromium (SwiftShader, WebGL 2, about 60 frames a second on an empty page).
- Before the build the lead wrote section I-11 into this plan.
- W0 passed (lead ran lint, typecheck and the web tests: 12 files, 129 tests; read `types.ts`, `storeContext.tsx`, `sceneContext.ts` and the `tween.ts` diff). Accepted: `TableState = TableData & TableActions`; the hook stubs `useNotes`, `useEquity`, `useDirector` do nothing instead of throwing; `sceneContext.ts` also exports `SeatActions`, `useSeatActions`, `HOLE_CARD_OFFSET_X`, `HOLE_CARD_INSET`, `HOLE_CARD_Y`.
- Plan change: W11 is split in two so the page does not wait on the store. **W11a** owns `table/useTableStore.ts`, `table/verify.ts`, `test/tableStore.test.ts`, `test/verify.test.ts`. **W11b** owns `pages/TablePage.tsx`, `table/table.css`, `test/tablePage.test.tsx`.
