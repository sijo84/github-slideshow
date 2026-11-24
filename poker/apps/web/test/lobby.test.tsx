import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { Lobby, toDatetimeLocal } from '../src/pages/Lobby.js';

const NEW_ID = '22222222-2222-4222-8222-222222222222';

function summary(id: string, name: string, status: string, myRsvp: string | null) {
  return {
    id,
    name,
    startsAt: '2026-12-01T19:00:00.000Z',
    status,
    kind: 'cash',
    hostId: 'h',
    hostName: 'Hank',
    myRsvp,
    invitedCount: 2,
  };
}

function renderLobby() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/games/:id" element={<h1>Game page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
});
afterEach(() => cleanup());

describe('Lobby', () => {
  it('groups games and links each name', async () => {
    mocks.api.mockResolvedValue({
      games: [
        summary('1', 'Next week', 'scheduled', 'yes'),
        summary('2', 'Right now', 'running', null),
        summary('3', 'Last week', 'finished', 'maybe'),
      ],
    });
    renderLobby();
    expect(screen.getByRole('heading', { name: 'Lobby' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: 'Next week' });
    expect(link.getAttribute('href')).toBe('/games/1');
    const live = screen.getByRole('region', { name: 'Live' });
    expect(within(live).getByRole('link', { name: 'Right now' })).toBeTruthy();
    expect(within(live).getByText('You host')).toBeTruthy();
    const upcoming = screen.getByRole('region', { name: 'Upcoming' });
    expect(within(upcoming).getByText('My RSVP: Yes')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Finished' })).getByText('Last week')).toBeTruthy();
  });

  it('schedules a game and navigates to it', async () => {
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { id: NEW_ID };
      return { games: [] };
    });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'New game' }));
    const start = screen.getByLabelText('Starts at') as HTMLInputElement;
    expect(start.type).toBe('datetime-local');
    // Defaults to about an hour from now.
    const delta = new Date(start.value).getTime() - Date.now();
    expect(delta).toBeGreaterThan(58 * 60_000);
    expect(delta).toBeLessThan(61 * 60_000);

    fireEvent.change(screen.getByLabelText('Game name'), { target: { value: '  Home game  ' } });
    const when = new Date(2026, 11, 5, 20, 30);
    fireEvent.change(start, { target: { value: toDatetimeLocal(when) } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule game' }));

    await screen.findByRole('heading', { name: 'Game page' });
    const post = mocks.api.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/games');
    const body = (post?.[1] as { body: { name: string; startsAt: string; settings: { kind: string } } }).body;
    expect(body.name).toBe('Home game');
    expect(body.startsAt).toBe(when.toISOString());
    expect(body.settings.kind).toBe('cash');
  });

  it('shows an API error when scheduling fails', async () => {
    mocks.api.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new mocks.ApiError(400, 'startsAt is in the past');
      return { games: [] };
    });
    renderLobby();
    fireEvent.click(screen.getByRole('button', { name: 'New game' }));
    fireEvent.change(screen.getByLabelText('Game name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule game' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('startsAt is in the past'));
  });
});
