/**
 * Seat HUD (W8; PLAN I-11 "DOM facts → Seat").
 * - `SeatHudView`: the plain-DOM HUD of one seat (avatar, name, stack, status chips, equity badge, hole cards as
 *   screen-reader text, turn ring, "Your turn"), or the empty-seat "Sit at seat n" button / placeholder.
 * - `SeatHud`: the same inside the r3f Canvas, anchored at the seat with `DomAnchor` (DomAnchor.tsx, a
 *   StrictMode-safe equivalent of drei `<Html center>` that re-provides the table contexts in its own root).
 * - `DealerButton`: the "D" marker, tweening between seats.
 */
import { formatCard, formatPlayMoney, type Card, type SeatIndex } from '@poker/engine';
import { useState } from 'react';
import { easeOutBack, useTween, useTweenedPosition } from '../anim/tween.js';
import { DomAnchor } from './DomAnchor.js';
import { useNotes } from './NotesPopover.js';
import { useScene, useSeatActions } from './sceneContext.js';
import { useTable } from './storeContext.js';
import { TurnRing } from './TurnRing.js';
import type { Equity } from './types.js';
import './seatHud.css';

/** Scale of the active seat. */
export const ACTIVE_SCALE = 1.06;
const SCALE_MS = 320;
const STACK_MS = 300;

// ---------------------------------------------------------------------------------------------------------
// Avatar

const AVATAR_COLORS = ['#1f6b47', '#3b5f8a', '#7a4f8f', '#8a5a2b', '#2f7a7a', '#8a3b4a', '#5a6b2b', '#4a4f8a'];

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  const out = letters.join('').toUpperCase();
  return out === '' ? '?' : out;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** An inline SVG data URL with the player's initials on a colour picked from the name. */
