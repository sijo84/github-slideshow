/**
 * The signed-in user, shared by the whole app (I-10).
 *
 * One module-level store backs every `useMe()` call, so GET /api/auth/me is fetched once (and again only on
 * `refresh()`). On a 401 every route except /login navigates to /login. A 401 that was seen while on /login (before
 * the user logged in) is re-checked when the app moves to another route, so a Login page that only navigates
 * (without calling `setMe`) still works and nothing loops.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError } from './client.js';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
}

interface MeState {
  me: Me | null;
  loading: boolean;
  /** The last check answered 401 (or the user logged out). */
  unauthorized: boolean;
  /** The route that was showing when `unauthorized` was set. */
  unauthorizedAt: string | null;
  /** A fetch has been started at least once. */
  started: boolean;
}

const LOGIN_PATH = '/login';

let state: MeState = { me: null, loading: false, unauthorized: false, unauthorizedAt: null, started: false };
let inflight: Promise<void> | null = null;
let currentPath = typeof window === 'undefined' ? '/' : window.location.pathname;
const listeners = new Set<() => void>();

function setState(patch: Partial<MeState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): MeState {
  return state;
}

export function refreshMe(): Promise<void> {
  if (inflight) return inflight;
  setState({ loading: true, started: true });
  const p = api<Me>('/api/auth/me')
    .then((me) => setState({ me, loading: false, unauthorized: false, unauthorizedAt: null }))
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        setState({ me: null, loading: false, unauthorized: true, unauthorizedAt: currentPath });
      } else {
        // Network or server trouble: keep whatever we had and let the page show its own errors.
        setState({ loading: false });
      }
    })
    .finally(() => {
      inflight = null;
    });
  inflight = p;
  return p;
}

export function setMeState(me: Me | null): void {
  setState(
    me
      ? { me, loading: false, unauthorized: false, unauthorizedAt: null, started: true }
      : // Logged out: the next route away from /login re-checks before redirecting.
        { me: null, loading: false, unauthorized: true, unauthorizedAt: LOGIN_PATH, started: true },
  );
}

/** Test helper: forget everything (no listeners are removed). */
export function __resetMeForTests(): void {
  inflight = null;
  setState({ me: null, loading: false, unauthorized: false, unauthorizedAt: null, started: false });
}

export function useMe(): { me: Me | null; loading: boolean; refresh(): Promise<void>; setMe(me: Me | null): void } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  currentPath = pathname;

  useEffect(() => {
    if (!state.started) void refreshMe();
  }, []);

  useEffect(() => {
    if (!snap.unauthorized || snap.loading) return;
    if (pathname === LOGIN_PATH) {
      // Whatever happens on /login (log in, register) makes the old 401 stale.
      if (snap.unauthorizedAt !== LOGIN_PATH) setState({ unauthorizedAt: LOGIN_PATH });
      return;
    }
    if (snap.unauthorizedAt === LOGIN_PATH) {
      // Seen before logging in; the user may be signed in by now.
      void refreshMe();
      return;
    }
    navigate(LOGIN_PATH, { replace: true });
  }, [pathname, snap.unauthorized, snap.unauthorizedAt, snap.loading, navigate]);

  const refresh = useCallback(() => refreshMe(), []);
  const setMe = useCallback((me: Me | null) => setMeState(me), []);

  return { me: snap.me, loading: snap.loading || (!snap.started && snap.me === null), refresh, setMe };
}
