/**
 * The table page (W11b, PLAN I-11): route `/table/:id`.
 *
 * Connects the live table store (`connectTable`), provides it to every table component, mounts the director once,
 * and composes the 3D table (Cards, Chips, DealerButton, one SeatHud per seat) with the DOM around it: header and
 * status banner, ActionBar overlay, chat, hand log, sit dialog, leave/rebuy/start buttons, the host slide-over,
 * seat requests and the game-over panel. It also asks the equity worker for my own equity on every change.
 */
import {
  formatCard,
  formatPlayMoney,
  newClientSeed,
  type Card,
  type SeatIndex,
} from "@poker/engine";
import type { HostCommand } from "@poker/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { Link, useParams } from "react-router";
import { easeOutCubic, useTweenedPosition } from "../anim/tween.js";
import { api, ApiError } from "../api/client.js";
import { getSocket } from "../api/socket.js";
import { useMe } from "../api/useMe.js";
import { ActionBar } from "../table/ActionBar.js";
import { Cards } from "../table/Cards.js";
import { ChatPanel } from "../table/ChatPanel.js";
import { Chips } from "../table/Chips.js";
import { NotesPopover } from "../table/NotesPopover.js";
import { DealerButton, SeatHud } from "../table/SeatHud.js";
import { SeatActionsContext, type SeatActions } from "../table/sceneContext.js";
import {
  TableStoreProvider,
  useTable,
  useTableStoreApi,
} from "../table/storeContext.js";
import { Table3D } from "../table/Table3D.js";
import type { TableState } from "../table/types.js";
import {
  connectTable,
  tableStore,
  useDirector,
} from "../table/useTableStore.js";
import { useEquity } from "../workers/useEquity.js";
import { HostPanel } from "./HostPanel.js";
import "../table/table.css";

/** The part of `GET /api/games/:id` this page reads. */
interface GameInfo {
  id: string;
  name: string;
  host: { id: string; displayName: string };
  isHost: boolean;
}

type GameLoad =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "ok"; game: GameInfo };

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}

/** 252_000 → "04:12" (whole seconds, rounded up, never negative). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function emitHost(gameId: string, command: HostCommand): void {
  getSocket().emit("host:command", { gameId, command });
}

export function TablePage(): JSX.Element {
  const { id = "" } = useParams();
  const [load, setLoad] = useState<GameLoad>({ kind: "loading" });

  const { me } = useMe();
  const myId = me?.id ?? null;
  useEffect(() => (myId === null ? undefined : connectTable(id, tableStore, myId)), [id, myId]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ kind: "loading" });
    api<GameInfo>(`/api/games/${id}`, { signal: ctrl.signal })
      .then((game) => setLoad({ kind: "ok", game }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoad({
          kind: "error",
          status: e instanceof ApiError ? e.status : 0,
          message: errorText(e),
        });
      });
    return () => ctrl.abort();
  }, [id]);

  if (load.kind === "error" && (load.status === 403 || load.status === 404)) {
    return (
      <div className="page stack">
        <h1>{load.status === 403 ? "No access" : "Game not found"}</h1>
        <p role="alert" className="alert">
          {load.status === 403
            ? "You don't have access to this game"
            : "This game does not exist."}
        </p>
        <p>
          <Link to="/">Back to the lobby</Link>
        </p>
      </div>
    );
  }

  return (
    <TableStoreProvider store={tableStore}>
      <TableScreen
        gameId={id}
        game={load.kind === "ok" ? load.game : null}
        loadError={load.kind === "error" ? load.message : null}
      />
    </TableStoreProvider>
  );
}

/** Mounts the director once inside the provider. */
function Director(): null {
  useDirector(tableStore);
  return null;
}

