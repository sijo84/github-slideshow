import type { Pool } from 'pg';

export type NotifyKind = 'invite' | 'gameStarting' | 'friendRequest' | 'seatRequest' | 'integrityFlag';

export interface NotifyPayload {
  id: string;
  kind: NotifyKind;
  text: string;
  link?: string;
}

type NotifyEmitter = (userId: string, payload: NotifyPayload) => void;

let emitter: NotifyEmitter | null = null;

/** The socket layer registers the function that pushes a notification to a user's open connections. */
export function setNotifyEmitter(fn: NotifyEmitter | null): void {
  emitter = fn;
}

/** Stores an in-app notification and pushes it to the user if an emitter is registered. */
export async function notify(pool: Pool, userId: string, kind: NotifyKind, text: string, link?: string): Promise<NotifyPayload> {
  const res = await pool.query<{ id: string | number }>(
    'insert into notifications (user_id, kind, text, link) values ($1, $2, $3, $4) returning id',
    [userId, kind, text, link ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('insert into notifications returned no row');
  const payload: NotifyPayload = { id: String(row.id), kind, text };
  if (link !== undefined) payload.link = link;
  if (emitter) {
    try {
      emitter(userId, payload);
    } catch {
      // A failing push must not fail the caller; the row is stored and shows up in GET /notifications.
    }
  }
  return payload;
}
