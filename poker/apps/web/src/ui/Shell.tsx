/**
 * App chrome for every signed-in route (I-10): brand, main nav, "Play money" label (F13), notification bell and
 * Log out. Notifications come from GET /api/notifications on mount plus live `notify` socket events.
 */
import type { Notify } from '@poker/protocol';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { api } from '../api/client.js';
import { disconnectSocket, getSocket } from '../api/socket.js';
import { useMe } from '../api/useMe.js';

export interface NotificationItem {
  id: string;
  kind: string;
  text: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  unread: number;
  notifications: NotificationItem[];
}

const NAV = [
  { to: '/', label: 'Lobby', end: true },
  { to: '/friends', label: 'Friends', end: false },
  { to: '/history', label: 'History', end: false },
  { to: '/wallet', label: 'Wallet', end: false },
  { to: '/profile', label: 'Profile', end: false },
] as const;

const MAX_ITEMS = 50;

function timeAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

interface NotificationState {
  items: NotificationItem[];
  unread: number;
}

function useNotifications(enabled: boolean) {
  const [state, setState] = useState<NotificationState>({ items: [], unread: 0 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api<NotificationsResponse>('/api/notifications', { signal });
      setState({ items: res.notifications, unread: res.unread });
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const socket = getSocket();
    const onNotify = (n: Notify) => {
      setState((prev) => {
        if (prev.items.some((p) => p.id === n.id)) return prev;
        const item: NotificationItem = {
          id: n.id,
          kind: n.kind,
          text: n.text,
          link: n.link ?? null,
          read: false,
          createdAt: new Date().toISOString(),
        };
        return { items: [item, ...prev.items].slice(0, MAX_ITEMS), unread: prev.unread + 1 };
      });
    };
    // After a reconnect we may have missed events; reload the list.
    const onReconnect = () => void load();
    socket.on('notify', onNotify);
    socket.io.on('reconnect', onReconnect);
    return () => {
      ctrl.abort();
      socket.off('notify', onNotify);
      socket.io.off('reconnect', onReconnect);
    };
  }, [enabled, load]);

  const markRead = useCallback(async (item: NotificationItem) => {
    if (item.read) return;
    setState((prev) => {
      const target = prev.items.find((p) => p.id === item.id);
      if (!target || target.read) return prev;
      return {
        items: prev.items.map((p) => (p.id === item.id ? { ...p, read: true } : p)),
        unread: Math.max(0, prev.unread - 1),
      };
    });
    try {
      await api(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' });
    } catch {
      // The local state already shows it read; the next reload corrects any drift.
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setState((prev) => ({ items: prev.items.map((p) => ({ ...p, read: true })), unread: 0 }));
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
    } catch {
      void load();
    }
  }, [load]);

  return { items: state.items, unread: state.unread, error, markRead, markAllRead };
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M6 9a6 6 0 1 1 12 0c0 4.5 1.5 6.5 2.5 7.5H3.5C4.5 15.5 6 13.5 6 9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9.5 19.5a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function NotificationBell({ enabled }: { enabled: boolean }) {
  const { items, unread, error, markRead, markAllRead } = useNotifications(enabled);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const panelId = useId();
  const countId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const follow = (item: NotificationItem) => {
    void markRead(item);
    setOpen(false);
    // Only in-app paths are followed ("/table/…"); anything else is ignored.
    if (item.link && item.link.startsWith('/') && !item.link.startsWith('//')) navigate(item.link);
  };

  const now = Date.now();

  return (
    <div className="shell-bell" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-ghost shell-bell-btn"
        aria-label="Notifications"
        aria-describedby={countId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="badge badge-red" aria-hidden="true" data-testid="notification-count">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <span id={countId} className="sr-only">
        {unread === 1 ? '1 unread' : `${unread} unread`}
      </span>
      {open && (
        <div id={panelId} className="shell-panel" role="region" aria-label="Notification list">
          <div className="shell-panel-head">
            <h2>Notifications</h2>
            {unread > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void markAllRead()}>
                Mark all read
              </button>
            )}
          </div>
          {error && items.length === 0 ? (
            <p className="shell-empty muted small" role="alert">
              {error}
            </p>
          ) : items.length === 0 ? (
            <p className="shell-empty muted small">You're all caught up.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="shell-note"
                    data-unread={item.read ? 'false' : 'true'}
                    onClick={() => follow(item)}
                  >
                    <span className="shell-note-dot" aria-hidden="true" />
                    <span>
                      {item.text}
                      {!item.read && <span className="sr-only"> (unread)</span>}
                      <span className="shell-note-time">{timeAgo(item.createdAt, now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, setMe } = useMe();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Log out locally even if the server is unreachable.
    } finally {
      disconnectSocket();
      setMe(null);
      setLoggingOut(false);
      navigate('/login', { replace: true });
    }
  };

  return (
    <>
      <header className="shell-header">
        <div className="shell-bar">
          <NavLink to="/" className="shell-brand" aria-label="Poker night home">
            <span className="shell-logo" aria-hidden="true">
              ♠
            </span>
            <span className="shell-brand-text">Poker Night</span>
          </NavLink>
          <nav className="shell-nav" aria-label="Main">
            <ul>
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="shell-actions">
            <span className="badge badge-gold" title="Chips have no cash value">
              Play money
            </span>
            {me && <span className="shell-user muted small">{me.displayName}</span>}
            <NotificationBell enabled={me !== null} />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void logout()}
              disabled={loggingOut}
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </>
  );
}