function TableScreen({
  gameId,
  game,
  loadError,
}: {
  gameId: string;
  game: GameInfo | null;
  loadError: string | null;
}): JSX.Element {
  const { me } = useMe();
  const store = useTableStoreApi();
  const settings = useTable((s) => s.settings);
  const status = useTable((s) => s.status);
  const seats = useTable((s) => s.seats);
  const mySeat = useTable((s) => s.mySeat);
  const level = useTable((s) => s.level);
  const lastError = useTable((s) => s.lastError);
  const results = useTable((s) => s.results);

  const [sitSeat, setSitSeat] = useState<SeatIndex | null>(null);
  const [notes, setNotes] = useState<{
    subjectId: string;
    name: string;
  } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);

  const isHost = game !== null && me !== null && me.id === game.host.id;
  const mine =
    mySeat === null ? undefined : seats.find((s) => s.seat === mySeat);
  const seated = mine !== undefined;
  const maxSeats = settings?.maxSeats ?? 0;
  const currentLevel = level ?? settings?.levels[0] ?? null;

  const seatActions = useMemo<SeatActions>(
    () => ({
      onSit: (seat) => setSitSeat(seat),
      onOpenNotes: (playerId, name) => setNotes({ subjectId: playerId, name }),
    }),
    [],
  );

  const canRebuy =
    settings?.kind === "tournament" &&
    mine !== undefined &&
    mine.stack === 0 &&
    settings.rebuys.allowed &&
    (currentLevel?.level ?? 1) <= settings.rebuys.untilLevel;

  const seatNumbers = Array.from({ length: maxSeats }, (_, n) => n);

  return (
    <SeatActionsContext.Provider value={seatActions}>
      <Director />
      <EquityRequests />
      <div className="table-page">
        <header className="table-header">
          <div className="table-title">
            <h1>{game?.name ?? "Table"}</h1>
            <span className="badge badge-gold">Play money</span>
          </div>
          <StatusBanner />
          {currentLevel && (
            <span className="table-stakes mono" title="Blinds">
              {formatPlayMoney(currentLevel.smallBlind)}/
              {formatPlayMoney(currentLevel.bigBlind)}
            </span>
          )}
          <div className="table-buttons">
            {isHost && status === "waiting" && seats.length >= 2 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => emitHost(gameId, { kind: "start" })}
              >
                Start game
              </button>
            )}
            {canRebuy && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => getSocket().emit("table:rebuy", { gameId })}
              >
                Rebuy
              </button>
            )}
            {seated &&
              (confirmLeave ? (
                <span
                  className="table-confirm"
                  role="group"
                  aria-label="Leave the table?"
                >
                  <span>Leave the table?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      getSocket().emit("table:leave", { gameId });
                      setConfirmLeave(false);
                    }}
                  >
                    Yes, leave
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmLeave(false)}
                  >
                    Stay
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirmLeave(true)}
                >
                  Leave table
                </button>
              ))}
            {isHost && (
              <button
                type="button"
                className="btn"
                aria-expanded={hostOpen}
                aria-controls="table-host-panel"
                onClick={() => setHostOpen((o) => !o)}
              >
                Host panel
              </button>
            )}
          </div>
        </header>

        {loadError && (
          <p role="alert" className="alert">
            {loadError}
          </p>
        )}
        {lastError && (
          <div role="alert" className="alert table-error">
            <span>{lastError}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Dismiss"
              onClick={() => store.getState().setError(null)}
            >
              ×
            </button>
          </div>
        )}

        {isHost && <SeatRequests gameId={gameId} />}

        {status === "finished" && (
          <GameOver gameId={gameId} results={results} />
        )}

        <div className="table-main">
          <div className="table-stage">
            <Table3D
              overlay={
                <div className="table-overlay">
                  <div className="table-overlay-bottom">
                    <ActionBar gameId={gameId} />
                  </div>
                </div>
              }
            >
              <Cards />
              <Chips />
              <DealerButton />
              {seatNumbers.map((n) => (
                <SeatHud key={n} seat={n} />
              ))}
            </Table3D>
            <BoardText />
          </div>

          <aside className="table-side">
            <details className="table-side-section" open>
              <summary>Chat</summary>
              <ChatPanel gameId={gameId} />
            </details>
            <details className="table-side-section" open>
              <summary>Hand log</summary>
              <HandLog />
            </details>
          </aside>
        </div>
      </div>

      {sitSeat !== null && settings && (
        <SitDialog
          gameId={gameId}
          seat={sitSeat}
          settings={settings}
          onClose={() => setSitSeat(null)}
        />
      )}
      {notes && (
        <NotesPopover
          subjectId={notes.subjectId}
          name={notes.name}
          onClose={() => setNotes(null)}
        />
      )}
      {isHost && (
        <HostSlideOver
          gameId={gameId}
          open={hostOpen}
          onClose={() => setHostOpen(false)}
        />
      )}
    </SeatActionsContext.Provider>
  );
}

