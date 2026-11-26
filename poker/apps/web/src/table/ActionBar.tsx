/**
 * Action bar (W9, PLAN I-11 "DOM facts → ActionBar"). Plain DOM, rendered in the table overlay.
 *
 * - My turn: `mySeat !== null && toAct === mySeat && legal !== null`. Buttons Fold / Check or Call / Bet or
 *   Raise to, an amount slider + number field bounded by `legal.minTo..maxTo`, pot presets, "Use time bank".
 * - Amounts are "raise to" totals for this street (engine `PlayerAction`). Every amount sent is clamped to the
 *   bounds; the kind is `allIn` (no amount) when the chosen amount equals `maxTo`.
 * - After a send the bar is disabled until the store's `toAct`/`legal`/`handId` change (no double sends).
 * - Not my turn but in the hand: pre-action checkboxes "Check/Fold" and "Call any", acted on once when my
 *   turn arrives, cleared when a new hand starts.
 * - The bar slides up 200 ms easeOutCubic on my turn through `useTweenedPosition('panel:actionbar', …)`.
 */
import { formatPlayMoney, type ActionKind, type LegalActions } from '@poker/engine';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { easeOutCubic, useTweenedPosition, type Vec3 } from '../anim/tween.js';
import { getSocket } from '../api/socket.js';
import { useTable } from './storeContext.js';
import './actionBar.css';

/** How far (px) the bar sits below its resting place while it is not my turn. */
export const ACTION_BAR_LOWERED_PX = 28;
export const ACTION_BAR_SLIDE_MS = 200;

const UP: Vec3 = [0, 0, 0];
const DOWN: Vec3 = [0, ACTION_BAR_LOWERED_PX, 0];

const PRESETS: { label: string; fraction: number | 'allIn' }[] = [
  { label: '½ pot', fraction: 0.5 },
  { label: '¾ pot', fraction: 0.75 },
  { label: 'Pot', fraction: 1 },
  { label: 'All-in', fraction: 'allIn' },
];

export function clampAmount(n: number, legal: Pick<LegalActions, 'minTo' | 'maxTo'>): number {
  if (!Number.isFinite(n)) return legal.minTo;
  return Math.min(legal.maxTo, Math.max(legal.minTo, Math.round(n)));
}

/** Pot-sized "raise to": call + (pot after calling) × fraction + my current street bet, clamped. */
export function potSizedTo(
  fraction: number,
  legal: LegalActions,
  potTotal: number,
  myBet: number,
): number {
  const call = legal.canCheck ? 0 : legal.callAmount;
  const potAfterCall = potTotal + call;
  return clampAmount(myBet + call + potAfterCall * fraction, legal);
}

const money = (n: number): string => `$${formatPlayMoney(n)}`;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return isTypingTarget(t) || t.tagName === 'BUTTON' || t.tagName === 'A';
}

export function ActionBar({ gameId }: { gameId: string }) {
  const mySeat = useTable((s) => s.mySeat);
  if (mySeat === null) return null;
  return <SeatedActionBar gameId={gameId} mySeat={mySeat} />;
}

/** Identifies one turn: a send is allowed once per turn. */
interface TurnKey {
  legal: LegalActions | null;
  toAct: number | null;
  handId: string | null;
}

function sameTurn(a: TurnKey | null, b: TurnKey): boolean {
  return a !== null && a.legal === b.legal && a.toAct === b.toAct && a.handId === b.handId;
}

