/**
 * Pure table step logic (W11a, PLAN I-11 "Step rules"). Shared by the live store and the replayer.
 *
 * - `appendEvent(queue, event, newId, chipsOut)`: maps one hand event to a queued step, batching consecutive
 *   forced bets into one `bet` step and every `dealHole` into one `deal` step (while the tail step is still
 *   waiting in the queue).
 * - `beginStep(state, step)`: moves entities (the tweens start). Numbers on display do not change, except that
 *   the turn data of the acting seat is cleared when its action step begins.
 * - `consumeStep(state, step, ctx)`: settles the numbers, removes entities that are gone and writes the log.
 * - `dataFromView(prev, view)`: the full snapshot, entities in place with no `spawnFrom`.
 * - `mergeSeats(displayed, server, mode)`: the `table:seats` rules.
 *
 * Chip conservation: after every consume, the seats' stacks plus every chip entity's amount equals the chips
 * that started the hand (antes travel straight to `chips:pot:0`).
 */
import { formatCard, formatPlayMoney, type BlindLevel, type Card, type HandEvent, type SeatIndex } from '@poker/engine';
import type { GameSettings, SeatView, TableClock, TableView } from '@poker/protocol';
import {
  DEAL_STAGGER_MS,
  STEP_MS,
  type AnimStep,
  type CardEntity,
  type CardPlace,
  type ChipEntity,
  type LogLine,
  type StepKind,
  type TableData,
} from './types.js';

export const LOG_LIMIT = 200;
export const CHAT_LIMIT = 200;
export const VERIFIED_TEXT = '✓ Cards verified';
export const VERIFY_FAILED_TEXT = '⚠ Card verification failed';

type Ev<T extends HandEvent['type']> = Extract<HandEvent, { type: T }>;

/** Services a consume needs from its store. The replayer can use `plainStepContext()`. */
export interface StepContext {
  /** A fresh, increasing log line id. */
  logId(): number;
  /** The card verification result of a hand: null when it cannot be judged (no commitments received). */
  verdict(handId: string | null): 'ok' | 'failed' | null;
  /** A `table:clock` that arrived for this seat before its turn was on display (taken once). */
  takeClock(seat: SeatIndex): TableClock | null;
}

export function plainStepContext(): StepContext {
  let id = 1;
  return { logId: () => id++, verdict: () => null, takeClock: () => null };
}

// ---------------------------------------------------------------------------------------------------------
// Event → step

/** The step kind an event becomes; null for `cardProof` (never queued). */
export function stepKindFor(event: HandEvent): StepKind | null {
  switch (event.type) {
    case 'handStarted':
      return 'newHand';
    case 'postAnte':
    case 'postBlind':
      return 'bet';
    case 'dealHole':
      return 'deal';
    case 'toAct':
      return 'turn';
    case 'action':
      return event.kind === 'fold' ? 'fold' : event.kind === 'check' ? 'action' : 'bet';
    case 'uncalledReturned':
      return 'return';
    case 'potsFormed':
      return 'collect';
    case 'street':
      return 'board';
    case 'showCards':
      return 'flip';
    case 'muck':
      return 'muck';
    case 'equity':
      return 'equity';
    case 'potAwarded':
      return 'award';
    case 'handEnded':
      return 'handEnd';
    case 'cardProof':
      return null;
  }
}

function isForced(e: HandEvent): e is Ev<'postAnte'> | Ev<'postBlind'> {
  return e.type === 'postAnte' || e.type === 'postBlind';
}

/** Base duration plus the deal stagger; `chipsOut` = bet chips are on the table (for `collect`). */
export function stepDuration(kind: StepKind, events: HandEvent[], chipsOut = true): number {
  if (kind === 'deal') {
    const cards = events.reduce((n, e) => n + (e.type === 'dealHole' ? Math.max(2, e.cards.length) : 0), 0);
    return STEP_MS.deal + DEAL_STAGGER_MS * Math.max(0, cards - 1);
  }
  if (kind === 'board') {
    const cards = events.reduce((n, e) => n + (e.type === 'street' ? e.cards.length : 0), 0);
    return STEP_MS.board + DEAL_STAGGER_MS * Math.max(0, cards - 1);
  }
  if (kind === 'collect' && !chipsOut) return 0;
  return STEP_MS[kind];
}

