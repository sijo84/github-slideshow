/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures; the owning task replaces this file */
export interface Transfer { from: string; to: string; chips: number }

export function settle(net: { playerId: string; chips: number }[]): { transfers: Transfer[] } {
  throw new Error('not implemented');
}

/** 1250 -> "$1,250", -40 -> "-$40" */
export function formatPlayMoney(chips: number): string {
  throw new Error('not implemented');
}

export function settlementText(transfers: Transfer[], names: Record<string, string>): string {
  throw new Error('not implemented');
}