function statusText(
  s: Pick<TableState, "status" | "level" | "nextLevelAt" | "handNumber">,
  kind: string | undefined,
  now: number,
): string {
  switch (s.status) {
    case "waiting":
      return "Waiting for players";
    case "paused":
      return "Paused";
    case "finished":
      return "Game over";
    case "running":
      if (kind === "tournament" && s.level) {
        return s.nextLevelAt !== null
          ? `Level ${s.level.level} · next level in ${formatCountdown(s.nextLevelAt - now)}`
          : `Level ${s.level.level}`;
      }
      return s.handNumber > 0 ? `Hand #${s.handNumber}` : "Playing";
  }
}

function StatusBanner(): JSX.Element {
  const status = useTable((s) => s.status);
  const level = useTable((s) => s.level);
  const nextLevelAt = useTable((s) => s.nextLevelAt);
  const handNumber = useTable((s) => s.handNumber);
  const kind = useTable((s) => s.settings?.kind);
  const [now, setNow] = useState(() => Date.now());
  const ticking = status === "running" && nextLevelAt !== null;

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, nextLevelAt]);

  return (
    <span
      className={`table-status table-status-${status}`}
      data-testid="table-status"
      role="status"
    >
      {statusText({ status, level, nextLevelAt, handNumber }, kind, now)}
    </span>
  );
}

