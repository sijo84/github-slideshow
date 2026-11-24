import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client.js';
import { usePageRise } from './usePageRise.js';
import './lobby.css';

interface FriendUser {
  id: string;
  displayName: string;
  avatarUrl: string;
}
interface FriendsResponse {
  friends: FriendUser[];
  incoming: FriendUser[];
  outgoing: FriendUser[];
}

function errorText(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return 'Something went wrong';
}

export function Friends(): JSX.Element {
  const rise = usePageRise<HTMLDivElement>();
  const [data, setData] = useState<FriendsResponse | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await api<FriendsResponse>('/api/friends', { signal }));
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sendRequest = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const value = email.trim();
    if (!value) {
      setError("Enter your friend's email");
      return;
    }
    void run(async () => {
      const res = await api<{ status: 'pending' | 'accepted' }>('/api/friends/requests', {
        method: 'POST',
        body: { email: value },
      });
      setEmail('');
      return res.status === 'accepted' ? 'You are now friends' : 'Friend request sent';
    });
  };

  const post = (path: string, method: 'POST' | 'DELETE', msg: string | null): void =>
    void run(async () => {
      await api<unknown>(path, { method });
      return msg;
    });

  return (
    <div className="page friends stack" ref={rise}>
      <h1>Friends</h1>

      <form className="card row friends-form" onSubmit={sendRequest}>
        <div className="field">
          <label htmlFor="friend-email">Friend's email</label>
          <input
            id="friend-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Send request
        </button>
      </form>

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

      {data === null && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <section className="card" aria-labelledby="friends-incoming">
            <h2 id="friends-incoming">Requests for you</h2>
            {data.incoming.length === 0 ? (
              <p className="muted">No pending requests.</p>
            ) : (
              <ul className="game-list">
                {data.incoming.map((u) => (
                  <li key={u.id}>
                    <span>{u.displayName}</span>
                    <span className="row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => post(`/api/friends/requests/${u.id}/accept`, 'POST', `You and ${u.displayName} are now friends`)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => post(`/api/friends/requests/${u.id}/decline`, 'POST', null)}
                      >
                        Decline
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="friends-outgoing">
            <h2 id="friends-outgoing">Requests you sent</h2>
            {data.outgoing.length === 0 ? (
              <p className="muted">No requests waiting for an answer.</p>
            ) : (
              <ul className="game-list">
                {data.outgoing.map((u) => (
                  <li key={u.id}>
                    <span>
                      {u.displayName} <span className="badge">pending</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => post(`/api/friends/${u.id}`, 'DELETE', null)}
                    >
                      Cancel request
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="friends-list">
            <h2 id="friends-list">Your friends</h2>
            {data.friends.length === 0 ? (
              <p className="muted">No friends yet. Send a request by email above.</p>
            ) : (
              <ul className="game-list">
                {data.friends.map((u) => (
                  <li key={u.id}>
                    <Link to={`/stats/${u.id}`}>{u.displayName}</Link>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => post(`/api/friends/${u.id}`, 'DELETE', null)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
