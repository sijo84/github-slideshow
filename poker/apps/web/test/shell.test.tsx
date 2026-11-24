import '@testing-library/jest-dom/vitest';
import type { Notify } from '@poker/protocol';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny fake socket: only what Shell uses (on/off for 'notify', io.on/off for 'reconnect').
const fake = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const socket = {
    on(event: string, fn: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return socket;
    },
    off(event: string, fn: (payload: unknown) => void) {
      handlers.get(event)?.delete(fn);
      return socket;
    },
    io: { on: () => undefined, off: () => undefined },
  };
  return {
    socket,
    emit(event: string, payload: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
    reset() {
      handlers.clear();
    },
    disconnect: vi.fn(),
  };
});

vi.mock('../src/api/socket.js', () => ({
  getSocket: () => fake.socket,
  disconnectSocket: fake.disconnect,
  joinTable: vi.fn(),
  leaveTableRoom: vi.fn(),
  onRejoin: () => () => undefined,
}));

const { Shell } = await import('../src/ui/Shell.js');
const { __resetMeForTests, useMe } = await import('../src/api/useMe.js');

const ME = { id: 'u1', email: 'ann@example.com', displayName: 'Ann', avatarUrl: '/avatars/u1.png' };

interface Route_ {
  status: number;
  body?: unknown;
}
let routes: Record<string, Route_>;
const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input)}`;
  const r = routes[key];
  if (!r) return Promise.resolve(new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 }));
  return Promise.resolve(
    new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function LoginStub() {
  useMe();
  return <h1>Login</h1>;
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginStub />} />
        <Route
          path="*"
          element={
            <Shell>
              <h1>Page</h1>
            </Shell>
          }
        />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetMeForTests();
  fake.reset();
  fake.disconnect.mockClear();
  fetchMock.mockClear();
  routes = {
    'GET /api/auth/me': { status: 200, body: ME },
    'GET /api/notifications': {
      status: 200,
      body: {
        unread: 2,
        notifications: [
          { id: '7', kind: 'invite', text: 'Bob invited you to Friday game', link: '/games/g1', read: false, createdAt: new Date().toISOString() },
          { id: '6', kind: 'friendRequest', text: 'Cy wants to be friends', link: '/friends', read: false, createdAt: new Date().toISOString() },
          { id: '5', kind: 'gameStarting', text: 'Old game started', link: null, read: true, createdAt: new Date().toISOString() },
        ],
      },
    },
    'POST /api/notifications/7/read': { status: 200, body: { ok: true } },
    'POST /api/auth/logout': { status: 200, body: { ok: true } },
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Shell', () => {
  it('shows the nav links, the play-money label and log out', async () => {
    renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const name of ['Lobby', 'Friends', 'History', 'Wallet', 'Profile']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
      expect(nav).toContainElement(screen.getByRole('link', { name }));
    }
    expect(screen.getByRole('link', { name: 'Lobby' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Play money')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(await screen.findByText('Ann')).toBeInTheDocument();
  });

  it('fetches /api/auth/me once for many useMe consumers', async () => {
    renderApp('/');
    await screen.findByText('Ann');
    const meCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/auth/me');
    expect(meCalls).toHaveLength(1);
  });

  it('shows the unread count, adds live notify events, and follows a clicked notification', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(await screen.findByTestId('notification-count')).toHaveTextContent('2');

    const live: Notify = { id: '8', kind: 'seatRequest', text: 'Dee asks to sit', link: '/table/g2' };
    act(() => fake.emit('notify', live));
    expect(screen.getByTestId('notification-count')).toHaveTextContent('3');
    // The same id again is ignored.
    act(() => fake.emit('notify', live));
    expect(screen.getByTestId('notification-count')).toHaveTextContent('3');

    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Dee asks to sit')).toBeInTheDocument();
    expect(screen.getByText('Old game started')).toBeInTheDocument();

    await user.click(screen.getByText('Bob invited you to Friday game'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/games/g1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/7/read', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByTestId('notification-count')).toHaveTextContent('2');
    expect(screen.queryByText('Dee asks to sit')).not.toBeInTheDocument(); // panel closed
  });

  it('closes the panel on Escape', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Old game started')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Old game started')).not.toBeInTheDocument();
  });

  it('redirects to /login on 401 and does not loop there', async () => {
    routes['GET /api/auth/me'] = { status: 401, body: { error: 'Not signed in' } };
    renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login'));
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    const meCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/auth/me');
    expect(meCalls).toHaveLength(1);
  });

  it('renders /login without a user and without redirecting', async () => {
    routes['GET /api/auth/me'] = { status: 401, body: { error: 'Not signed in' } };
    renderApp('/login');
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('where')).toHaveTextContent('/login');
  });

  it('logs out: calls the API, drops the socket and goes to /login', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByText('Ann');
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(fake.disconnect).toHaveBeenCalled();
  });
});