function singleSeat(events: HandEvent[]): SeatIndex | undefined {
  const seats = new Set<SeatIndex>();
  for (const e of events) if ('seat' in e && typeof e.seat === 'number') seats.add(e.seat);
  return seats.size === 1 ? [...seats][0] : undefined;
}

function buildStep(id: number, kind: StepKind, events: HandEvent[], chipsOut: boolean): AnimStep {
  const step: AnimStep = { id, kind, events, durationMs: stepDuration(kind, events, chipsOut) };
  const seat = singleSeat(events);
  if (seat !== undefined) step.seat = seat;
  const e = events[0];
  if (e === undefined) return step;
  switch (e.type) {
    case 'postAnte':
    case 'postBlind':
      step.amount = events.reduce((n, x) => n + (isForced(x) ? x.amount : 0), 0);
      break;
    case 'action':
    case 'uncalledReturned':
      step.amount = e.amount;
      break;
    case 'street':
    case 'showCards':
      step.cards = [...e.cards];
      break;
    case 'dealHole':
      step.cards = events.flatMap((x) => (x.type === 'dealHole' ? x.cards : []));
      break;
    case 'potAwarded':
      step.potIndex = e.potIndex;
      step.amount = e.amounts.reduce((n, a) => n + a, 0);
      break;
    default:
      break;
  }
  return step;
}

/** Whether bet chips are (or will be, once the given steps have played) on the table. */
export function chipsOutAfter(chips: ChipEntity[], steps: (AnimStep | null)[]): boolean {
  let out = chips.some((c) => c.id.startsWith('chips:bet:') && c.amount > 0);
  for (const s of steps) {
    if (!s) continue;
    if (s.kind === 'newHand' || s.kind === 'collect') out = false;
    else if (s.kind === 'bet' && s.events.some((e) => e.type === 'postBlind' || (e.type === 'action' && e.amount > 0))) out = true;
  }
  return out;
}

/**
 * Appends `event` to the queue as a new step or merged into the waiting tail step. `chipsOut` tells a new
 * `collect` step whether bet chips will be out when it plays (its duration is 0 otherwise; `beginStep`'s
 * caller re-checks it at begin). Returns the new queue (the input is not mutated).
 */
