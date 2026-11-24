import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, deviceId } from '../src/api/client.js';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

function lastInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return call[1] ?? {};
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('returns parsed JSON on success and sends GET by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'u1', displayName: 'Ann' }));
    const me = await api<{ id: string; displayName: string }>('/api/auth/me');
    expect(me).toEqual({ id: 'u1', displayName: 'Ann' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/me');
    expect(lastInit().method).toBe('GET');
    expect(lastInit().body).toBeUndefined();
  });

  it('JSON-encodes object bodies and sets content-type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { ok: true }));
    await api('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } });
    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.co', password: 'x' }));
    expect(headerOf(init, 'content-type')).toBe('application/json');
  });

  it('defaults to POST when a body is given without a method', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await api('/api/x', { body: { a: 1 } });
    expect(lastInit().method).toBe('POST');
  });

  it('throws ApiError with the server error message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Invalid email or password' }, 'Unauthorized'));
    const err = await api('/api/auth/login', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe('Invalid email or password');
  });

  it('falls back to statusText when the error body has no error field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await api('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe('Bad Gateway');
  });

  it('resolves undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api('/api/friends/1', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(lastInit().method).toBe('DELETE');
  });

  it('always sends credentials: include', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    await api('/api/a');
    expect(lastInit().credentials).toBe('include');
    await api('/api/b', { method: 'POST', body: { x: 1 } });
    expect(lastInit().credentials).toBe('include');
  });

  it('sends the same x-device-id on every call and keeps it in localStorage', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    await api('/api/a');
    const first = headerOf(lastInit(), 'x-device-id');
    await api('/api/b');
    const second = headerOf(lastInit(), 'x-device-id');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
    expect(localStorage.getItem('poker.deviceId')).toBe(first);
    expect(deviceId()).toBe(first);
  });

  it('reuses a device id already stored', async () => {
    localStorage.setItem('poker.deviceId', 'existing-device');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await api('/api/a');
    expect(headerOf(lastInit(), 'x-device-id')).toBe('existing-device');
  });

  it('passes FormData bodies through untouched and without a JSON content-type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { avatarUrl: '/avatars/u1.png' }));
    const form = new FormData();
    form.append('file', new Blob(['png-bytes'], { type: 'image/png' }), 'me.png');
    await api('/api/profile/avatar', { method: 'POST', body: form });
    const init = lastInit();
    expect(init.body).toBe(form);
    expect(headerOf(init, 'content-type')).toBeNull();
  });

  it('forwards the abort signal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const ctrl = new AbortController();
    await api('/api/a', { signal: ctrl.signal });
    expect(lastInit().signal).toBe(ctrl.signal);
  });
});
