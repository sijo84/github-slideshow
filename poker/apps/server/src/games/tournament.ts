import { levelAt, type BlindLevel } from '@poker/engine';
import type { GameSettings, ResultEntry } from '@poker/protocol';
import type { Pool, PoolClient } from 'pg';
import { buyIn, ensureAccount, transfer } from '../wallet/ledger.js';

/**
 * Single-table tournament controller (play-money prize pool).
 *
 * Money: every entry (the initial buy-in done by the TableManager at `sit`, and each
 * rebuy done here) moves `startingStack` from the wallet to the player's `table` account.
 * The TableManager moves chips between table accounts after every hand, so at the finish
 * the game's table accounts together hold exactly the prize pool. The finish sweeps them
 * to the bank and pays each prize bank → wallet in one transaction, so the ledger stays
 * zero-sum.
 */

export interface TournamentControllerLike {
  levelFor(now: number): BlindLevel;
  /** When the current level ends (ms epoch), or null on the last level. */
  nextLevelAt(now: number): number | null;
  onHandEnded(
    stacks: { userId: string; startStack: number; endStack: number }[],
    now: number,
  ): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }>;
  canRebuy(userId: string, now: number): boolean;
  /** Chips added to the stack. */
  rebuy(userId: string, now: number): Promise<number>;
  results(): Promise<ResultEntry[]>;
}

type HandStack = { userId: string; startStack: number; endStack: number };

/** Order of players busting in the same hand: bigger start stack = better place; 0 = shared place. */
const bustOrder = (a: HandStack, b: HandStack): number => b.startStack - a.startStack;

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export class TournamentController implements TournamentControllerLike {
  private readonly pool: Pool;
  private readonly gameId: string;
  private readonly settings: GameSettings;
  private readonly startedAtMs: number;
  private readonly pausedMs: () => number;
  /** Entrants in order of first appearance. */
  private readonly entrants = new Set<string>();
  /** Decided places (eliminated players, and the winner once finished). */
  private readonly places = new Map<string, number>();
  /** Prizes, filled at the finish. */
  private readonly paid = new Map<string, number>();
  /** Finish groups in decision order, each sorted best-first by the bust comparator. */
  private readonly groups: { place: number; userIds: string[] }[] = [];
  private finished = false;

  constructor(deps: { pool: Pool; gameId: string; settings: GameSettings; startedAtMs: number; pausedMs: () => number }) {
    this.pool = deps.pool;
    this.gameId = deps.gameId;
    this.settings = deps.settings;
    this.startedAtMs = deps.startedAtMs;
    this.pausedMs = deps.pausedMs;
  }

  private clock(now: number): { index: number; msLeft: number } {
    return levelAt(this.settings.levels, this.startedAtMs, now, this.pausedMs());
  }

  levelFor(now: number): BlindLevel {
    const level = this.settings.levels[this.clock(now).index];
    if (level === undefined) throw new Error('no blind level');
    return level;
  }

  nextLevelAt(now: number): number | null {
    const { index, msLeft } = this.clock(now);
    if (index >= this.settings.levels.length - 1) return null;
    return now + msLeft;
  }

  canRebuy(userId: string, now: number): boolean {
    const { rebuys } = this.settings;
    return (
      !this.finished &&
      rebuys.allowed &&
      this.levelFor(now).level <= rebuys.untilLevel &&
      // Not limited to known entrants: canRebuy is asked before the first onHandEnded,
      // and the TableManager only asks for seated players whose stack is 0.
      !this.places.has(userId)
    );
  }

  async rebuy(userId: string, now: number): Promise<number> {
    if (!this.canRebuy(userId, now)) throw conflict('Rebuy is not allowed now');
    await buyIn(this.pool, userId, this.gameId, this.settings.startingStack);
    return this.settings.startingStack;
  }

  async onHandEnded(stacks: HandStack[], now: number): Promise<{ eliminated: { userId: string; place: number }[]; finished: boolean }> {
    void now;
    if (this.finished) throw new Error('The tournament has finished');
    for (const s of stacks) this.entrants.add(s.userId);

    const stillIn = this.entrants.size - this.places.size;
    const busted = stacks.filter((s) => s.endStack === 0 && !this.places.has(s.userId)).sort(bustOrder);
    const newPlaces = new Map<string, number>();
    const newGroups: { place: number; userIds: string[] }[] = [];
    const firstFree = stillIn - busted.length + 1;
    busted.forEach((s, i) => {
      const prev = busted[i - 1];
      const group = newGroups[newGroups.length - 1];
      if (prev !== undefined && group !== undefined && bustOrder(prev, s) === 0) {
        group.userIds.push(s.userId);
        newPlaces.set(s.userId, group.place);
      } else {
        newGroups.push({ place: firstFree + i, userIds: [s.userId] });
        newPlaces.set(s.userId, firstFree + i);
      }
    });

    const remaining = [...this.entrants].filter((u) => !this.places.has(u) && !newPlaces.has(u));
    const finished = remaining.length <= 1;
    if (finished) {
      const winner = remaining[0];
      if (winner !== undefined) {
        newPlaces.set(winner, 1);
        newGroups.push({ place: 1, userIds: [winner] });
      }
      const allPlaces = new Map([...this.places, ...newPlaces]);
      const allGroups = [...this.groups, ...newGroups].sort((a, b) => a.place - b.place);
      const prizeList = await this.payOut(allPlaces, allGroups);
      for (const p of prizeList) this.paid.set(p.userId, p.prize);
      this.finished = true;
    }

    for (const [u, p] of newPlaces) this.places.set(u, p);
    this.groups.push(...newGroups);
    const eliminated = busted.map((s) => ({ userId: s.userId, place: newPlaces.get(s.userId) ?? 0 }));
    return { eliminated, finished };
  }

  /** Sweeps the table accounts to the bank, pays the prizes and stores the results, all in one transaction. */
  private async payOut(
    places: Map<string, number>,
    groups: { place: number; userIds: string[] }[],
  ): Promise<{ userId: string; place: number; prize: number }[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const bank = await ensureAccount(client, 'bank');
      const pool = await this.sweep(client, bank);
      const list = prizes(
        pool,
        this.settings.payouts,
        groups.map((g) => g.userIds),
      );
      for (const p of list) {
        if (p.prize > 0) {
          const wallet = await ensureAccount(client, 'wallet', p.userId);
          await transfer(client, bank, wallet, p.prize, 'prize');
        }
      }
      for (const userId of this.entrants) {
        const prize = list.find((p) => p.userId === userId)?.prize ?? 0;
        await client.query('insert into tournament_results (game_id, user_id, place, prize) values ($1, $2, $3, $4)', [
          this.gameId,
          userId,
          places.get(userId) ?? this.entrants.size,
          prize,
        ]);
      }
      await client.query('commit');
      return list;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Moves every positive table balance of this game to the bank; returns the total (the prize pool). */
  private async sweep(client: PoolClient, bank: string): Promise<number> {
    const { rows } = await client.query<{ id: string; total: number }>(
      `select a.id, coalesce(sum(e.amount), 0)::bigint as total
         from ledger_accounts a left join ledger_entries e on e.account_id = a.id
        where a.kind = 'table' and a.game_id = $1
        group by a.id order by a.id`,
      [this.gameId],
    );
    let total = 0;
    for (const r of rows) {
      if (r.total > 0) {
        await transfer(client, r.id, bank, r.total, 'tournament sweep');
        total += r.total;
      }
    }
    return total;
  }

  async results(): Promise<ResultEntry[]> {
    const ids = [...this.places.keys()];
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ id: string; display_name: string }>(
      'select id, display_name from users where id = any($1::uuid[])',
      [ids],
    );
    const names = new Map(rows.map((r) => [r.id, r.display_name]));
    return ids
      .map((userId) => ({
        userId,
        name: names.get(userId) ?? '',
        place: this.places.get(userId) ?? 0,
        prize: this.paid.get(userId) ?? 0,
      }))
      .sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
  }
}