export function appendEvent(queue: AnimStep[], event: HandEvent, newId: () => number, chipsOut: boolean): AnimStep[] {
  const kind = stepKindFor(event);
  if (kind === null) return queue;
  const tail = queue[queue.length - 1];
  const mergeable =
    tail !== undefined &&
    ((kind === 'deal' && tail.kind === 'deal') ||
      (kind === 'bet' && isForced(event) && tail.kind === 'bet' && tail.events.every(isForced)));
  if (mergeable) {
    return [...queue.slice(0, -1), buildStep(tail.id, kind, [...tail.events, event], chipsOut)];
  }
  return [...queue, buildStep(newId(), kind, [event], chipsOut)];
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

function money(n: number): string {
  return formatPlayMoney(n);
}

function cardsText(cards: Card[]): string {
  return cards.map(formatCard).join(' ');
}

export function seatName(s: Pick<TableData, 'seats'>, seat: SeatIndex): string {
  return s.seats.find((x) => x.seat === seat)?.name ?? `Seat ${seat + 1}`;
}

function patchSeat(seats: SeatView[], seat: SeatIndex, f: (v: SeatView) => Partial<SeatView>): SeatView[] {
  return seats.map((v) => (v.seat === seat ? { ...v, ...f(v) } : v));
}

function displayedBet(s: TableData, seat: SeatIndex): number {
  return s.seats.find((x) => x.seat === seat)?.bet ?? 0;
}

function withLog<S extends TableData>(s: S, ctx: StepContext, lines: [string, LogLine['tone']][]): S {
  if (lines.length === 0) return s;
  const added = lines.map(([text, tone]): LogLine => ({ id: ctx.logId(), text, tone }));
  return { ...s, handLog: [...s.handLog, ...added].slice(-LOG_LIMIT) };
}

function holeId(handId: string | null, seat: SeatIndex, r: number): string {
  return `card:${handId ?? 'none'}:${seat}:${r}`;
}

function boardId(handId: string | null, i: number): string {
  return `card:${handId ?? 'none'}:board:${i}`;
}

function isSeatCard(c: CardEntity, handId: string | null, seat: SeatIndex): boolean {
  return c.id === holeId(handId, seat, 0) || c.id === holeId(handId, seat, 1);
}

function incId(stepId: number, k: number, n: number): string {
  return n === 1 ? `chips:inc:${stepId}` : `chips:inc:${stepId}:${k}`;
}

function isIncOf(id: string, stepId: number): boolean {
  return id === `chips:inc:${stepId}` || id.startsWith(`chips:inc:${stepId}:`);
}

/** Adds `delta` to the chip entity `id` (created at `place` if missing; removed when it reaches 0). */
function addChips(chips: ChipEntity[], id: string, place: ChipEntity['place'], delta: number): ChipEntity[] {
  const cur = chips.find((c) => c.id === id);
  if (!cur) return delta > 0 ? [...chips, { id, amount: delta, place, order: 0 }] : chips;
  const amount = cur.amount + delta;
  return amount > 0 ? chips.map((c) => (c.id === id ? { ...c, amount } : c)) : chips.filter((c) => c.id !== id);
}

function setChips(chips: ChipEntity[], id: string, place: ChipEntity['place'], amount: number): ChipEntity[] {
  const rest = chips.filter((c) => c.id !== id);
  return amount > 0 ? [...rest, { id, amount, place, order: 0 }] : rest;
}

function clearTurnFor<S extends TableData>(s: S, seat: SeatIndex): S {
  if (s.toAct !== seat && s.toAct !== null) return s;
  return { ...s, toAct: null, legal: null, deadline: null, timeBank: null };
}

function sendToMuck(cards: CardEntity[], pick: (c: CardEntity) => boolean, fading: boolean): CardEntity[] {
  const muck: CardPlace = { at: 'muck' };
  return cards.map((c) => (pick(c) ? { ...c, place: muck, faceUp: false, fading: fading || c.fading } : c));
}

/** The blind level that matches the hand's stakes (keeps `level` in step with the blinds actually played). */
function levelForStakes(prev: BlindLevel | null, settings: GameSettings | null, e: Ev<'handStarted'>): BlindLevel | null {
  const st = e.stakes;
  const same = (l: BlindLevel) =>
    l.smallBlind === st.smallBlind && l.bigBlind === st.bigBlind && l.ante === st.ante && l.anteKind === st.anteKind;
  if (prev && same(prev)) return prev;
  const found = settings?.levels.find(same);
  if (found) return found;
  return { level: prev?.level ?? 1, durationMinutes: prev?.durationMinutes ?? 0, ...st };
}

const STREET_NAME: Record<string, string> = { flop: 'Flop', turn: 'Turn', river: 'River', preflop: 'Preflop', showdown: 'Showdown' };

// ---------------------------------------------------------------------------------------------------------
// begin

/** Moves the entities for `step` (tweens start). Only turn data changes among the displayed numbers. */
export function beginStep<S extends TableData>(s: S, step: AnimStep): S {
  const handId = s.handId;
  switch (step.kind) {
    case 'newHand':
      return { ...s, cards: sendToMuck(s.cards, () => true, true) };

    case 'bet': {
      let next = s;
      const spawned: ChipEntity[] = [];
      const n = step.events.length;
      step.events.forEach((e, k) => {
        if (e.type === 'action') next = clearTurnFor(next, e.seat);
        let amount = 0;
        let place: ChipEntity['place'] | null = null;
        if (e.type === 'postAnte') {
          amount = e.amount;
          place = { at: 'pot', index: 0 };
        } else if (e.type === 'postBlind') {
          amount = e.amount;
          place = { at: 'bet', seat: e.seat };
        } else if (e.type === 'action') {
          amount = e.amount - displayedBet(s, e.seat);
          place = { at: 'bet', seat: e.seat };
        }
        if (place && amount > 0 && 'seat' in e) {
          spawned.push({ id: incId(step.id, k, n), amount, place, spawnFrom: { at: 'seat', seat: e.seat }, order: k });
        }
      });
      return spawned.length ? { ...next, chips: [...next.chips, ...spawned] } : next;
    }

    case 'deal': {
      const deals = step.events.filter((e): e is Ev<'dealHole'> => e.type === 'dealHole');
      const n = deals.length;
      const fresh: CardEntity[] = [];
      for (let r = 0; r < 2; r++) {
        deals.forEach((e, k) => {
          const card = e.cards[r] ?? null;
          fresh.push({
            id: holeId(handId, e.seat, r),
            place: { at: 'seat', seat: e.seat, index: r as 0 | 1 },
            spawnFrom: { at: 'deck' },
            card,
            faceUp: card !== null,
            order: r * n + k,
            fading: false,
          });
        });
      }
      const ids = new Set(fresh.map((c) => c.id));
      return { ...s, cards: [...s.cards.filter((c) => !ids.has(c.id)), ...fresh] };
    }

    case 'action':
    case 'fold': {
      const e = step.events[0];
      if (e?.type !== 'action') return s;
      const next = clearTurnFor(s, e.seat);
      if (step.kind === 'action') return next;
      return { ...next, cards: sendToMuck(next.cards, (c) => isSeatCard(c, handId, e.seat), false) };
    }

    case 'return': {
      const e = step.events[0];
      if (e?.type !== 'uncalledReturned' || e.amount <= 0) return s;
      const chip: ChipEntity = {
        id: `chips:return:${step.id}`,
        amount: e.amount,
        place: { at: 'seat', seat: e.seat },
        spawnFrom: { at: 'bet', seat: e.seat },
        order: 0,
      };
      return { ...s, chips: [...s.chips, chip] };
    }

    case 'collect': {
      let order = 0;
      const chips = s.chips.map((c): ChipEntity =>
        c.id.startsWith('chips:bet:') ? { ...c, place: { at: 'pot', index: 0 }, order: order++ } : c,
      );
      return { ...s, chips };
    }

    case 'board': {
      const e = step.events[0];
      if (e?.type !== 'street') return s;
      const base = s.board.length;
      const fresh = e.cards.map(
        (card, i): CardEntity => ({
          id: boardId(handId, base + i),
          place: { at: 'board', index: base + i },
          spawnFrom: { at: 'deck' },
          card,
          faceUp: true,
          order: i,
          fading: false,
        }),
      );
      const ids = new Set(fresh.map((c) => c.id));
      return { ...s, cards: [...s.cards.filter((c) => !ids.has(c.id)), ...fresh] };
    }

    case 'flip': {
      const e = step.events[0];
      if (e?.type !== 'showCards') return s;
      let cards = s.cards;
      e.cards.forEach((card, r) => {
        const id = holeId(handId, e.seat, r);
        if (cards.some((c) => c.id === id)) {
          cards = cards.map((c) => (c.id === id ? { ...c, card, faceUp: true } : c));
        } else {
          cards = [
            ...cards,
            { id, place: { at: 'seat', seat: e.seat, index: r as 0 | 1 }, card, faceUp: true, order: r, fading: false },
          ];
        }
      });
      return { ...s, cards };
    }

    case 'muck': {
      const e = step.events[0];
      if (e?.type !== 'muck') return s;
      return { ...s, cards: sendToMuck(s.cards, (c) => isSeatCard(c, handId, e.seat), true) };
    }

    case 'award': {
      const e = step.events[0];
      if (e?.type !== 'potAwarded') return s;
      const potId = `chips:pot:${e.potIndex}`;
      const awards = e.seats.flatMap((seat, k): ChipEntity[] => {
        const amount = e.amounts[k] ?? 0;
        if (amount <= 0) return [];
        return [
          {
            id: `chips:award:${step.id}:${seat}`,
            amount,
            place: { at: 'seat', seat },
            spawnFrom: { at: 'pot', index: e.potIndex },
            order: k,
          },
        ];
      });
      return { ...s, chips: [...s.chips.filter((c) => c.id !== potId), ...awards] };
    }

    case 'turn':
    case 'pots':
    case 'equity':
    case 'handEnd':
      return s;
  }
}

/** Begins the head of the queue: moves it to `playing` (a `collect` with no bet chips out lasts 0 ms). */
export function beginHead<S extends TableData>(s: S): S {
  const head = s.queue[0];
  if (!head || s.playing) return s;
  const next = beginStep(s, head);
  let playing = head;
  if (head.kind === 'collect' && !s.chips.some((c) => c.id.startsWith('chips:bet:') && c.amount > 0)) {
    playing = { ...head, durationMs: 0 };
  }
  return { ...next, queue: s.queue.slice(1), playing };
}

// ---------------------------------------------------------------------------------------------------------
// consume

function actionText(name: string, e: Ev<'action'>, prevBet: number): string {
  let t: string;
  switch (e.kind) {
    case 'fold':
      t = `${name} folds`;
      break;
    case 'check':
      t = `${name} checks`;
      break;
    case 'call':
      t = `${name} calls ${money(e.amount - prevBet)}`;
      break;
    case 'bet':
      t = `${name} bets ${money(e.amount)}`;
      break;
    case 'raise':
      t = `${name} raises to ${money(e.amount)}`;
      break;
    case 'allIn':
      t = `${name} goes all-in for ${money(e.amount)}`;
      break;
  }
  return e.auto === 'timeout' ? `${t} (timed out)` : t;
}

/** Whether a "shows" line for this seat was already written since the last "Hand #" line. */
function alreadyShown(log: LogLine[], name: string): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const t = log[i]!.text;
    if (t.startsWith('Hand #')) return false;
    if (t.startsWith(`${name} shows `)) return true;
  }
  return false;
}

