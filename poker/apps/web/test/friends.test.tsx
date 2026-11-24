import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

import { Friends } from '../src/pages/Friends.js';

const ann = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Ann', avatarUrl: '' };
const ben = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Ben', avatarUrl: '' };
const cat = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Cat', avatarUrl: '' };

function renderFriends() {
  return render(
    <MemoryRouter>
      <Friends />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
});
afterEach(() => cleanup());

describe('Friends', () => {
  it('lists friends, incoming and outgoing requests', async () => {
    mocks.api.mockResolvedValue({ friends: [ann], incoming: [ben], outgoing: [cat] });
    renderFriends();
    const link = await screen.findByRole('link', { name: 'Ann' });
    expect(link.getAttribute('href')).toBe(`/stats/${ann.id}`);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByText('Ben')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(screen.getByText('Cat')).toBeTruthy();
  });

  it('sends a request and shows API errors in an alert', async () => {
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/api/friends/requests' && init?.method === 'POST') throw new mocks.ApiError(404, 'No user found');
      return { friends: [], incoming: [], outgoing: [] };
    });
    renderFriends();
    fireEvent.change(screen.getByLabelText("Friend's email"), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No user found'));
    expect(mocks.api).toHaveBeenCalledWith('/api/friends/requests', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });
  });

  it('accepts an incoming request', async () => {
    let accepted = false;
    mocks.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/accept')) {
        accepted = true;
        return { status: 'accepted' };
      }
      return accepted
        ? { friends: [ben], incoming: [], outgoing: [] }
        : { friends: [], incoming: [ben], outgoing: [] };
    });
    renderFriends();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByRole('link', { name: 'Ben' })).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith(`/api/friends/requests/${ben.id}/accept`, { method: 'POST' });
  });
});