/**
 * Prize split. `payouts`: integer percents for places 1..k (summing to 100). `finishOrder`:
 * best first; an inner array is a group of players tied for consecutive places.
 * Place p gets floor(pool × payouts[p−1] / 100); places beyond k get 0. Every chip not
 * paid out that way (rounding, or places in `payouts` with nobody to take them) goes to
 * place 1. A tie group shares the sum of its places' prizes equally (integer division);
 * the remainder chips go one each to the group's players in array order. The total paid
 * always equals `prizePool` (when there is at least one player).
 */
export function prizes(
  prizePool: number,
  payouts: number[],
  finishOrder: string[][],
): { userId: string; place: number; prize: number }[] {
  const players = finishOrder.reduce((n, g) => n + g.length, 0);
  if (players === 0) return [];
  const byPlace: number[] = [];
  for (let p = 1; p <= players; p++) {
    const pct = payouts[p - 1] ?? 0;
    byPlace.push(Math.floor((prizePool * pct) / 100));
  }
  byPlace[0] = (byPlace[0] ?? 0) + prizePool - byPlace.reduce((a, b) => a + b, 0);

  const out: { userId: string; place: number; prize: number }[] = [];
  let place = 1;
  for (const group of finishOrder) {
    if (group.length === 0) continue;
    const total = byPlace.slice(place - 1, place - 1 + group.length).reduce((a, b) => a + b, 0);
    const share = Math.floor(total / group.length);
    const rest = total - share * group.length;
    group.forEach((userId, i) => out.push({ userId, place, prize: share + (i < rest ? 1 : 0) }));
    place += group.length;
  }
  return out;
}
