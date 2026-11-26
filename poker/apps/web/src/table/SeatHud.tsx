/**
 * Seat HUD (W8; PLAN I-11 "DOM facts → Seat").
 * - `SeatHudView`: the plain-DOM HUD of one seat (avatar, name, stack, status chips, equity badge, hole cards as
 *   screen-reader text, turn ring, "Your turn"), or the empty-seat "Sit at seat n" button / placeholder.
 * - `SeatHud`: the same inside the r3f Canvas, anchored at the seat with `DomAnchor` (a StrictMode-safe
 *   equivalent of drei `<Html center>`, see there). It renders into a separate React root, so the table store,
 *   scene and seat-action contexts are read here and provided again inside it.
 * - `DealerButton`: the "D" marker, tweening between seats.
 */
import { formatCard, formatPlayMoney, type Card, type SeatIndex } from '@poker/engine';
import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Vector3, type Group } from 'three';
import { easeOutBack, useTween, useTweenedPosition } from '../anim/tween.js';
import { useNotes } from './NotesPopover.js';
import { SceneContext, SeatActionsContext, useScene, useSeatActions } from './sceneContext.js';
import { TableStoreProvider, useTable, useTableStoreApi } from './storeContext.js';
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

/**
 * A minimal stand-in for drei `<Html center>` (screen-space DOM anchored at this group's world position).
 *
 * Why not drei's `<Html>`: it creates its React root in a layout effect and unmounts it synchronously in that
 * effect's cleanup, on one shared container element. Under React StrictMode (main.tsx) every layout effect is
 * run, cleaned up and run again on mount, so each HUD logged "Attempted to synchronously unmount a root while
 * React was already rendering", and the deferred unmount of the first root raced the second root on the same
 * element, which sometimes left a HUD (seen on seat 0) empty and missing from the DOM. The same happens when
 * its mount target changes (r3f connects `events.connected` after the first commit).
 *
 * Here every mount gets a fresh container element and its own root, and the old root is unmounted after the
 * commit (`setTimeout`), so nothing is shared and nothing unmounts during a render. Like drei, the children
 * render in a separate React root, so callers re-provide the contexts they need.
 */
function DomAnchor({
  children,
  zIndex,
  pointerEvents = 'auto',
}: {
  children: ReactNode;
  zIndex: number;
  pointerEvents?: 'auto' | 'none';
}) {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const connected = useThree((s) => s.events.connected as unknown);
  const canvasParent = useThree((s) => s.gl.domElement.parentNode);
  const target = connected instanceof HTMLElement ? connected : canvasParent instanceof HTMLElement ? canvasParent : null;
  const group = useRef<Group>(null);
  const holder = useRef<{ el: HTMLDivElement; root: Root } | null>(null);
  const last = useRef({ x: NaN, y: NaN, hidden: false });
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const place = useCallback(() => {
    const h = holder.current;
    const g = group.current;
    if (!h || !g) return;
    g.updateWorldMatrix(true, false);
    const v = new Vector3().setFromMatrixPosition(g.matrixWorld).project(camera);
    const hidden = v.z < -1 || v.z > 1; // behind the camera or past the far plane
    const x = (v.x * 0.5 + 0.5) * sizeRef.current.width;
    const y = (-v.y * 0.5 + 0.5) * sizeRef.current.height;
    const l = last.current;
    if (hidden !== l.hidden) h.el.style.display = hidden ? 'none' : 'block';
    if (Math.abs(x - l.x) > 0.01 || Math.abs(y - l.y) > 0.01 || Number.isNaN(l.x)) {
      h.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    last.current = { x, y, hidden };
  }, [camera]);

  useLayoutEffect(() => {
    if (!target) return;
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;z-index:${zIndex};`;
    target.appendChild(el);
    const root = createRoot(el);
    holder.current = { el, root };
    last.current = { x: NaN, y: NaN, hidden: false };
    place();
    return () => {
      if (holder.current?.root === root) holder.current = null;
      el.remove();
      setTimeout(() => root.unmount(), 0);
    };
  }, [target, zIndex, place]);

  // Re-render the children into the root on every commit (like drei).
  useLayoutEffect(() => {
    holder.current?.root.render(
      <div style={{ position: 'absolute', transform: 'translate3d(-50%,-50%,0)', pointerEvents }}>{children}</div>,
    );
  });

  // Re-place after every commit (the group moved, the canvas resized) and on every drawn frame (camera moves).
  useLayoutEffect(() => {
    place();
  });
  useFrame(place);

  return <group ref={group} />;
}

export function SeatHud({ seat }: { seat: SeatIndex }) {
  const store = useTableStoreApi();
  const scene = useScene();
  const actions = useSeatActions();
  const position = useTweenedPosition('seat:' + seat, scene.seatPosition(seat));
  return (
    <group position={position}>
      <DomAnchor zIndex={20}>
        <TableStoreProvider store={store}>
          <SceneContext.Provider value={scene}>
            <SeatActionsContext.Provider value={actions}>
              <SeatHudView seat={seat} />
            </SeatActionsContext.Provider>
          </SceneContext.Provider>
        </TableStoreProvider>
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
