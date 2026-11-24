/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
import type { Card } from './types.js';

/** 32 random bytes, lowercase hex */
export function newServerSeed(): string {
  throw new Error('not implemented');
}

/** 16 random bytes, lowercase hex */
export function newClientSeed(): string {
  throw new Error('not implemented');
}

/** sha256(utf8(serverSeed)) hex */
export function commit(serverSeed: string): string {
  throw new Error('not implemented');
}

export function deckFromSeeds(serverSeed: string, clientSeeds: string[], handNumber: number): Card[] {
  throw new Error('not implemented');
}

export function verifyDeck(commitment: string, serverSeed: string, clientSeeds: string[], handNumber: number, deck: Card[]): boolean {
  throw new Error('not implemented');
}
