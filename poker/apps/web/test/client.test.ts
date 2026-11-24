import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, deviceId } from '../src/api/client.js';

// Fake socket.io-client: one controllable socket per io() call.
const sio = vi.hoisted(() => {
  type Ack = (err: Error | null, res: unknown) => void;
  class FakeSocket {
    connected = false;
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    joins: { gameId: string; ack: Ack }[] = [];
    io = { on: () => undefined, off: () => undefined };
    on(ev: string, fn: (...a: unknown[]) => void) {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
      return this;
    }
    fire(ev: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(ev) ?? []) fn(...args);
    }
    timeout() {
      return {
        emit: (ev: string, payload: { gameId: string }, ack: Ack) => {
          if (ev === 'table:join') this.joins.push({ gameId: payload.gameId, ack });
        },
      };
    }
    connect() {
      this.connected = true;
      this.fire('connect');
    }
    drop() {
      this.connected = false;
      this.fire('disconnect', 'transport close');
    }
    removeAllListeners() {
      this.handlers.clear();
    }
    disconnect = vi.fn(() => {
      this.connected = false;
    });
  }
  const created: FakeSocket[] = [];
  return {
    created,
    io: vi.fn(() => {
      const s = new FakeSocket();
      created.push(s);
      return s;
    }),
  };
});
vi.mock('socket.io-client', () => ({ io: sio.io }));

const socketApi = await import('../src/api/socket.js');

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

describe('socket client', () => {
  afterEach(() => {
    socketApi.disconnectSocket();
    sio.created.length = 0;
    sio.io.mockClear();
  });

  const view = (gameId: string) => ({ gameId, marker: Math.random() }) as unknown as import('@poker/protocol').TableView;

  it('is a lazy singleton with credentials and the /socket.io path', () => {
    expect(sio.io).not.toHaveBeenCalled();
    const a = socketApi.getSocket();
    const b = socketApi.getSocket();
    expect(a).toBe(b);
    expect(sio.io).toHaveBeenCalledTimes(1);
    expect(sio.io).toHaveBeenCalledWith(expect.objectContaining({ path: '/socket.io', withCredentials: true }));
  });

  it('joins once connected, then re-joins remembered tables after a reconnect', async () => {
    socketApi.getSocket();
    const s = sio.created[0]!;
    const p = socketApi.joinTable('g1');
    expect(s.joins).toHaveLength(0);
    s.connect();
    expect(s.joins.map((j) => j.gameId)).toEqual(['g1']);
    const v1 = view('g1');
    s.joins[0]!.ack(null, { ok: true, view: v1 });
    await expect(p).resolves.toBe(v1);

    const rejoined: unknown[] = [];
    const off = socketApi.onRejoin((v) => rejoined.push(v));
    s.drop();
    s.connect();
    expect(s.joins.map((j) => j.gameId)).toEqual(['g1', 'g1']);
    const v2 = view('g1');
    s.joins[1]!.ack(null, { ok: true, view: v2 });
    await vi.waitFor(() => expect(rejoined).toEqual([v2]));
    off();

    socketApi.leaveTableRoom('g1');
    s.drop();
    s.connect();
    expect(s.joins).toHaveLength(2);
  });

  it('rejects with the server error and forgets the table', async () => {
    socketApi.getSocket();
    const s = sio.created[0]!;
    s.connect();
    const p = socketApi.joinTable('g9');
    s.joins[0]!.ack(null, { ok: false, error: 'No such game' });
    await expect(p).rejects.toThrow('No such game');
    s.drop();
    s.connect();
    expect(s.joins).toHaveLength(1);
  });

  it('disconnectSocket closes the socket and the next getSocket makes a new one', () => {
    const a = socketApi.getSocket();
    socketApi.disconnectSocket();
    expect(sio.created[0]!.disconnect).toHaveBeenCalled();
    expect(socketApi.getSocket()).not.toBe(a);
  });
});