/** Settles the numbers for `step`, removes entities that are gone and writes the hand log. */
export function consumeStep<S extends TableData>(s: S, step: AnimStep, ctx: StepContext): S {
  switch (step.kind) {
    case 'newHand': {
      const e = step.events[0];
      if (e?.type !== 'handStarted') return s;
      const seats = s.seats.map((v): SeatView => {
        const dealt = e.seats.find((x) => x.seat === v.seat);
        const base = { ...v, bet: 0, folded: false, allIn: false, hasCards: false, cardsVisible: null };
        return dealt ? { ...base, stack: dealt.stack } : base;
      });
      const next: S = {
        ...s,
        cards: [],
        chips: [],
        handId: e.handId,
        handNumber: e.handNumber,
        buttonSeat: e.buttonSeat,
        level: levelForStakes(s.level, s.settings, e),
        seats,
        board: [],
        pots: [],
        toAct: null,
        legal: null,
        deadline: null,
        timeBank: null,
        myHole: [],
        myEquity: null,
        allInEquity: null,
        verified: 'pending',
      };
      return withLog(next, ctx, [[`Hand #${e.handNumber}`, 'info']]);
    }

    case 'bet': {
      let next: S = { ...s, chips: s.chips.filter((c) => !isIncOf(c.id, step.id)) };
      const lines: [string, LogLine['tone']][] = [];
      for (const e of step.events) {
        const name = seatName(next, e.type === 'postAnte' || e.type === 'postBlind' || e.type === 'action' ? e.seat : -1);
        if (e.type === 'postAnte') {
          next = {
            ...next,
            seats: patchSeat(next.seats, e.seat, (v) => ({ stack: v.stack - e.amount, allIn: v.stack - e.amount === 0 })),
            chips: addChips(next.chips, 'chips:pot:0', { at: 'pot', index: 0 }, e.amount),
          };
          lines.push([`${name} posts ante ${money(e.amount)}`, 'info']);
        } else if (e.type === 'postBlind') {
          const bet = displayedBet(next, e.seat) + e.amount;
          next = {
            ...next,
            seats: patchSeat(next.seats, e.seat, (v) => ({ stack: v.stack - e.amount, bet, allIn: v.stack - e.amount === 0 })),
            chips: setChips(next.chips, `chips:bet:${e.seat}`, { at: 'bet', seat: e.seat }, bet),
          };
          lines.push([`${name} posts ${e.blind} blind ${money(e.amount)}`, 'info']);
        } else if (e.type === 'action') {
          lines.push([actionText(name, e, displayedBet(next, e.seat)), 'info']);
          next = {
            ...next,
            seats: patchSeat(next.seats, e.seat, () => ({ stack: e.stackAfter, bet: e.amount, allIn: e.stackAfter === 0 })),
            chips: setChips(next.chips, `chips:bet:${e.seat}`, { at: 'bet', seat: e.seat }, e.amount),
          };
        }
      }
      return withLog(next, ctx, lines);
    }

    case 'deal': {
      let next = s;
      const lines: [string, LogLine['tone']][] = [];
      for (const e of step.events) {
        if (e.type !== 'dealHole') continue;
        const mine = e.seat === s.mySeat && e.cards.length > 0;
        next = {
          ...next,
          seats: patchSeat(next.seats, e.seat, () => (mine ? { hasCards: true, cardsVisible: [...e.cards] } : { hasCards: true })),
        };
        if (mine) {
          next = { ...next, myHole: [...e.cards] };
          lines.push([`You are dealt ${cardsText(e.cards)}`, 'info']);
        }
      }
      return withLog(next, ctx, lines);
    }

    case 'turn': {
      const e = step.events[0];
      if (e?.type !== 'toAct') return s;
      const clock = ctx.takeClock(e.seat);
      return {
        ...s,
        toAct: e.seat,
        legal: e.seat === s.mySeat ? e.legal : null,
        deadline: clock?.deadline ?? e.deadline ?? null,
        timeBank: clock ? { seat: clock.seat, ms: clock.timeBankMs, using: clock.usingTimeBank } : null,
      };
    }

    case 'action': {
      const e = step.events[0];
      if (e?.type !== 'action') return s;
      return withLog(s, ctx, [[actionText(seatName(s, e.seat), e, displayedBet(s, e.seat)), 'info']]);
    }

    case 'fold': {
      const e = step.events[0];
      if (e?.type !== 'action') return s;
      const next: S = {
        ...s,
        seats: patchSeat(s.seats, e.seat, () => ({ folded: true, hasCards: false })),
        myEquity: e.seat === s.mySeat ? null : s.myEquity,
      };
      return withLog(next, ctx, [[actionText(seatName(s, e.seat), e, displayedBet(s, e.seat)), 'info']]);
    }

    case 'return': {
      const e = step.events[0];
      if (e?.type !== 'uncalledReturned') return s;
      const bet = Math.max(0, displayedBet(s, e.seat) - e.amount);
      const next: S = {
        ...s,
        chips: addChips(
          s.chips.filter((c) => c.id !== `chips:return:${step.id}`),
          `chips:bet:${e.seat}`,
          { at: 'bet', seat: e.seat },
          -e.amount,
        ),
        seats: patchSeat(s.seats, e.seat, (v) => ({ stack: v.stack + e.amount, bet, allIn: v.stack + e.amount === 0 })),
      };
      return withLog(next, ctx, [[`${money(e.amount)} returned to ${seatName(s, e.seat)}`, 'info']]);
    }

    case 'collect': {
      const e = step.events[0];
      if (e?.type !== 'potsFormed') return s;
      const kept = s.chips.filter((c) => !c.id.startsWith('chips:bet:') && !c.id.startsWith('chips:pot:'));
      const pots = e.pots.flatMap((p, i): ChipEntity[] =>
        p.amount > 0 ? [{ id: `chips:pot:${i}`, amount: p.amount, place: { at: 'pot', index: i }, order: 0 }] : [],
      );
      return {
        ...s,
        chips: [...kept, ...pots],
        pots: e.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
        seats: s.seats.map((v) => (v.bet === 0 ? v : { ...v, bet: 0 })),
      };
    }

    case 'board': {
      const e = step.events[0];
      if (e?.type !== 'street') return s;
      const next: S = { ...s, board: [...s.board, ...e.cards], seats: s.seats.map((v) => (v.bet === 0 ? v : { ...v, bet: 0 })) };
      return withLog(next, ctx, [[`${STREET_NAME[e.street] ?? e.street}: ${cardsText(e.cards)}`, 'info']]);
    }

    case 'flip': {
      const e = step.events[0];
      if (e?.type !== 'showCards') return s;
      const name = seatName(s, e.seat);
      const next: S = { ...s, seats: patchSeat(s.seats, e.seat, () => ({ cardsVisible: [...e.cards] })) };
      if (alreadyShown(s.handLog, name)) return next;
      const text = `${name} shows ${cardsText(e.cards)}${e.handName ? ` (${e.handName})` : ''}`;
      return withLog(next, ctx, [[text, 'info']]);
    }

    case 'muck': {
      const e = step.events[0];
      if (e?.type !== 'muck') return s;
      const next: S = { ...s, seats: patchSeat(s.seats, e.seat, () => ({ hasCards: false })) };
      return withLog(next, ctx, [[`${seatName(s, e.seat)} mucks`, 'info']]);
    }

    case 'equity': {
      const e = step.events[0];
      if (e?.type !== 'equity') return s;
      return { ...s, allInEquity: Object.fromEntries(e.equities.map((q) => [q.seat, { win: q.win, tie: q.tie }])) };
    }

    case 'award': {
      const e = step.events[0];
      if (e?.type !== 'potAwarded') return s;
      let seats = s.seats;
      const lines: [string, LogLine['tone']][] = [];
      e.seats.forEach((seat, k) => {
        const amount = e.amounts[k] ?? 0;
        seats = patchSeat(seats, seat, (v) => ({ stack: v.stack + amount, allIn: v.stack + amount === 0 && v.allIn }));
        const side = e.potIndex > 0 ? ` from side pot ${e.potIndex}` : '';
        lines.push([`${seatName(s, seat)} wins ${money(amount)}${side}${e.handName ? ` with ${e.handName}` : ''}`, 'info']);
      });
      const prefix = `chips:award:${step.id}:`;
      const next: S = {
        ...s,
        seats,
        chips: s.chips.filter((c) => !c.id.startsWith(prefix)),
        pots: s.pots.map((p, i) => (i === e.potIndex ? { ...p, amount: 0 } : p)),
      };
      return withLog(next, ctx, lines);
    }

    case 'handEnd': {
      const e = step.events[0];
      if (e?.type !== 'handEnded') return s;
      let seats = s.seats;
      for (const x of e.stacks) seats = patchSeat(seats, x.seat, () => ({ stack: x.stack, bet: 0, allIn: false }));
      const verdict = ctx.verdict(s.handId);
      const next: S = { ...s, seats, toAct: null, legal: null, deadline: null, timeBank: null, verified: verdict };
      if (verdict === 'ok') return withLog(next, ctx, [[VERIFIED_TEXT, 'good']]);
      if (verdict === 'failed') return withLog(next, ctx, [[VERIFY_FAILED_TEXT, 'bad']]);
      return next;
    }

    case 'pots':
      return s;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Snapshots and seats

/** Entities for a snapshot: everything in place, no `spawnFrom`. */
export function entitiesFromView(view: TableView): { cards: CardEntity[]; chips: ChipEntity[] } {
  const cards: CardEntity[] = [];
  const chips: ChipEntity[] = [];
  if (view.handId !== null) {
    let order = 0;
    for (const v of view.seats) {
      if (!v.hasCards) continue;
      const known = v.seat === view.mySeat && view.myHole.length > 0 ? view.myHole : v.cardsVisible;
      for (let r = 0; r < 2; r++) {
        const card = known?.[r] ?? null;
        cards.push({
          id: holeId(view.handId, v.seat, r),
          place: { at: 'seat', seat: v.seat, index: r as 0 | 1 },
          card,
          faceUp: card !== null,
          order: order++,
          fading: false,
        });
      }
    }
    view.board.forEach((card, i) => {
      cards.push({ id: boardId(view.handId, i), place: { at: 'board', index: i }, card, faceUp: true, order: i, fading: false });
    });
  }
  for (const v of view.seats) {
    if (v.bet > 0) chips.push({ id: `chips:bet:${v.seat}`, amount: v.bet, place: { at: 'bet', seat: v.seat }, order: 0 });
  }
  view.pots.forEach((p, i) => {
    if (p.amount > 0) chips.push({ id: `chips:pot:${i}`, amount: p.amount, place: { at: 'pot', index: i }, order: 0 });
  });
  return { cards, chips };
}

/** The data part after a full snapshot: the view wins; the queue, log and equities are dropped. */
export function dataFromView(prev: TableData, view: TableView): TableData {
  const { cards, chips } = entitiesFromView(view);
  const level =
    view.settings.kind === 'cash' ? (view.settings.levels[0] ?? prev.level) : (prev.level ?? view.settings.levels[0] ?? null);
  return {
    gameId: view.gameId,
    settings: view.settings,
    status: view.status,
    level,
    nextLevelAt: prev.nextLevelAt,
    handId: view.handId,
    handNumber: view.handNumber,
    buttonSeat: view.buttonSeat,
    seats: view.seats.map((v) => ({ ...v })),
    board: [...view.board],
    pots: view.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
    toAct: view.toAct,
    legal: view.legal,
    deadline: view.deadline,
    timeBank: null,
    mySeat: view.mySeat,
    myHole: [...view.myHole],
    myEquity: null,
    allInEquity: null,
    chat: view.chat.slice(-CHAT_LIMIT),
    chatError: null,
    seatRequests: [...view.seatRequests],
    results: prev.results,
    commitment: view.commitment,
    handLog: [],
    verified: null,
    lastError: null,
    cards,
    chips,
    queue: [],
    playing: null,
    animate: prev.animate,
  };
}

/**
 * `table:seats` rules. Name, avatar, `connected`, `sittingOut` and who sits where always come from the server.
 * - `keepAll` (steps queued, playing or a hand live on display): seats whose player is unchanged keep their
 *   displayed stack/bet/folded/allIn/hasCards/cardsVisible (the steps own them).
 * - `keepCards` (a finished hand still on display): they keep folded/hasCards/cardsVisible only.
 * - `server`: the server's values.
 */
export function mergeSeats(displayed: SeatView[], server: SeatView[], mode: 'keepAll' | 'keepCards' | 'server'): SeatView[] {
  return server.map((sv) => {
    const d = displayed.find((x) => x.seat === sv.seat);
    if (mode === 'server' || !d || d.playerId !== sv.playerId) return { ...sv };
    const cardsPart = { folded: d.folded, hasCards: d.hasCards, cardsVisible: d.cardsVisible };
    if (mode === 'keepCards') return { ...sv, ...cardsPart };
    return { ...sv, ...cardsPart, stack: d.stack, bet: d.bet, allIn: d.allIn };
  });
}
