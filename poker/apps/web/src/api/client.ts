/**
 * Thin fetch wrapper for the REST API (I-10).
 *
 * - `path` starts with '/api/'.
 * - JSON in and out; `body` is JSON-encoded unless it is a FormData (then the browser sets the multipart boundary).
 * - 204 (or an empty body) resolves to `undefined`.
 * - A non-2xx answer throws `ApiError(status, body.error ?? statusText)`.
 * - Always `credentials: 'include'` and an `x-device-id` header.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const DEVICE_KEY = 'poker.deviceId';
let memoryDeviceId: string | null = null;

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for old browsers / insecure contexts: RFC 4122 v4 from getRandomValues.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A uuid kept in localStorage under 'poker.deviceId' (falls back to memory when storage is unavailable). */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const fresh = memoryDeviceId ?? randomUuid();
    localStorage.setItem(DEVICE_KEY, fresh);
    memoryDeviceId = fresh;
    return fresh;
  } catch {
    memoryDeviceId ??= randomUuid();
    return memoryDeviceId;
  }
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

function errorMessage(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (typeof err === 'string' && err !== '') return err;
  }
  return fallback;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-device-id': deviceId() };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
      body = init.body;
    } else {
      body = JSON.stringify(init.body);
      headers['content-type'] = 'application/json';
    }
  }

  const res = await fetch(path, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    credentials: 'include',
    signal: init.signal,
  });

  const text = res.status === 204 ? '' : await res.text();
  let parsed: unknown = undefined;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(parsed, res.statusText || `Request failed (${res.status})`));
  }
  if (text !== '' && parsed === undefined) {
    throw new ApiError(res.status, 'The server sent an unreadable response');
  }
  return parsed as T;
}