function BoardText(): JSX.Element {
  const board = useTable((s) => s.board);
  return (
    <div className="sr-only" data-testid="board" aria-label="Board">
      {board.map((c, i) => {
        const text = formatCard(c);
        return (
          <span key={i} className="sr-only" data-card={text}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

function HandLog(): JSX.Element {
  const lines = useTable((s) => s.handLog);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <ol
      className="table-log"
      data-testid="hand-log"
      ref={ref}
      aria-live="polite"
    >
      {lines.map((l) => (
        <li key={l.id} className={`table-log-${l.tone}`}>
          {l.text}
        </li>
      ))}
    </ol>
  );
}

/** Asks the equity worker for my equity whenever my cards, the board, the opponents or my folded state change. */
function EquityRequests(): null {
  const requestEquity = useEquity();
  const myHole = useTable((s) => s.myHole);
  const board = useTable((s) => s.board);
  const mySeat = useTable((s) => s.mySeat);
  const opponents = useTable(
    (s) =>
      s.seats.filter((v) => v.hasCards && !v.folded && v.seat !== s.mySeat)
        .length,
  );
  const folded = useTable((s) =>
    s.mySeat === null
      ? false
      : (s.seats.find((v) => v.seat === s.mySeat)?.folded ?? false),
  );
  const holeRef = useRef<Card[]>(myHole);
  holeRef.current = myHole;
  const boardRef = useRef<Card[]>(board);
  boardRef.current = board;
  const holeKey = myHole.join(",");
  const boardKey = board.join(",");

  useEffect(() => {
    const hole = holeRef.current;
    if (mySeat !== null && hole.length === 2 && !folded && opponents > 0) {
      requestEquity({
        hole: [...hole],
        board: [...boardRef.current],
        opponents,
      });
    } else {
      requestEquity(null);
    }
  }, [requestEquity, holeKey, boardKey, opponents, folded, mySeat]);

  return null;
}

function SeatRequests({ gameId }: { gameId: string }): JSX.Element | null {
  const requests = useTable((s) => s.seatRequests);
  if (requests.length === 0) return null;
  return (
    <section className="card table-requests" aria-label="Seat requests">
      <ul>
        {requests.map((r) => (
          <li key={r.playerId}>
            <span>{r.name} wants to sit</span>
            <span className="row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  emitHost(gameId, {
                    kind: "approveSeat",
                    playerId: r.playerId,
                    approve: true,
                  })
                }
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  emitHost(gameId, {
                    kind: "approveSeat",
                    playerId: r.playerId,
                    approve: false,
                  })
                }
              >
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GameOver({
  gameId,
  results,
}: {
  gameId: string;
  results: TableState["results"];
}): JSX.Element {
  const sorted = results ? [...results].sort((a, b) => a.place - b.place) : [];
  return (
    <section
      className="card table-gameover"
      aria-labelledby="table-gameover-heading"
    >
      <h2 id="table-gameover-heading">Game over</h2>
      {sorted.length > 0 ? (
        <ol className="table-results">
          {sorted.map((r) => (
            <li key={r.userId}>
              <span className="table-results-place">{r.place}.</span>
              <span className="table-results-name">{r.name}</span>
              <span className="mono">{formatPlayMoney(r.prize)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">The results are on their way.</p>
      )}
      <div className="row">
        <Link className="btn btn-primary" to={`/results/${gameId}`}>
          Results
        </Link>
        <Link className="btn" to={`/settle/${gameId}`}>
          Settle up
        </Link>
        <Link className="btn btn-ghost" to={`/games/${gameId}`}>
          Back to game
        </Link>
      </div>
    </section>
  );
}

type WalletLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; balance: number };

function SitDialog({
  gameId,
  seat,
  settings,
  onClose,
}: {
  gameId: string;
  seat: SeatIndex;
  settings: NonNullable<TableState["settings"]>;
  onClose(): void;
}): JSX.Element {
  const [wallet, setWallet] = useState<WalletLoad>({ kind: "loading" });
  const [amount, setAmount] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const tournament = settings.kind === "tournament";

  useEffect(() => {
    const ctrl = new AbortController();
    api<{ balance: number }>("/api/wallet", { signal: ctrl.signal })
      .then((w) => setWallet({ kind: "ok", balance: w.balance }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setWallet({ kind: "error", message: errorText(e) });
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const min = tournament ? settings.startingStack : settings.minBuyIn;
  const max =
    wallet.kind === "ok"
      ? Math.min(
          tournament ? settings.startingStack : settings.maxBuyIn,
          wallet.balance,
        )
      : 0;
  const balance = wallet.kind === "ok" ? wallet.balance : null;
  const tooPoor = balance !== null && balance < min;

  // Default to the top of the range once the wallet is known.
  useEffect(() => {
    if (wallet.kind === "ok" && !tooPoor) setAmount(max);
  }, [wallet.kind, tooPoor, max]);

  const buyIn = tournament ? settings.startingStack : amount;
  const valid =
    wallet.kind === "ok" &&
    !tooPoor &&
    buyIn !== null &&
    Number.isSafeInteger(buyIn) &&
    buyIn >= min &&
    buyIn <= max;

  const sit = (): void => {
    if (!valid || buyIn === null) return;
    getSocket().emit("table:sit", {
      gameId,
      seat,
      buyIn,
      clientSeed: newClientSeed(),
    });
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="table-dialog-backdrop">
      <div
        className="table-dialog card stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-sit-heading"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h2 id="table-sit-heading">Sit down</h2>
        <p className="muted">Seat {seat + 1}</p>
        {wallet.kind === "loading" && (
          <p className="muted">Checking your wallet…</p>
        )}
        {wallet.kind === "error" && (
          <p className="alert" role="alert">
            {wallet.message}
          </p>
        )}
        {wallet.kind === "ok" && (
          <p className="small muted">
            Wallet: {formatPlayMoney(wallet.balance)} (play money)
          </p>
        )}
        {tournament ? (
          <p>
            Starting stack:{" "}
            <strong className="mono">
              {formatPlayMoney(settings.startingStack)}
            </strong>
          </p>
        ) : (
          wallet.kind === "ok" &&
          !tooPoor && (
            <div className="field">
              <label htmlFor="table-buyin">Buy-in</label>
              <input
                id="table-buyin"
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={amount ?? ""}
                onChange={(e) =>
                  setAmount(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
              <input
                type="range"
                aria-label="Buy-in slider"
                min={min}
                max={max}
                step={1}
                value={amount ?? min}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
              <small>
                {formatPlayMoney(min)} – {formatPlayMoney(max)}
              </small>
            </div>
          )
        )}
        {tooPoor && (
          <p className="alert alert-info">
            Your wallet has {formatPlayMoney(balance ?? 0)}, but the minimum
            buy-in is {formatPlayMoney(min)}. Ask the host for more play chips.
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid}
            onClick={sit}
          >
            Sit down
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function HostSlideOver({
  gameId,
  open,
  onClose,
}: {
  gameId: string;
  open: boolean;
  onClose(): void;
}): JSX.Element {
  const [x] = useTweenedPosition("panel:host", open ? [0, 0, 0] : [1, 0, 0], {
    durationMs: 250,
    ease: easeOutCubic,
  });
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );
  return (
    <div className="table-host-layer">
      <aside
        id="table-host-panel"
        className="table-host-panel"
        data-testid="host-panel"
        data-open={open ? "true" : "false"}
        aria-label="Host panel"
        aria-hidden={!open}
        inert={!open}
        style={{ transform: `translateX(${x * 100}%)` }}
        onKeyDown={onKeyDown}
      >
        <div className="row row-between">
          <strong>Host panel</strong>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <HostPanel gameId={gameId} />
      </aside>
    </div>
  );
}
