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
  return { ApiError, api: vi.fn(), refresh: vi.fn(), setMe: vi.fn() };
});

const me = { id: 'u1', email: 'ann@example.com', displayName: 'Ann', avatarUrl: '/api/users/u1/avatar.svg' };

vi.mock('../src/api/client.js', () => ({ api: mocks.api, ApiError: mocks.ApiError }));
vi.mock('../src/api/useMe.js', () => ({
  useMe: () => ({ me, loading: false, refresh: mocks.refresh, setMe: mocks.setMe }),
}));
vi.mock('../src/anim/tween.js', () => ({
  tween: (opts: { to: unknown; onUpdate(v: unknown): void }) => {
    opts.onUpdate(opts.to);
    return { cancel: () => {}, done: Promise.resolve() };
  },
  easeOutCubic: (t: number) => t,
  prefersReducedMotion: () => false,
}));

import { Profile } from '../src/pages/Profile.js';

const invites = [
  { code: 'NEW1', used: false, createdAt: '2026-11-20T10:00:00.000Z' },
  { code: 'OLD1', used: true, createdAt: '2026-11-01T10:00:00.000Z' },
];

function route(handlers: Record<string, (init?: { method?: string; body?: unknown }) => unknown>) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected ${key}`);
    return h(init);
  });
}

function renderProfile() {
  return render(
    <MemoryRouter>
      <Profile />
    </MemoryRouter>,
  );
}

const createObjectURL = vi.fn(() => 'blob:preview-1');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  mocks.api.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => cleanup());

describe('Profile page', () => {
  it('shows avatar, read-only email, display name and the invite list', async () => {
    route({ 'GET /api/invites': () => ({ invites }) });
    renderProfile();
    expect(screen.getByRole('heading', { level: 1, name: 'Profile' })).toBeTruthy();
    const img = screen.getByRole('img', { name: 'Ann' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(me.avatarUrl);
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    expect(email.value).toBe('ann@example.com');
    expect(email.readOnly).toBe(true);
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ann');
    expect(screen.getByRole('heading', { name: 'Invite codes' })).toBeTruthy();
    expect(await screen.findByText('NEW1')).toBeTruthy();
    expect(screen.getByText('OLD1')).toBeTruthy();
    expect(screen.getByText('Used')).toBeTruthy();
  });

  it('validates and saves the display name, then refreshes', async () => {
    route({
      'GET /api/invites': () => ({ invites: [] }),
      'PATCH /api/profile': () => ({ ...me, displayName: 'Annie' }),
    });
    renderProfile();
    const input = screen.getByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Display name must be 2 to 24 characters').id).toBe(input.getAttribute('aria-describedby'));
    expect(mocks.api).not.toHaveBeenCalledWith('/api/profile', expect.anything());

    fireEvent.change(input, { target: { value: ' Annie ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.api).toHaveBeenCalledWith('/api/profile', { method: 'PATCH', body: { displayName: 'Annie' } });
    expect(await screen.findByText('Display name saved')).toBeTruthy();
  });

  it('rejects a wrong file type or a too-large file before uploading', async () => {
    route({ 'GET /api/invites': () => ({ invites: [] }) });
    renderProfile();
    const picker = screen.getByLabelText('Avatar image');
    fireEvent.change(picker, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    expect(screen.getByRole('alert').textContent).toBe('Avatar must be a PNG, JPEG or WebP image');

    const big = new File([new Uint8Array(1_048_577)], 'big.png', { type: 'image/png' });
    fireEvent.change(picker, { target: { files: [big] } });
    expect(screen.getByRole('alert').textContent).toBe('Avatar must be 1 MB or smaller');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Upload avatar' })).toBeNull();
  });

  it('previews, uploads as multipart and revokes the preview URL', async () => {
    route({
      'GET /api/invites': () => ({ invites: [] }),
      'POST /api/profile/avatar': () => ({ avatarUrl: '/avatars/u1.png' }),
    });
    renderProfile();
    const file = new File(['png'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Avatar image'), { target: { files: [file] } });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(screen.getByRole('img', { name: 'Ann' }).getAttribute('src')).toBe('blob:preview-1');

    fireEvent.click(screen.getByRole('button', { name: 'Upload avatar' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const call = mocks.api.mock.calls.find((c) => c[0] === '/api/profile/avatar');
    const body = (call?.[1] as { body: FormData }).body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('avatar')).toBe(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(screen.getByRole('img', { name: 'Ann' }).getAttribute('src')).toBe(me.avatarUrl);
  });

  it('revokes the preview URL on unmount', () => {
    route({ 'GET /api/invites': () => ({ invites: [] }) });
    const { unmount } = renderProfile();
    fireEvent.change(screen.getByLabelText('Avatar image'), {
      target: { files: [new File(['png'], 'me.png', { type: 'image/png' })] },
    });
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('removes the avatar', async () => {
    route({
      'GET /api/invites': () => ({ invites: [] }),
      'DELETE /api/profile/avatar': () => ({ avatarUrl: me.avatarUrl }),
    });
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Remove avatar' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.api).toHaveBeenCalledWith('/api/profile/avatar', { method: 'DELETE' });
  });

  it('creates an invite code and reloads the list', async () => {
    let list: typeof invites = [];
    route({
      'GET /api/invites': () => ({ invites: list }),
      'POST /api/invites': () => {
        list = [{ code: 'FRESH9', used: false, createdAt: '2026-11-24T10:00:00.000Z' }];
        return { code: 'FRESH9' };
      },
    });
    renderProfile();
    expect(await screen.findByText('No invite codes yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
    expect(await screen.findByText('FRESH9')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('FRESH9');
  });

  it('shows server errors in the alert', async () => {
    route({
      'GET /api/invites': () => ({ invites: [] }),
      'DELETE /api/profile/avatar': () => {
        throw new mocks.ApiError(500, 'Something broke');
      },
    });
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Remove avatar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Something broke');
  });
});
