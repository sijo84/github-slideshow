import { useCallback, useEffect, useState, type JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatPlayMoney } from '@poker/engine';
import type { GameSettings } from '@poker/protocol';
import { api, ApiError } from '../api/client.js';
import { SettingsForm, validateSettings } from '../ui/SettingsForm.js';
import { formatStart } from './Lobby.js';
import { usePageRise } from './usePageRise.js';
import './lobby.css';

type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';
interface UserRef {
  id: string;
  displayName: string;
  avatarUrl: string;
}
interface Game {
  id: string;
  name: string;
  startsAt: string;
  status: GameStatus;
  settings: GameSettings;
  host: UserRef;
  invites: { user: UserRef; rsvp: Rsvp }[];
  myRsvp: Rsvp | null;
  isHost: boolean;
}

const POLL_MS = 5000;

const STATUS_LABEL: Record<GameStatus, string> = {
  scheduled: 'Scheduled',
  open: 'Open',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  cancelled: 'Cancelled',
};
const RSVP_LABEL: Record<Rsvp, string> = { pending: 'No answer yet', yes: 'Yes', no: 'No', maybe: 'Maybe' };
const RSVP_CHOICES: { value: 'yes' | 'maybe' | 'no'; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'no', label: 'No' },
];

type LoadState = { kind: 'loading' } | { kind: 'error'; status: number; message: string } | { kind: 'ok'; game: Game };

function errorText(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return 'Something went wrong';
}

/** Only the settings that differ from `base` (kind/maxSeats are left out unless they changed). */
function changedSettings(base: GameSettings, next: GameSettings): Partial<GameSettings> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof GameSettings)[]) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) out[key] = next[key];
  }
  return out as Partial<GameSettings>;
}

export function GameDetail(): JSX.Element {
  const { id = '' } = useParams();
  const rise = usePageRise<HTMLDivElement>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const game = await api<Game>(`/api/games/${id}`, { signal });
        setState({ kind: 'ok', game });
      } catch (e) {
        if (signal?.aborted) return;
        setState((prev) =>
          // A failed background refresh keeps the page we already have, unless access was lost.
          prev.kind === 'ok' && !(e instanceof ApiError && (e.status === 403 || e.status === 404))
            ? prev
            : { kind: 'error', status: e instanceof ApiError ? e.status : 0, message: errorText(e) },
        );
      }
    },
    [id],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ kind: 'loading' });
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const status = state.kind === 'ok' ? state.game.status : null;
  useEffect(() => {
    if (status !== 'scheduled') return;
    const ctrl = new AbortController();
    const timer = setInterval(() => void load(ctrl.signal), POLL_MS);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [status, load]);

  const setGame = useCallback((game: Game) => setState({ kind: 'ok', game }), []);

  return (
    <div className="page game-detail stack" ref={rise}>
      {state.kind === 'loading' && <p className="muted">Loading game…</p>}
      {state.kind === 'error' && (
        <>
          <h1>{state.status === 403 ? 'No access' : state.status === 404 ? 'Game not found' : 'Game'}</h1>
          <p role="alert" className="alert">
            {state.status === 403
              ? "You don't have access to this game"
              : state.status === 404
                ? 'This game does not exist.'
                : state.message}
          </p>
          <p>
            <Link to="/">Back to the lobby</Link>
          </p>
        </>
      )}
      {state.kind === 'ok' && <GameView game={state.game} setGame={setGame} reload={() => load()} />}
    </div>
  );
}