export function initialsAvatarUrl(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length]!;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${bg}"/>` +
    `<text x="32" y="33" dominant-baseline="middle" text-anchor="middle" fill="#fff" ` +
    `font-family="system-ui, sans-serif" font-size="26" font-weight="600">${escapeXml(initialsOf(name))}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function Avatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const fallback = avatarUrl === null || failed;
  return (
    <img
      className="seat-hud__avatar"
      src={fallback ? initialsAvatarUrl(name) : avatarUrl}
      alt={name}
      data-fallback={fallback ? 'true' : 'false'}
      draggable={false}
      onError={fallback ? undefined : () => setFailed(true)}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------
// Pieces

function pct(x: number): number {
  return Math.round(x * 100);
}

function EquityBadge({ seat, equity }: { seat: SeatIndex; equity: Equity }) {
  return (
    <span className="seat-hud__equity mono" data-testid={`equity-${seat}`}>
      {`Win ${pct(equity.win)}%`}
      {equity.tie >= 0.005 && <span className="seat-hud__tie">{` Tie ${pct(equity.tie)}%`}</span>}
    </span>
  );
}

function CardSpans({ cards }: { cards: Card[] }) {
  return (
    <>
      {cards.map((c, i) => {
        const text = formatCard(c);
        return (
          <span key={i} className="sr-only" data-card={text}>
            {text}
          </span>
        );
      })}
    </>
  );
}

function EmptySeat({ seat }: { seat: SeatIndex }) {
  const mySeat = useTable((s) => s.mySeat);
  const finished = useTable((s) => s.status === 'finished');
  const { onSit } = useSeatActions();
  const canSit = mySeat === null && !finished;
  return (
    <div className="seat-hud seat-hud--empty" data-testid={`seat-${seat}`} data-active="false" data-me="false" data-empty="true">
      {canSit ? (
        <button type="button" className="seat-hud__sit" onClick={() => onSit(seat)} aria-label={`Sit at seat ${seat + 1}`}>
          <span aria-hidden="true">+</span>
          <span className="seat-hud__sit-text" aria-hidden="true">
            Sit
          </span>
        </button>
      ) : (
        <span className="seat-hud__placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// SeatHudView

export function SeatHudView({ seat }: { seat: SeatIndex }) {
  const player = useTable((s) => s.seats.find((p) => p.seat === seat) ?? null);
  const mySeat = useTable((s) => s.mySeat);
  const toAct = useTable((s) => s.toAct);
  const myHole = useTable((s) => s.myHole);
  const myEquity = useTable((s) => s.myEquity);
  const allInEquity = useTable((s) => s.allInEquity);
  const notes = useNotes();
  const { onOpenNotes } = useSeatActions();

  const active = player !== null && toAct === seat;
  const stack = useTween(player?.stack ?? 0, { id: 'stack:' + seat, durationMs: STACK_MS });
  const scale = useTween(active ? ACTIVE_SCALE : 1, { id: 'seat-scale:' + seat, durationMs: SCALE_MS, ease: easeOutBack });

  if (player === null) return <EmptySeat seat={seat} />;

  const isMe = mySeat === seat;
  const myTurn = isMe && toAct === mySeat;
  const equity: Equity | null =
    allInEquity !== null ? (allInEquity[seat] ?? null) : isMe && myEquity !== null ? myEquity : null;
  const note = notes[player.playerId];
  const shown = player.cardsVisible !== null && player.cardsVisible.length > 0 ? player.cardsVisible : null;

  const who = (
    <>
      <span className="seat-hud__avatar-wrap">
        <Avatar key={player.avatarUrl ?? ''} name={player.name} avatarUrl={player.avatarUrl} />
        {active && <TurnRing seat={seat} />}
        {note && (
          <span
            className="seat-hud__note"
            data-testid={`note-dot-${seat}`}
            style={note.color ? { background: note.color } : undefined}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="seat-hud__name" title={player.name}>
        {player.name}
      </span>
    </>
  );

  const classes = ['seat-hud'];
  if (active) classes.push('seat-hud--active');
  if (isMe) classes.push('seat-hud--me');
  if (player.folded) classes.push('seat-hud--folded');
  if (!player.connected) classes.push('seat-hud--away');

  return (
    <div
      className={classes.join(' ')}
      data-testid={`seat-${seat}`}
      data-active={active ? 'true' : 'false'}
      data-me={isMe ? 'true' : 'false'}
      style={{ transform: `scale(${scale})` }}
    >
      {isMe ? (
        <div className="seat-hud__who">{who}</div>
      ) : (
        <button
          type="button"
          className="seat-hud__who seat-hud__who--button"
          onClick={() => onOpenNotes(player.playerId, player.name)}
          aria-label={`Notes on ${player.name}`}
          title={note?.text ? note.text : `Notes on ${player.name}`}
        >
          {who}
        </button>
      )}
      <span className="seat-hud__stack mono" data-testid={`stack-${seat}`}>
        {formatPlayMoney(Math.round(stack))}
      </span>
      <span className="seat-hud__chips">
        {player.folded && <span className="seat-hud__chip seat-hud__chip--folded">Folded</span>}
        {player.allIn && <span className="seat-hud__chip seat-hud__chip--allin">All-in</span>}
        {!player.connected && <span className="seat-hud__chip seat-hud__chip--away">Away</span>}
        {equity !== null && <EquityBadge seat={seat} equity={equity} />}
      </span>
      {isMe ? (
        <span data-testid="my-hole">
          <CardSpans cards={myHole} />
        </span>
      ) : shown !== null ? (
        <span data-testid={`hole-${seat}`} data-face="up">
          <CardSpans cards={shown} />
        </span>
      ) : player.hasCards ? (
        <span data-testid={`hole-${seat}`} data-face="down">
          <span className="sr-only">Cards face down</span>
        </span>
      ) : null}
      {isMe && (
        <span className="seat-hud__turn" aria-live="polite">
          {myTurn ? 'Your turn' : ''}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// In the Canvas

export function SeatHud({ seat }: { seat: SeatIndex }) {
  const scene = useScene();
  const position = useTweenedPosition('seat:' + seat, scene.seatPosition(seat));
  // DomAnchor renders in its own React root and re-provides the table store, scene and seat-action contexts.
  return (
    <group position={position}>
      <DomAnchor zIndex={20}>
        <SeatHudView seat={seat} />
      </DomAnchor>
    </group>
  );
}

function DealerDisc({ seat }: { seat: SeatIndex }) {
  const scene = useScene();
  const position = useTweenedPosition('button', scene.buttonPosition(seat));
  return (
    <group position={position}>
      <mesh position={[0, 0.015, 0]}>
        <cylinderGeometry args={[0.12, 0.12, 0.03, 32]} />
        <meshStandardMaterial color="#f4f1e8" roughness={0.5} />
      </mesh>
      <DomAnchor zIndex={10} pointerEvents="none">
        <span className="dealer-button" data-testid="dealer-button" aria-label="Dealer button">
          D
        </span>
      </DomAnchor>
    </group>
  );
}

export function DealerButton() {
  const buttonSeat = useTable((s) => s.buttonSeat);
  if (buttonSeat === null) return null;
  return <DealerDisc seat={buttonSeat} />;
}