function SeatedActionBar({ gameId, mySeat }: { gameId: string; mySeat: number }) {
  const legal = useTable((s) => s.legal);
  const toAct = useTable((s) => s.toAct);
  const handId = useTable((s) => s.handId);
  const seats = useTable((s) => s.seats);
  const pots = useTable((s) => s.pots);
  const timeBank = useTable((s) => s.timeBank);
  const settings = useTable((s) => s.settings);

  const me = seats.find((s) => s.seat === mySeat) ?? null;
  const myTurn = toAct === mySeat && legal !== null;
  const turn: TurnKey = { legal, toAct, handId };

  // Send lock: the turn we already acted on. The ref guards synchronous double clicks; the state re-renders.
  const sentRef = useRef<TurnKey | null>(null);
  const [sent, setSent] = useState<TurnKey | null>(null);
  const locked = sameTurn(sent, turn);
  const enabled = myTurn && handId !== null && !locked;

  // Chosen amount, reset to minTo whenever a new `legal` arrives.
  const [amountState, setAmountState] = useState<{ legal: LegalActions | null; amount: number; text: string }>(
    () => ({ legal, amount: legal?.minTo ?? 0, text: String(legal?.minTo ?? 0) }),
  );
  let amountNow = amountState;
  if (amountState.legal !== legal) {
    amountNow = { legal, amount: legal?.minTo ?? 0, text: String(legal?.minTo ?? 0) };
    setAmountState(amountNow);
  }
  const chosen = legal ? clampAmount(amountNow.amount, legal) : 0;

  // "Use time bank" is asked for at most once per turn.
  const [bankAsked, setBankAsked] = useState<TurnKey | null>(null);

  const [checkFold, setCheckFold] = useState(false);
  const [callAny, setCallAny] = useState(false);

  // Untick pre-actions when a new hand starts.
  const prevHand = useRef(handId);
  useEffect(() => {
    if (prevHand.current !== handId) {
      prevHand.current = handId;
      setCheckFold(false);
      setCallAny(false);
    }
  }, [handId]);

  const potTotal =
    pots.reduce((sum, p) => sum + p.amount, 0) + seats.reduce((sum, s) => sum + s.bet, 0);
  const myBet = me?.bet ?? 0;
  const myStack = me?.stack ?? 0;

  const send = useCallback(
    (kind: ActionKind, amount?: number) => {
      const key: TurnKey = { legal, toAct, handId };
      if (!legal || toAct !== mySeat || handId === null) return;
      if (sameTurn(sentRef.current, key)) return;
      if (amount !== undefined && (amount < legal.minTo || amount > legal.maxTo)) return; // never out of range
      sentRef.current = key;
      setSent(key);
      const payload = amount === undefined ? { gameId, handId, kind } : { gameId, handId, kind, amount };
      getSocket().emit('table:action', payload);
    },
    [gameId, handId, legal, mySeat, toAct],
  );

  const canSizedBet = legal !== null && (legal.canBet || legal.canRaise);

  const sendBetRaise = useCallback(() => {
    if (!legal || !(legal.canBet || legal.canRaise)) return;
    const amount = clampAmount(amountNow.amount, legal);
    if (amount === legal.maxTo) send('allIn');
    else send(legal.canBet ? 'bet' : 'raise', amount);
  }, [amountNow.amount, legal, send]);

  const checkOrCall = useCallback(() => {
    if (!legal) return;
    if (legal.canCheck) send('check');
    else if (legal.callAmount > 0) send('call');
  }, [legal, send]);

  const fold = useCallback(() => {
    if (legal?.canFold) send('fold');
  }, [legal, send]);

  // Pre-actions: act once when my turn arrives with one ticked.
  useEffect(() => {
    if (!myTurn || !legal || handId === null) return;
    if (checkFold) {
      setCheckFold(false);
      if (legal.canCheck) send('check');
      else if (legal.canFold) send('fold');
    } else if (callAny) {
      setCallAny(false);
      if (legal.canCheck) send('check');
      else if (legal.callAmount > 0) send('call');
    }
  }, [myTurn, legal, handId, checkFold, callAny, send]);

  // Keyboard shortcuts while my turn is running.
  const amountRef = useRef<HTMLInputElement>(null);
  const handlers = useRef({ fold, checkOrCall, sendBetRaise });
  handlers.current = { fold, checkOrCall, sendBetRaise };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        handlers.current.fold();
      } else if (k === 'c') {
        e.preventDefault();
        handlers.current.checkOrCall();
      } else if (k === 'r') {
        if (amountRef.current) {
          e.preventDefault();
          amountRef.current.focus();
          amountRef.current.select();
        }
      } else if (e.key === 'Enter') {
        if (isInteractiveTarget(e.target)) return; // a focused button handles its own Enter
        e.preventDefault();
        handlers.current.sendBetRaise();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  const onFieldKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (legal) setAmountState({ legal, amount: chosen, text: String(chosen) });
      if (enabled) sendBetRaise();
    }
  };

  const setAmount = (n: number) => {
    if (!legal) return;
    const v = clampAmount(n, legal);
    setAmountState({ legal, amount: v, text: String(v) });
  };

  const y = useTweenedPosition('panel:actionbar', myTurn ? UP : DOWN, {
    durationMs: ACTION_BAR_SLIDE_MS,
    ease: easeOutCubic,
  })[1];

  const inHand = handId !== null && me !== null && me.hasCards && !me.folded && !me.allIn;
  const myBank = timeBank && timeBank.seat === mySeat ? timeBank : null;
  const showTimeBank =
    myTurn &&
    !sameTurn(bankAsked, turn) &&
    (settings?.timeBankSeconds ?? 1) > 0 &&
    !(myBank && (myBank.using || myBank.ms <= 0));

  const callAllIn = legal !== null && legal.callAmount >= myStack && myStack > 0;
  const betLabel = legal
    ? chosen === legal.maxTo
      ? `All-in ${money(chosen)}`
      : legal.canBet
        ? `Bet ${money(chosen)}`
        : `Raise to ${money(chosen)}`
    : '';

  return (
    <div
      className="action-bar"
      data-testid="action-bar"
      data-enabled={enabled ? 'true' : 'false'}
      style={{ transform: `translateY(${y}px)` }}
    >
      {myTurn && legal ? (
        <>
          {canSizedBet ? (
            <div className="action-bar-sizing">
              <div className="action-bar-presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="btn btn-sm action-bar-preset"
                    disabled={!enabled}
                    onClick={() =>
                      setAmount(p.fraction === 'allIn' ? legal.maxTo : potSizedTo(p.fraction, legal, potTotal, myBet))
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="action-bar-amount">
                <input
                  type="range"
                  className="action-bar-slider"
                  aria-label="Amount slider"
                  min={legal.minTo}
                  max={legal.maxTo}
                  step={1}
                  value={chosen}
                  disabled={!enabled}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  onKeyDown={onFieldKeyDown}
                />
                <label className="action-bar-field">
                  <span className="sr-only">Amount</span>
                  <input
                    ref={amountRef}
                    type="number"
                    inputMode="numeric"
                    min={legal.minTo}
                    max={legal.maxTo}
                    step={1}
                    value={amountNow.text}
                    disabled={!enabled}
                    onChange={(e) => {
                      const text = e.target.value;
                      const n = Number(text);
                      setAmountState({
                        legal,
                        amount: text.trim() === '' || !Number.isFinite(n) ? amountNow.amount : n,
                        text,
                      });
                    }}
                    onBlur={() => setAmount(amountNow.amount)}
                    onKeyDown={onFieldKeyDown}
                  />
                </label>
              </div>
            </div>
          ) : null}
          <div className="action-bar-buttons">
            {legal.canFold ? (
              <button type="button" className="btn btn-danger action-bar-btn" disabled={!enabled} onClick={fold}>
                Fold
              </button>
            ) : null}
            {legal.canCheck ? (
              <button type="button" className="btn action-bar-btn" disabled={!enabled} onClick={checkOrCall}>
                Check
              </button>
            ) : legal.callAmount > 0 ? (
              <button type="button" className="btn action-bar-btn" disabled={!enabled} onClick={checkOrCall}>
                {callAllIn ? `All-in ${money(legal.callAmount)}` : `Call ${money(legal.callAmount)}`}
              </button>
            ) : null}
            {canSizedBet ? (
              <button
                type="button"
                className="btn btn-primary action-bar-btn"
                disabled={!enabled}
                onClick={sendBetRaise}
              >
                {betLabel}
              </button>
            ) : null}
            {showTimeBank ? (
              <button
                type="button"
                className="btn btn-ghost action-bar-btn action-bar-timebank"
                disabled={handId === null || locked}
                onClick={() => {
                  if (sameTurn(bankAsked, turn)) return;
                  setBankAsked(turn);
                  getSocket().emit('table:useTimeBank', { gameId });
                }}
              >
                Use time bank
              </button>
            ) : null}
          </div>
        </>
      ) : inHand ? (
        <div className="action-bar-pre">
          <label className="action-bar-check">
            <input
              type="checkbox"
              checked={checkFold}
              onChange={(e) => {
                setCheckFold(e.target.checked);
                if (e.target.checked) setCallAny(false);
              }}
            />
            Check/Fold
          </label>
          <label className="action-bar-check">
            <input
              type="checkbox"
              checked={callAny}
              onChange={(e) => {
                setCallAny(e.target.checked);
                if (e.target.checked) setCheckFold(false);
              }}
            />
            Call any
          </label>
        </div>
      ) : null}
    </div>
  );
}
