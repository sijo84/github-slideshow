/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Pool } from 'pg';

export type NotifyKind = 'invite' | 'gameStarting' | 'friendRequest' | 'seatRequest' | 'integrityFlag';

export interface NotifyPayload {
  id: string;
  kind: NotifyKind;
  text: string;
  link?: string;
}

export function setNotifyEmitter(fn: ((userId: string, payload: NotifyPayload) => void) | null): void {
  throw new Error('not implemented');
}

export async function notify(pool: Pool, userId: string, kind: NotifyKind, text: string, link?: string): Promise<NotifyPayload> {
  throw new Error('not implemented');
}