function GameView({
  game,
  setGame,
  reload,
}: {
  game: Game;
  setGame(g: Game): void;
  reload(): Promise<void>;
}): JSX.Element {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const live = game.status === 'open' || game.status === 'running' || game.status === 'paused';
  const s = game.settings;
  const lvl = s.levels[0];

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rsvp = (value: 'yes' | 'maybe' | 'no'): Promise<void> =>
    act(async () => {
      const res = await api<{ rsvp: Rsvp }>(`/api/games/${game.id}/rsvp`, { method: 'POST', body: { rsvp: value } });
      setGame({ ...game, myRsvp: res.rsvp });
      void reload();
    });

  return (
    <>
      <div className="row game-header">
        <h1>{game.name}</h1>
        <span className={`badge status-${game.status}`}>{STATUS_LABEL[game.status]}</span>
      </div>

      <section className="card">
        <dl className="game-meta">
          <dt>Starts</dt>
          <dd>
            <time dateTime={game.startsAt}>{formatStart(game.startsAt)}</time>
          </dd>
          <dt>Host</dt>
          <dd>{game.host.displayName}</dd>
          <dt>Type</dt>
          <dd>{s.kind === 'cash' ? 'Cash game' : 'Tournament'}</dd>
          <dt>Blinds</dt>
          <dd>
            {lvl ? `${formatPlayMoney(lvl.smallBlind)} / ${formatPlayMoney(lvl.bigBlind)}` : '—'}
            {s.kind === 'tournament' && ` (level 1 of ${s.levels.length})`}
          </dd>
          <dt>Buy-in</dt>
          <dd>
            {s.kind === 'cash'
              ? `${formatPlayMoney(s.minBuyIn)} – ${formatPlayMoney(s.maxBuyIn)}`
              : formatPlayMoney(s.startingStack)}{' '}
            <span className="badge">play money</span>
          </dd>
        </dl>
        <div className="row">
          <a className="btn btn-ghost" href={`/api/games/${game.id}/calendar.ics`}>
            Add to calendar
          </a>
          {live && (
            <Link className="btn btn-primary" to={`/table/${game.id}`}>
              Open table
            </Link>
          )}
          {game.isHost && game.status === 'scheduled' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => setGame(await api<Game>(`/api/games/${game.id}/open`, { method: 'POST' })))
              }
            >
              Open table now
            </button>
          )}
        </div>
        {game.status === 'finished' && (
          <div className="row">
            <Link className="btn" to={`/settle/${game.id}`}>
              Settle up
            </Link>
            <Link className="btn" to={`/results/${game.id}`}>
              Results
            </Link>
          </div>
        )}
        {game.status === 'cancelled' && <p className="muted">This game was cancelled.</p>}
      </section>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}

      {game.myRsvp !== null && (
        <section className="card" aria-labelledby="rsvp-heading">
          <h2 id="rsvp-heading">Are you coming?</h2>
          <div className="row rsvp-buttons" role="group" aria-labelledby="rsvp-heading">
            {RSVP_CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                className="btn"
                aria-pressed={game.myRsvp === c.value}
                disabled={busy}
                onClick={() => void rsvp(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="invites-heading">
        <h2 id="invites-heading">Invited players</h2>
        {game.invites.length === 0 ? (
          <p className="muted">Nobody invited yet.</p>
        ) : (
          <ul className="game-list">
            {game.invites.map((inv) => (
              <li key={inv.user.id}>
                <span>{inv.user.displayName}</span>
                <span className={`badge rsvp-${inv.rsvp}`}>{RSVP_LABEL[inv.rsvp]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {game.isHost && game.status !== 'finished' && game.status !== 'cancelled' && (
        <>
          <InviteFriends game={game} setGame={setGame} />
          <HostSettings game={game} setGame={setGame} />
          {(game.status === 'scheduled' || game.status === 'open') && (
            <section className="card" aria-labelledby="cancel-heading">
              <h2 id="cancel-heading">Cancel this game</h2>
              {!confirmCancel ? (
                <button type="button" className="btn btn-danger" onClick={() => setConfirmCancel(true)}>
                  Cancel game
                </button>
              ) : (
                <div className="row">
                  <span>Cancel the game for everyone?</span>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api<{ ok: true }>(`/api/games/${game.id}/cancel`, { method: 'POST' });
                        navigate('/');
                      })
                    }
                  >
                    Yes, cancel game
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>
                    Keep game
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}

function InviteFriends({ game, setGame }: { game: Game; setGame(g: Game): void }): JSX.Element {
  const [friends, setFriends] = useState<UserRef[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    api<{ friends: UserRef[] }>('/api/friends', { signal: ctrl.signal })
      .then((res) => setFriends(res.friends))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(errorText(e));
      });
    return () => ctrl.abort();
  }, []);

  const invited = new Set(game.invites.map((i) => i.user.id));
  const candidates = (friends ?? []).filter((f) => !invited.has(f.id));

  const send = async (): Promise<void> => {
    const userIds = candidates.filter((f) => selected.has(f.id)).map((f) => f.id);
    if (userIds.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      setGame(await api<Game>(`/api/games/${game.id}/invites`, { method: 'POST', body: { userIds } }));
      setSelected(new Set());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite friends</h2>
      {friends === null && !error && <p className="muted">Loading friends…</p>}
      {friends !== null && candidates.length === 0 && (
        <p className="muted">
          {friends.length === 0 ? (
            <>
              You have no friends to invite yet. <Link to="/friends">Add friends</Link>
            </>
          ) : (
            'All your friends are invited.'
          )}
        </p>
      )}
      {candidates.length > 0 && (
        <div className="invite-checks">
          {candidates.map((f) => (
            <label key={f.id} className="field-inline settings-check">
              <input
                type="checkbox"
                checked={selected.has(f.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  setSelected(next);
                }}
              />
              <span>{f.displayName}</span>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || candidates.every((f) => !selected.has(f.id))}
          onClick={() => void send()}
        >
          Send invites
        </button>
      </div>
    </section>
  );
}

function HostSettings({ game, setGame }: { game: Game; setGame(g: Game): void }): JSX.Element {
  const [draft, setDraft] = useState<GameSettings>(game.settings);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = game.status === 'running' || game.status === 'paused';

  const save = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const valid = validateSettings(draft);
    if (!valid.ok) {
      setError('Please fix the settings first');
      return;
    }
    const changes = changedSettings(game.settings, valid.settings);
    if (Object.keys(changes).length === 0) {
      setNotice('Nothing changed');
      return;
    }
    setBusy(true);
    try {
      const updated = await api<Game>(`/api/games/${game.id}/settings`, {
        method: 'PATCH',
        body: { settings: changes },
      });
      setGame(updated);
      setDraft(updated.settings);
      setNotice(started ? 'Settings saved; they apply from the next hand' : 'Settings saved');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="settings-heading">
      <h2 id="settings-heading">Settings</h2>
      <SettingsForm value={draft} onChange={setDraft} locked={{ kind: started, maxSeats: started }} />
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          Save settings
        </button>
      </div>
    </section>
  );
}
