/**
 * The table store, the director and the socket wiring (W11a, PLAN I-11).
 *
 * - `createTableStore()`: vanilla zustand store implementing every `TableActions` action by the step rules.
 *   Hand events become queued steps (`steps.ts`); `begin`/`consume` play them; card proofs are checked at once.
 * - `startDirector(store)` / `useDirector(store?)`: plays the queue in order, one step at a time, waiting each
 *   step's duration on the shared tween clock.
 * - `connectTable(gameId, store)`: joins the table and wires every socket event to the store.
 */
import { newClientSeed, type HandEvent, type SeatIndex } from '@poker/engine';
import type {
  ChatMessage,
  ErrorMessage,
  HandCommitment,
  HandEventMessage,
  TableClock,
  TableResults,
  TableSeats,
  TableStatusMessage,
  TableView,
} from '@poker/protocol';
import { useContext, useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { linear, tween, type TweenHandle } from '../anim/tween.js';
import { getSocket, joinTable, leaveTableRoom, onRejoin } from '../api/socket.js';
import {
  appendEvent,
  beginHead,
  CHAT_LIMIT,
  chipsOutAfter,
  consumeStep,
  dataFromView,
  mergeSeats,
  type StepContext,
} from './steps.js';
import { TableStoreContext } from './storeContext.js';
import { initialTableState, type TableData, type TableState } from './types.js';
import { createProofBook, proofVerdict, recordHandEvent, recordProof, type ProofBook } from './verify.js';

/** Proof books kept for hands whose steps may still be playing. */
const BOOKS_KEPT = 4;

export function createTableStore(): StoreApi<TableState> {
  let nextStepId = 1;
  let nextLogId = 1;
  let pendingClock: TableClock | null = null;
  const books = new Map<string, ProofBook>();
  let currentBook: ProofBook | null = null;
  /** A hand is live on display: between its `newHand` consume and its `handEnd` consume (or a mid-hand view). */
  let liveHand = false;

  const ctx: StepContext = {
    logId: () => nextLogId++,
    verdict: (handId) => {
      const book = handId === null ? undefined : books.get(handId);
      return book ? proofVerdict(book) : null;
    },
    takeClock: (seat: SeatIndex) => {
      if (pendingClock?.seat !== seat) return null;
      const c = pendingClock;
      pendingClock = null;
      return c;
    },
  };

  return createStore<TableState>()((set, get) => {
    const consumePlaying = <S extends TableData>(s: S): S => {
      const step = s.playing;
      if (!step) return s;
      const next = consumeStep(s, step, ctx);
      if (step.kind === 'newHand') liveHand = true;
      if (step.kind === 'handEnd') liveHand = false;
      return { ...next, playing: null };
    };

    const flushAll = <S extends TableData>(s: S): S => {
      let d = consumePlaying(s);
      while (d.queue.length > 0) d = consumePlaying(beginHead(d));
      return d;
    };

    return {
      ...initialTableState(),

      applyView(view: TableView) {
        const prev = get();
        pendingClock = null;
        if (currentBook && currentBook.handId !== view.handId) currentBook = null;
        liveHand = view.handId !== null;
        const data = dataFromView(prev, view);
        set({ ...data, verified: currentBook && liveHand ? 'pending' : null });
      },

      applyEvent(event: HandEvent) {
        if (event.type === 'cardProof') {
          if (currentBook) recordProof(currentBook, event);
          return;
        }
        if (event.type === 'handStarted') {
          currentBook = createProofBook(event, get().mySeat);
          books.set(event.handId, currentBook);
          while (books.size > BOOKS_KEPT) books.delete(books.keys().next().value as string);
        } else if (currentBook) {
          recordHandEvent(currentBook, event);
        }
        const s = get();
        const queue = appendEvent(s.queue, event, () => nextStepId++, chipsOutAfter(s.chips, [s.playing, ...s.queue]));
        if (queue === s.queue) return;
        set(s.animate ? { queue } : flushAll({ ...s, queue }));
      },

      applySeats(seats) {
        const s = get();
        const busy = s.queue.length > 0 || s.playing !== null || liveHand;
        const mode = busy ? 'keepAll' : s.handId !== null && s.cards.length > 0 ? 'keepCards' : 'server';
        set({ seats: mergeSeats(s.seats, seats, mode) });
      },

      applyClock(c) {
        const s = get();
        if (s.toAct === c.seat) {
          set({ deadline: c.deadline, timeBank: { seat: c.seat, ms: c.timeBankMs, using: c.usingTimeBank } });
        } else {
          pendingClock = c;
        }
      },

      applyStatus(m) {
        const patch: Partial<TableData> = { status: m.status };
        if (m.level !== undefined) {
          patch.level = m.level;
          patch.nextLevelAt = m.nextLevelAt ?? null;
        } else if (m.nextLevelAt !== undefined) {
          patch.nextLevelAt = m.nextLevelAt;
        }
        set(patch);
      },

      applyCommitment(c) {
        set({ commitment: c.commitment });
      },

      applyResults(r) {
        set({ results: [...r] });
      },

      addChat(m) {
        set({ chat: [...get().chat, m].slice(-CHAT_LIMIT) });
      },

      setChatError(e) {
        set({ chatError: e });
      },

      setError(e) {
        set({ lastError: e });
      },

      setMyEquity(e) {
        set({ myEquity: e });
      },

      begin(id: number) {
        const s = get();
        if (s.playing !== null || s.queue[0]?.id !== id) return;
        set(beginHead(s));
      },

      consume(id: number) {
        const s = get();
        if (s.playing?.id !== id) return;
        set(consumePlaying(s));
      },

      flush() {
        const s = get();
        if (!s.playing && s.queue.length === 0) return;
        set(flushAll(s));
      },

      reset() {
        pendingClock = null;
        books.clear();
        currentBook = null;
        liveHand = false;
        set({ ...initialTableState() });
      },
    };
  });
}

/** The live singleton. */
export const tableStore: StoreApi<TableState> = createTableStore();

/** Zustand hook bound to `tableStore`. */
export function useTableStore<T>(selector: (s: TableState) => T): T {
  return useStore(tableStore, selector);
}

// ---------------------------------------------------------------------------------------------------------
// Director

/** Catch-up (I-11): with more than 8 steps waiting play at half duration, more than 20 at a quarter. */
export function catchUpFactor(waiting: number): number {
  if (waiting > 20) return 0.25;
  if (waiting > 8) return 0.5;
  return 1;
}

/**
 * Plays the store's queue: when nothing is playing and the queue is not empty, `begin(head)`, wait the
 * step's duration (scaled by `catchUpFactor` of the steps waiting, head included) with a scalar tween on
 * the shared tween clock, `consume`, continue. 0 ms steps are consumed at once. Returns a stop function.
 */
export function startDirector(store: StoreApi<TableState>): () => void {
  let stopped = false;
  let pumping = false;
  let waitingFor: number | null = null;
  let handle: TweenHandle | null = null;

  const wait = (id: number, durationMs: number): void => {
    waitingFor = id;
    handle = tween({
      id: 'step:' + id,
      from: 0,
      to: 1,
      durationMs,
      ease: linear,
      onUpdate() {},
      onDone() {
        if (waitingFor !== id) return;
        waitingFor = null;
        handle = null;
        if (!stopped) store.getState().consume(id);
        pump();
      },
    });
  };

  function pump(): void {
    if (stopped || pumping) return;
    pumping = true;
    try {
      for (;;) {
        const s = store.getState();
        if (waitingFor !== null) {
          if (s.playing?.id === waitingFor) return;
          // The step was consumed or dropped elsewhere (flush, applyView): stop waiting for it.
          handle?.cancel();
          handle = null;
          waitingFor = null;
        }
        if (s.playing) {
          // Begun by someone else: play out its duration all the same.
          wait(s.playing.id, s.playing.durationMs * catchUpFactor(s.queue.length + 1));
          return;
        }
        const head = s.queue[0];
        if (!head) return;
        const factor = catchUpFactor(s.queue.length);
        s.begin(head.id);
        const playing = store.getState().playing;
        if (playing?.id !== head.id) return;
        const ms = playing.durationMs * factor;
        if (ms <= 0) {
          store.getState().consume(head.id);
          continue;
        }
        wait(head.id, ms);
        return;
      }
    } finally {
      pumping = false;
    }
  }

  const unsubscribe = store.subscribe(() => pump());
  pump();
  return () => {
    stopped = true;
    unsubscribe();
    waitingFor = null;
    handle?.cancel();
    handle = null;
  };
}

/** Plays the queue of `store` (default: the context store) while mounted. Mount once per table. */
export function useDirector(store?: StoreApi<TableState>): void {
  const fromContext = useContext(TableStoreContext);
  const target = store ?? fromContext;
  if (!target) throw new Error('useDirector needs a store or a <TableStoreProvider>');
  useEffect(() => startDirector(target), [target]);
}

// ---------------------------------------------------------------------------------------------------------
// Socket wiring

/** Joins `gameId` and wires every table socket event to `store`. Returns the disconnect function. */
export function connectTable(gameId: string, store: StoreApi<TableState> = tableStore): () => void {
  const socket = getSocket();
  let alive = true;
  const st = () => store.getState();
  const mine = (p: { gameId: string }): boolean => alive && p.gameId === gameId;

  const onView = (v: TableView) => {
    if (mine(v)) st().applyView(v);
  };
  const onEvent = (m: HandEventMessage) => {
    if (mine(m)) st().applyEvent(m.event);
  };
  const onCommitment = (c: HandCommitment) => {
    if (!mine(c)) return;
    st().applyCommitment(c);
    socket.emit('table:clientSeed', { gameId, handNumber: c.handNumber, clientSeed: newClientSeed() });
  };
  const onSeats = (m: TableSeats) => {
    if (mine(m)) st().applySeats(m.seats);
  };
  const onClock = (c: TableClock) => {
    if (mine(c)) st().applyClock(c);
  };
  const onStatus = (m: TableStatusMessage) => {
    if (mine(m)) st().applyStatus(m);
  };
  const onResults = (m: TableResults) => {
    if (mine(m)) st().applyResults(m.results);
  };
  const onChat = (m: ChatMessage) => {
    if (mine(m)) st().addChat(m);
  };
  // `error` carries no game id; it belongs to whatever this socket did last, so it goes to the open table.
  const onError = (e: ErrorMessage) => {
    if (!alive) return;
    if (e.code === 'rate_limited') st().setChatError(e.message);
    else st().setError(e.message);
  };

  socket.on('table:view', onView);
  socket.on('hand:event', onEvent);
  socket.on('hand:commitment', onCommitment);
  socket.on('table:seats', onSeats);
  socket.on('table:clock', onClock);
  socket.on('table:status', onStatus);
  socket.on('table:results', onResults);
  socket.on('chat:message', onChat);
  socket.on('error', onError);
  const offRejoin = onRejoin(onView);

  joinTable(gameId).then(
    (view) => {
      if (alive) st().applyView(view);
    },
    (err: unknown) => {
      if (alive) st().setError(err instanceof Error ? err.message : String(err));
    },
  );

  return () => {
    if (!alive) return;
    alive = false;
    socket.off('table:view', onView);
    socket.off('hand:event', onEvent);
    socket.off('hand:commitment', onCommitment);
    socket.off('table:seats', onSeats);
    socket.off('table:clock', onClock);
    socket.off('table:status', onStatus);
    socket.off('table:results', onResults);
    socket.off('chat:message', onChat);
    socket.off('error', onError);
    offRejoin();
    leaveTableRoom(gameId);
    store.getState().reset();
  };
}
