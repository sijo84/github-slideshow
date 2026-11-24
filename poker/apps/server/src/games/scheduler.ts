import type { Pool } from 'pg';
import type { notify } from '../notify.js';

export interface SchedulerDeps {
  pool: Pool;
  clock: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  tables: { open(gameId: string): Promise<void> };
  notify: typeof notify;
}

const TICK_MS = 15_000;
const REMINDER_MS = 10 * 60_000;
const REMINDER_SUFFIX = 'starts in 10 minutes';

interface ScheduledGame {
  id: string;
  host: string;
  name: string;
  starts_at: Date;
}

/** The host plus every invitee who answered yes or maybe, without duplicates. */
async function recipients(pool: Pool, game: ScheduledGame): Promise<string[]> {
  const res = await pool.query<{ user_id: string }>(
    `select user_id from game_invites where game_id = $1 and rsvp in ('yes', 'maybe') order by user_id`,
    [game.id],
  );
  const ids = [game.host];
  for (const row of res.rows) if (!ids.includes(row.user_id)) ids.push(row.user_id);
  return ids;
}

/**
 * Starts the game loop: a tick after 0 ms, then one 15 s after each tick finishes (ticks never overlap).
 * Each tick sends the one-time "starts in 10 minutes" reminder and opens games whose start time has come.
 * Returns a function that stops the loop; a tick in flight finishes but does not re-arm.
 */
export function startScheduler(deps: SchedulerDeps): () => void {
  const { pool } = deps;
  let stopped = false;
  let handle: unknown = null;
  // Short-cut for reminders already sent by this instance; the notifications table is the durable record.
  const reminded = new Set<string>();

  const remind = async (game: ScheduledGame): Promise<void> => {
    const link = `/games/${game.id}`;
    for (const userId of await recipients(pool, game)) {
      const key = `${game.id}:${userId}`;
      if (reminded.has(key)) continue;
      const existing = await pool.query(
        `select 1 from notifications where user_id = $1 and kind = 'gameStarting' and link = $2 and text like $3 limit 1`,
        [userId, link, `%${REMINDER_SUFFIX}`],
      );
      if (existing.rowCount === 0) {
        await deps.notify(pool, userId, 'gameStarting', `${game.name} ${REMINDER_SUFFIX}`, link);
      }
      reminded.add(key);
    }
  };

  const open = async (game: ScheduledGame): Promise<void> => {
    await deps.tables.open(game.id);
    const res = await pool.query(`update games set status = 'open' where id = $1 and status = 'scheduled'`, [game.id]);
    if (res.rowCount === 0) return; // someone else changed the status; they own the notification
    for (const userId of await recipients(pool, game)) {
      await deps.notify(pool, userId, 'gameStarting', `${game.name} is starting now`, `/table/${game.id}`);
    }
  };

  const runTick = async (now: number): Promise<void> => {
    const res = await pool.query<ScheduledGame>(
      `select id, host, name, starts_at from games
        where status = 'scheduled' and starts_at <= to_timestamp(($1::bigint + $2::bigint + 60000) / 1000.0)
        order by starts_at, id`,
      [now, REMINDER_MS],
    );
    for (const game of res.rows) {
      if (stopped) return;
      const startsAt = game.starts_at.getTime();
      try {
        if (startsAt <= now) {
          await open(game);
        } else if (startsAt <= now + REMINDER_MS) {
          await remind(game);
        }
      } catch (err) {
        console.error(`scheduler: game ${game.id} failed`, err);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = deps.clock();
    try {
      await runTick(now);
    } catch (err) {
      console.error('scheduler: tick failed', err);
    }
    if (!stopped) handle = deps.setTimer(() => void tick(), TICK_MS);
  };

  handle = deps.setTimer(() => void tick(), 0);

  return () => {
    stopped = true;
    if (deps.clearTimer && handle !== null) deps.clearTimer(handle);
    handle = null;
  };
}
