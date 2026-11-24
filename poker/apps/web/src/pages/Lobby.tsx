import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { Link, useNavigate } from 'react-router';
import type { GameSettings } from '@poker/protocol';
import { api, ApiError } from '../api/client.js';
import { SettingsForm, defaultSettings, validateSettings } from '../ui/SettingsForm.js';
import { usePageRise } from './usePageRise.js';
import './lobby.css';

type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';
interface GameSummary {
  id: string;
  name: string;
  startsAt: string;
  status: GameStatus;
  kind: 'cash' | 'tournament';
  hostId: string;
  hostName: string;
  myRsvp: Rsvp | null;
  invitedCount: number;
}

const STATUS_LABEL: Record<GameStatus, string> = {
  scheduled: 'Scheduled',
  open: 'Open',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  cancelled: 'Cancelled',
};

const RSVP_LABEL: Record<Rsvp, string> = { pending: 'Not answered', yes: 'Yes', no: 'No', maybe: 'Maybe' };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatStart(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

/** A Date as the local `YYYY-MM-DDTHH:mm` string a datetime-local input expects. */
export function toDatetimeLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}

export function Lobby(): JSX.Element {
  const rise = usePageRise<HTMLDivElement>();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api<{ games: GameSummary[] }>('/api/games', { signal });
      setGames(res.games);
      setLoadError(null);
    } catch (e) {
      if (signal?.aborted) return;
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const groups: { title: string; games: GameSummary[] }[] = [
    { title: 'Upcoming', games: (games ?? []).filter((g) => g.status === 'scheduled') },
    {
      title: 'Live',
      games: (games ?? []).filter((g) => g.status === 'open' || g.status === 'running' || g.status === 'paused'),
    },
    { title: 'Finished', games: (games ?? []).filter((g) => g.status === 'finished') },
  ];

  return (
    <div className="page lobby stack" ref={rise}>
      <div className="row lobby-header">
        <h1>Lobby</h1>
        {!creating && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New game
          </button>
        )}
      </div>

      {creating && <NewGameForm onCancel={() => setCreating(false)} />}

      {loadError && (
        <p role="alert" className="alert">
          {loadError}
        </p>
      )}
      {games === null && !loadError && <p className="muted">Loading games…</p>}
      {games !== null && games.length === 0 && (
        <p className="muted">No games yet. Schedule one, or ask a friend to invite you.</p>
      )}

      {games !== null &&
        games.length > 0 &&
        groups.map((group) => (
          <section key={group.title} className="card lobby-group" aria-labelledby={`lobby-${group.title}`}>
            <h2 id={`lobby-${group.title}`}>{group.title}</h2>
            {group.games.length === 0 ? (
              <p className="muted">None</p>
            ) : (
              <ul className="lobby-list">
                {group.games.map((g) => (
                  <li key={g.id} className="lobby-item">
                    <div className="lobby-item-main">
                      <Link to={`/games/${g.id}`} className="lobby-name">
                        {g.name}
                      </Link>
                      <span className={`badge status-${g.status}`}>{STATUS_LABEL[g.status]}</span>
                    </div>
                    <div className="lobby-item-meta muted">
                      <span>{g.kind === 'cash' ? 'Cash game' : 'Tournament'}</span>
                      <span>
                        <time dateTime={g.startsAt}>{formatStart(g.startsAt)}</time>
                      </span>
                      <span>Host: {g.hostName}</span>
                      <span>{g.myRsvp === null ? 'You host' : `My RSVP: ${RSVP_LABEL[g.myRsvp]}`}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
    </div>
  );
}

function NewGameForm({ onCancel }: { onCancel(): void }): JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState(() => toDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000)));
  const [settings, setSettings] = useState<GameSettings>(() => defaultSettings('cash'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
      setError('Game name must be 1 to 60 characters');
      return;
    }
    const when = new Date(startsAt);
    if (Number.isNaN(when.getTime())) {
      setError('Pick a start date and time');
      return;
    }
    const valid = validateSettings(settings);
    if (!valid.ok) {
      setError('Please fix the game settings first');
      return;
    }
    setBusy(true);
    try {
      const game = await api<{ id: string }>('/api/games', {
        method: 'POST',
        body: { name: trimmed, startsAt: when.toISOString(), settings: valid.settings },
      });
      navigate(`/games/${game.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="card stack lobby-new" onSubmit={(e) => void submit(e)} aria-label="New game">
      <h2>New game</h2>
      <div className="field">
        <label htmlFor="new-game-name">Game name</label>
        <input
          id="new-game-name"
          type="text"
          maxLength={60}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="new-game-start">Starts at</label>
        <input
          id="new-game-start"
          type="datetime-local"
          required
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
        />
      </div>
      <SettingsForm value={settings} onChange={setSettings} />
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Schedule game
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
