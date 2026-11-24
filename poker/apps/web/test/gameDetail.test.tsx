import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: vi.fn(),
    tween: vi.fn(() => ({ cancel: () => {}, done: Promise.resolve() })),
  };
});

vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/anim/tween.js', () => ({
  tween: mocks.tween,
  easeOutCubic: (t: number) => 1 - (1 - t) ** 3,
  prefersReducedMotion: () => false,
}));

import { GameDetail } from '../src/pages/GameDetail.js';
import { defaultSettings } from '../src/ui/SettingsForm.js';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const host = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Hank Host', avatarUrl: '' };
const bob = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Bob', avatarUrl: '' };
const cara = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Cara', avatarUrl: '' };

function game(over: Record<string, unknown> = {}) {
  return {
    id: GAME_ID,
    name: 'Friday Night',
    startsAt: '2026-12-01T19:00:00.000Z',
    status: 'scheduled',
    settings: defaultSettings('cash'),
    host,
    invites: [{ user: bob, rsvp: 'pending' }],
    myRsvp: 'pending',
    isHost: false,
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/games/${GAME_ID}`]}>
      <Routes>
        <Route path="/games/:id" element={<GameDetail />} />
        <Route path="/" element={<h1>Lobby page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.tween.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GameDetail', () => {
  it('shows the access message on a 403', async () => {
    mocks.api.mockRejectedValue(new mocks.ApiError(403, 'Forbidden'));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe("You don't have access to this game");
  });

  it('shows game facts, the calendar link and RSVP buttons for an invited player', async () => {
    mocks.api.mockResolvedValue(game());
    renderPage();
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Friday Night');
    const cal = screen.getByRole('link', { name: 'Add to calendar' });
    expect(cal.getAttribute('href')).toBe(`/api/games/${GAME_ID}/calendar.ics`);
    expect(screen.queryByRole('link', { name: 'Open table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open table now' })).toBeNull();
    expect(screen.getByText('$40 – $200')).toBeTruthy();
    expect(screen.getAllByText(/play money/i).length).toBeGreaterThan(0);
    for (const name of ['Yes', 'Maybe', 'No']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });

  it('posts the RSVP and marks the chosen button pressed', async () => {
    let myRsvp = 'pending';
    mocks.api.mockImplementation(async (path: string, init?: { method?: string; body?: { rsvp: string } }) => {
      if (path.endsWith('/rsvp') && init?.method === 'POST') {
        myRsvp = init.body?.rsvp ?? myRsvp;
        return { rsvp: myRsvp };
      }
      return game({ myRsvp });
    });
    renderPage();
    const yes = await screen.findByRole('button', { name: 'Yes' });
    fireEvent.click(yes);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes' }).getAttribute('aria-pressed')).toBe('true'));
    expect(mocks.api).toHaveBeenCalledWith(`/api/games/${GAME_ID}/rsvp`, { method: 'POST', body: { rsvp: 'yes' } });
    expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows "Open table" when the game is open', async () => {
    mocks.api.mockResolvedValue(game({ status: 'open' }));
    renderPage();
    const link = await screen.findByRole('link', { name: 'Open table' });
    expect(link.getAttribute('href')).toBe(`/table/${GAME_ID}`);
  });

  it('refetches while scheduled so "Open table" appears without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    mocks.api.mockImplementation(async () => {
      calls++;
      return game({ status: calls >= 2 ? 'open' : 'scheduled' });
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Friday Night' });
    expect(screen.queryByRole('link', { name: 'Open table' })).toBeNull();
    await vi.advanceTimersByTimeAsync(5100);
    await screen.findByRole('link', { name: 'Open table' });
  });

  it('gives the host invites, settings, open and cancel controls', async () => {
    const hostGame = game({ isHost: true, myRsvp: null });
    mocks.api.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/api/friends') return { friends: [bob, cara], incoming: [], outgoing: [] };
      if (path.endsWith('/invites')) {
        return { ...hostGame, invites: [...hostGame.invites, { user: cara, rsvp: 'pending' }] };
      }
      if (path.endsWith('/settings') && init?.method === 'PATCH') {
        const body = init.body as { settings: Record<string, unknown> };
        return { ...hostGame, settings: { ...hostGame.settings, ...body.settings } };
      }
      if (path.endsWith('/open')) return { ...hostGame, status: 'open' };
      return hostGame;
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Friday Night' });
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();

    // Only friends not yet invited get a checkbox.
    const caraBox = await screen.findByRole('checkbox', { name: 'Cara' });
    expect(screen.queryByRole('checkbox', { name: 'Bob' })).toBeNull();
    fireEvent.click(caraBox);
    fireEvent.click(screen.getByRole('button', { name: 'Send invites' }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`/api/games/${GAME_ID}/invites`, {
        method: 'POST',
        body: { userIds: [cara.id] },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Cara' })).toBeNull());

    // Settings: only the changed field is sent.
    fireEvent.change(screen.getByLabelText('Turn time (seconds)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`/api/games/${GAME_ID}/settings`, {
        method: 'PATCH',
        body: { settings: { turnSeconds: 30 } },
      }),
    );
    expect(await screen.findByText('Settings saved')).toBeTruthy();

    expect(screen.getByRole('button', { name: 'Cancel game' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open table now' }));
    expect(await screen.findByRole('link', { name: 'Open table' })).toBeTruthy();
  });

  it('links to settlement and results when finished', async () => {
    mocks.api.mockResolvedValue(game({ status: 'finished' }));
    renderPage();
    expect((await screen.findByRole('link', { name: 'Settle up' })).getAttribute('href')).toBe(`/settle/${GAME_ID}`);
    expect(screen.getByRole('link', { name: 'Results' }).getAttribute('href')).toBe(`/results/${GAME_ID}`);
  });

  it('runs the page-enter tween', async () => {
    mocks.api.mockResolvedValue(game());
    renderPage();
    await screen.findByRole('heading', { name: 'Friday Night' });
    expect(mocks.tween).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: 1, durationMs: 220 }),
    );
  });
});
