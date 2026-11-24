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
    setMe: vi.fn(),
    refresh: vi.fn(),
    tween: vi.fn(),
  };
});

vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/api/useMe.js', () => ({
  useMe: () => ({ me: null, loading: false, refresh: mocks.refresh, setMe: mocks.setMe }),
}));
vi.mock('../src/anim/tween.js', () => ({
  tween: mocks.tween,
  easeOutCubic: (t: number) => 1 - (1 - t) ** 3,
  prefersReducedMotion: () => false,
}));

import { Login } from '../src/pages/Login.js';

const user = { id: 'u1', email: 'ann@example.com', displayName: 'Ann', avatarUrl: '/api/users/u1/avatar.svg' };

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<h1>Lobby</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.setMe.mockReset();
  mocks.tween.mockReset();
  // A tween that jumps straight to its final value.
  mocks.tween.mockImplementation((opts: { to: unknown; onUpdate(v: unknown): void; onDone?(): void }) => {
    opts.onUpdate(opts.to);
    opts.onDone?.();
    return { cancel: vi.fn(), done: Promise.resolve() };
  });
});

afterEach(() => {
  cleanup();
});

describe('Login page', () => {
  it('renders login mode with the expected heading, fields and buttons', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1, name: 'Login' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(screen.queryByLabelText('Invite code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs the page-enter tween (opacity + 8px rise, 220 ms, easeOutCubic) and ends fully visible', () => {
    const { container } = renderLogin();
    expect(mocks.tween).toHaveBeenCalledTimes(1);
    const opts = mocks.tween.mock.calls[0]?.[0] as {
      id: string;
      from: number[];
      to: number[];
      durationMs: number;
      ease(t: number): number;
    };
    expect(opts.id).toBe('page:login');
    expect(opts.from).toEqual([0, 8, 0]);
    expect(opts.to).toEqual([1, 0, 0]);
    expect(opts.durationMs).toBe(220);
    expect(opts.ease(0.5)).toBeCloseTo(0.875);
    const card = container.querySelector('.auth-card') as HTMLElement;
    expect(card.style.opacity === '' || card.style.opacity === '1').toBe(true);
    expect(card.style.transform).toBe('');
  });

  it('cancels the tween on unmount', () => {
    const cancel = vi.fn();
    mocks.tween.mockImplementation(() => ({ cancel, done: Promise.resolve() }));
    const { unmount } = renderLogin();
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('toggles between login and register mode', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Create account' })).toBeTruthy();
    expect(screen.getByLabelText('Display name')).toBeTruthy();
    expect(screen.getByLabelText('Invite code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'I already have an account' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Login' })).toBeTruthy();
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
  });

  it('shows a linked message for an invalid email and does not call the API', () => {
    renderLogin();
    type('Email', 'not-an-email');
    type('Password', 'whatever-password');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    const email = screen.getByLabelText('Email');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    const msg = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(msg).toContain('Enter a valid email address');
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('requires a password in login mode', () => {
    renderLogin();
    type('Email', 'ann@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByText('Password is required')).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('rejects a short password and a bad display name in register mode', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    type('Email', 'ann@example.com');
    type('Password', 'short');
    type('Display name', 'A');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Password must be at least 10 characters')).toBeTruthy();
    expect(screen.getByText('Display name must be 2 to 24 characters')).toBeTruthy();
    const name = screen.getByLabelText('Display name');
    expect(name.getAttribute('aria-describedby')).toContain(
      screen.getByText('Display name must be 2 to 24 characters').id,
    );

    type('Display name', 'x'.repeat(25));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Display name must be 2 to 24 characters')).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('logs in, stores the user and navigates to /', async () => {
    mocks.api.mockResolvedValue(user);
    renderLogin();
    type('Email', '  ann@example.com ');
    type('Password', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(mocks.api).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      body: { email: 'ann@example.com', password: 'correct-horse' },
    });
    expect(await screen.findByRole('heading', { name: 'Lobby' })).toBeTruthy();
    expect(mocks.setMe).toHaveBeenCalledWith(user);
  });

  it('disables submit while the request is pending', async () => {
    let resolve: (u: typeof user) => void = () => {};
    mocks.api.mockReturnValue(new Promise((r) => (resolve = r)));
    renderLogin();
    type('Email', 'ann@example.com');
    type('Password', 'correct-horse');
    const submit = screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement;
    fireEvent.click(submit);
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    resolve(user);
    expect(await screen.findByRole('heading', { name: 'Lobby' })).toBeTruthy();
  });

  it('shows the server message on a 401 and keeps the form values', async () => {
    mocks.api.mockRejectedValue(new mocks.ApiError(401, 'Invalid email or password'));
    renderLogin();
    type('Email', 'ann@example.com');
    type('Password', 'wrong-password');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Invalid email or password');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ann@example.com');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('wrong-password');
    expect((screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.setMe).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Login' })).toBeTruthy();
  });

  it('registers with displayName and inviteCode', async () => {
    mocks.api.mockResolvedValue(user);
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    type('Email', 'ann@example.com');
    type('Password', 'long-enough-pw');
    type('Display name', ' Ann ');
    type('Invite code', 'ABC123');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(mocks.api).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: { email: 'ann@example.com', password: 'long-enough-pw', displayName: 'Ann', inviteCode: 'ABC123' },
    });
    expect(await screen.findByRole('heading', { name: 'Lobby' })).toBeTruthy();
    expect(mocks.setMe).toHaveBeenCalledWith(user);
  });

  it('registers without an invite code when the field is empty', async () => {
    mocks.api.mockResolvedValue(user);
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    type('Email', 'ann@example.com');
    type('Password', 'long-enough-pw');
    type('Display name', 'Ann');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(mocks.api).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: { email: 'ann@example.com', password: 'long-enough-pw', displayName: 'Ann' },
    });
    await waitFor(() => expect(mocks.setMe).toHaveBeenCalledWith(user));
  });

  it('shows a 403 invite error from register in the alert', async () => {
    mocks.api.mockRejectedValue(new mocks.ApiError(403, 'A valid invite code is required'));
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    type('Email', 'ann@example.com');
    type('Password', 'long-enough-pw');
    type('Display name', 'Ann');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A valid invite code is required');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ann');
  });
});
