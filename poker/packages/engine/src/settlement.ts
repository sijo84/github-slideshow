export interface Transfer { from: string; to: string; chips: number }

interface Balance { playerId: string; amount: number }

/** Sort by amount descending, then playerId ascending. */
function byAmountThenId(a: Balance, b: Balance): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/**
 * Works out who owes whom. Greedy: the largest debtor pays the largest creditor
 * min(debt, credit), repeated until everyone is even. Ties are broken by playerId (ascending).
 * Produces at most n-1 transfers, each with chips > 0.
 */
export function settle(net: { playerId: string; chips: number }[]): { transfers: Transfer[] } {
  let sum = 0n;
  for (const entry of net) {
    if (!Number.isSafeInteger(entry.chips)) {
      throw new Error(`Net chips for ${entry.playerId} must be a safe integer, got ${String(entry.chips)}`);
    }
    sum += BigInt(entry.chips);
  }
  if (sum !== 0n) {
    throw new Error(`Net chips must sum to 0, got ${sum.toString()}`);
  }

  const debtors: Balance[] = [];
  const creditors: Balance[] = [];
  for (const entry of net) {
    if (entry.chips < 0) debtors.push({ playerId: entry.playerId, amount: -entry.chips });
    else if (entry.chips > 0) creditors.push({ playerId: entry.playerId, amount: entry.chips });
  }

  const transfers: Transfer[] = [];
  for (;;) {
    debtors.sort(byAmountThenId);
    creditors.sort(byAmountThenId);
    const debtor = debtors[0];
    const creditor = creditors[0];
    if (debtor === undefined || creditor === undefined) break;
    const chips = Math.min(debtor.amount, creditor.amount);
    transfers.push({ from: debtor.playerId, to: creditor.playerId, chips });
    debtor.amount -= chips;
    creditor.amount -= chips;
    if (debtor.amount === 0) debtors.shift();
    if (creditor.amount === 0) creditors.shift();
  }
  return { transfers };
}

/** Formats chips as play-money dollars (1 chip = $1): 1250 -> "$1,250", -40 -> "-$40". Locale-independent. */
export function formatPlayMoney(chips: number): string {
  if (!Number.isSafeInteger(chips)) {
    throw new Error(`Chips must be a safe integer, got ${String(chips)}`);
  }
  const digits = String(Math.abs(chips));
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits.charAt(i);
  }
  return `${chips < 0 ? '-' : ''}$${grouped}`;
}

const NOTICE = 'Play money only. Settle any real-money arrangements among yourselves, outside this app.';

/** Human-readable settlement: one "X owes Y $N" line per transfer, a blank line, then the play-money notice. */
export function settlementText(transfers: Transfer[], names: Record<string, string>): string {
  const nameOf = (id: string): string => (Object.hasOwn(names, id) ? names[id] : undefined) ?? id;
  const lines = transfers.length === 0
    ? ['Everyone is even.']
    : transfers.map((t) => `${nameOf(t.from)} owes ${nameOf(t.to)} ${formatPlayMoney(t.chips)}`);
  return [...lines, '', NOTICE].join('\n');
}
