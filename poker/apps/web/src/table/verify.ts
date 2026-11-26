// stub (W0): replaced by task W11
import type { Card, HandRecord } from '@poker/engine';

export function checkCardProof(
  _commitments: string[],
  _proof: { position: number; card: Card; salt: string },
): boolean {
  throw new Error('not implemented');
}

/** Deck position of a hole card per F10: `round * seatCount + seatOrder` (W11 may refine the parameters). */
export function expectedPosition(_seatCount: number, _seatOrder: number, _round: number): number {
  throw new Error('not implemented');
}

/** `fairness` is the revealed seeds of the game (F1); its type is W11's to define. */
export function verifyGame(
  _fairness: unknown,
  _hands: HandRecord[],
): { handNumber: number; ok: boolean; problem?: string }[] {
  throw new Error('not implemented');
}
