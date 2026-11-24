import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Card } from './types.js';

const TWO_32 = 0x1_0000_0000;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

function hmacHex(key: string, msg: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(msg)));
}

/** 32 random bytes, lowercase hex */
export function newServerSeed(): string {
  return randomHex(32);
}

/** 16 random bytes, lowercase hex */
export function newClientSeed(): string {
  return randomHex(16);
}

/** sha256(utf8(serverSeed)) hex */
export function commit(serverSeed: string): string {
  return sha256Hex(serverSeed);
}

/** Uniform integer in [0, n) by rejection sampling over a uint32 stream. */
export function uniformInt(n: number, nextU32: () => number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
    throw new RangeError(`uniformInt: invalid range ${n}`);
  }
  const limit = TWO_32 - (TWO_32 % n);
  let x = nextU32();
  while (x >= limit) x = nextU32();
  return x % n;
}

/** uint32 stream from HMAC-SHA256(key = utf8(serverSeed), msg = `${seeds}:${handNumber}:${counter}`). */
function u32Stream(serverSeed: string, clientSeeds: string[], handNumber: number): () => number {
  const key = utf8ToBytes(serverSeed);
  const prefix = `${[...clientSeeds].sort().join('|')}:${handNumber}:`;
  let counter = 0;
  let view: DataView | null = null;
  let offset = 32;
  return () => {
    if (view === null || offset >= 32) {
      const block = hmac(sha256, key, utf8ToBytes(prefix + String(counter)));
      counter += 1;
      view = new DataView(block.buffer, block.byteOffset, block.byteLength);
      offset = 0;
    }
    const x = view.getUint32(offset, false);
    offset += 4;
    return x;
  };
}

export function deckFromSeeds(serverSeed: string, clientSeeds: string[], handNumber: number): Card[] {
  const next = u32Stream(serverSeed, clientSeeds, handNumber);
  const deck: Card[] = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i >= 1; i--) {
    const j = uniformInt(i + 1, next);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck;
}

export function verifyDeck(
  commitment: string,
  serverSeed: string,
  clientSeeds: string[],
  handNumber: number,
  deck: Card[],
): boolean {
  if (commit(serverSeed) !== commitment) return false;
  const expected = deckFromSeeds(serverSeed, clientSeeds, handNumber);
  return deck.length === expected.length && expected.every((c, i) => deck[i] === c);
}

/** hex(HMAC-SHA256(key = utf8(saltKey), msg = 'salt:' + p)) */
export function cardSalt(saltKey: string, p: number): string {
  return hmacHex(saltKey, `salt:${p}`);
}

/** [p] = sha256(utf8(cardSalt(saltKey, p) + ':' + p + ':' + deck[p])) hex */
export function cardCommitments(deck: Card[], saltKey: string): string[] {
  return deck.map((card, p) => sha256Hex(`${cardSalt(saltKey, p)}:${p}:${card}`));
}

export function verifyCard(commitment: string, salt: string, position: number, card: Card): boolean {
  return sha256Hex(`${salt}:${position}:${card}`) === commitment;
}
