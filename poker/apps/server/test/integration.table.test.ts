/**
 * End-to-end: bot players play real hands over Socket.IO against the real server
 * (createServer: real TableManager + sockets + PostgreSQL), per PLAN.md I-9 / S13.
 */
import type { AddressInfo } from 'node:net';
import {
  commit,
  dealPositions,
  deckFromSeeds,
  verifyCard,
  verifyDeck,
  type HandEvent,
  type SeatIndex,
} from '@poker/engine';
import { GameSettingsSchema, type GameSettingsInput, type HandEventMessage, type TableStatusMessage } from '@poker/protocol';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
import { testConfig, testDb } from '../src/test/helpers.js';
import { Bot, type BotHand } from './bots.js';

// applyHostCommand (S17) is still a stub in checkpoint 5; S8's own tests mock it the same way. This minimal
// stand-in only covers the commands these tests send (`end`, `start`). Remove once S17 lands.
vi.mock('../src/realtime/hostControls.js', () => ({
  applyHostCommand: (settings: unknown, status: string, cmd: { kind: string }) =>
    cmd.kind === 'end' || cmd.kind === 'start'
      ? { settings, status, effects: [cmd.kind] }
      : { error: `${cmd.kind} is not supported by the test stand-in` },
}));

type Server = Awaited<ReturnType<typeof createServer>>;

const BUY_IN = 1000;
const SIGNUP_CHIPS = 10_000;

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let server: Server;
let baseUrl = '';
let origin = '';
const bots: Bot[] = [];
let seedCounter = 1;

function settings(overrides: Partial<GameSettingsInput> = {}): GameSettingsInput {
  const s: GameSettingsInput = {
    kind: 'cash',
    maxSeats: 6,
    levels: [{ level: 1, smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none', durationMinutes: 60 }],
    minBuyIn: 200,
    maxBuyIn: 2000,
    startingStack: 1000,
    turnSeconds: 5,
    timeBankSeconds: 0,
    timeBankTopUpSeconds: 0,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    autoStart: true,
    showAllInEquity: true,
    ...overrides,
  };
  return GameSettingsSchema.parse(s);
}

async function createGame(host: Bot, invited: Bot[], overrides: Partial<GameSettingsInput> = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into games (host, name, settings, starts_at, status) values ($1, $2, $3, now(), 'open') returning id`,
    [host.id, 'Bot table', JSON.stringify(settings(overrides))],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('game insert returned no row');
  for (const b of invited) {
    await pool.query(`insert into game_invites (game_id, user_id, rsvp) values ($1, $2, 'yes')`, [id, b.id]);
  }
  return id;
}

async function newBot(name: string, opts: { idle?: boolean } = {}): Promise<Bot> {
  const bot = await new Bot({ baseUrl, origin, name, seed: seedCounter++ * 7919, idle: opts.idle }).start();
  bots.push(bot);
  return bot;
}

function isFinished(bot: Bot, gameId: string): boolean {
  return bot.received.some(
    (r) => r.name === 'table:status' && r.gameId === gameId && (r.payload as TableStatusMessage).status === 'finished',
  );
}

/** Seat -> index k into dealPositions(n).hole: dealt clockwise starting left of the button (engine startHand). */
function holeIndexBySeat(seats: SeatIndex[], buttonSeat: SeatIndex, maxSeats: number): Map<SeatIndex, number> {
  const dist = (s: SeatIndex): number => {
    const d = (((s - buttonSeat) % maxSeats) + maxSeats) % maxSeats;
    return d === 0 ? maxSeats : d;
  };
  const ordered = [...seats].sort((a, b) => dist(a) - dist(b));
  return new Map(ordered.map((s, k) => [s, k]));
}

function events(h: BotHand): HandEvent[] {
  return h.events.map((e) => e.event);
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  const config = testConfig({ authRateLimitMax: 1000 });
  server = await createServer({
    pool,
    config,
    tableOptions: { seedWaitMs: 2000, runoutPacingMs: 0, handDelayMs: 0, autoStartMs: 0 },
    scheduler: false,
  });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  origin = config.publicOrigin;
});

afterAll(async () => {
  for (const b of bots) b.disconnect();
  await server?.close();
  await db?.cleanup();
});

describe('integration: bots on the real table', () => {
  it('3 bots play 30 hands: privacy, card proofs, chips, fairness, identical public streams', { timeout: 120_000 }, async () => {
    const b1 = await newBot('Bot One');
    const b2 = await newBot('Bot Two');
    const b3 = await newBot('Bot Three');
    const players = [b1, b2, b3];
    for (const b of players) expect(await b.wallet()).toBe(SIGNUP_CHIPS);

    const gameId = await createGame(b1, [b2, b3]);
    for (const b of players) {
      const ack = await b.join(gameId);
      expect(ack.ok, JSON.stringify(ack)).toBe(true);
    }
    b1.sit(gameId, 0, BUY_IN);
    b2.sit(gameId, 2, BUY_IN);
    b3.sit(gameId, 4, BUY_IN);

    await b1.waitFor(() => b1.handsEnded(gameId) >= 30, 90_000, '30 handEnded');
    for (const b of players) b.autoResit = false;
    b1.host(gameId, { kind: 'end' });
    for (const b of players) await b.waitFor(() => isFinished(b, gameId), 20_000, 'table:status finished');

    // Every action the bots sent was valid, legal and for the current hand.
    const badCodes = new Set(['bad_request', 'rate_limited', 'illegal_action', 'not_your_turn', 'stale_hand', 'internal']);
    for (const b of players) {
      const errors = b.received.filter(
        (r) => r.name === 'error' && badCodes.has((r.payload as { code?: string }).code ?? ''),
      );
      expect(errors, `${b.name} errors`).toEqual([]);
    }

    const maxSeats = 6;
    for (const b of players) {
      const hands = b.handsOf(gameId);
      expect(hands.length).toBeGreaterThanOrEqual(30);
      for (const h of hands) {
        const started = h.started!;
        const ended = h.ended!;
        const n = started.seats.length;
        const pos = dealPositions(n);
        const kBySeat = holeIndexBySeat(
          started.seats.map((s) => s.seat),
          started.buttonSeat,
          maxSeats,
        );
        const mySeat = started.seats.find((s) => s.playerId === b.id)?.seat ?? null;
        const ctx = `${b.name} hand ${h.handNumber}`;

        // (a) hole cards of others only via showCards.
        let myHole: number[] = [];
        for (const ev of events(h)) {
          if (ev.type !== 'dealHole') continue;
          if (ev.seat === mySeat) {
            expect(ev.cards, ctx).toHaveLength(2);
            myHole = ev.cards;
          } else {
            expect(ev.cards, `${ctx} dealHole seat ${ev.seat}`).toEqual([]);
          }
        }
        if (mySeat !== null) expect(myHole, ctx).toHaveLength(2);

        // (b) card proofs: only entitled positions, and each verifies against cardCommitments.
        const ownPositions = new Set(mySeat === null ? [] : (pos.hole[kBySeat.get(mySeat)!] ?? []));
        const boardPositions = new Set(pos.board);
        const shownPositions = new Set<number>();
        for (const ev of events(h)) {
          if (ev.type === 'showCards') {
            for (const p of pos.hole[kBySeat.get(ev.seat)!] ?? []) shownPositions.add(p);
          }
          if (ev.type === 'cardProof') {
            const entitled = ownPositions.has(ev.position) || boardPositions.has(ev.position) || shownPositions.has(ev.position);
            expect(entitled, `${ctx}: cardProof for position ${ev.position}`).toBe(true);
            const c = started.cardCommitments[ev.position];
            expect(c, `${ctx}: commitment for position ${ev.position}`).toBeDefined();
            expect(verifyCard(c!, ev.salt, ev.position, ev.card), `${ctx}: verifyCard ${ev.position}`).toBe(true);
          }
        }

        // (d) fairness.
        expect(h.commitmentBeforeStart, `${ctx}: commitment before handStarted`).toBe(started.commitment);
        const { rows } = await pool.query<{ server_seed: string }>(
          `select s.server_seed from hand_seeds s join hands h on h.id = s.hand_id
            where h.game_id = $1 and h.hand_number = $2`,
          [gameId, h.handNumber],
        );
        const serverSeed = rows[0]?.server_seed;
        expect(serverSeed, `${ctx}: hand_seeds row`).toBeDefined();
        expect(commit(serverSeed!)).toBe(started.commitment);
        const deck = deckFromSeeds(serverSeed!, ended.clientSeeds, h.handNumber);
        expect(verifyDeck(started.commitment, serverSeed!, ended.clientSeeds, h.handNumber, deck), ctx).toBe(true);
        if (mySeat !== null) {
          // The seed answering this hand's commitment, or (right after a sit) the seed sent with table:sit.
          const mine = [h.clientSeed, ...h.sitSeeds].filter((x): x is string => x !== null);
          expect(
            mine.some((x) => ended.clientSeeds.includes(x)),
            `${ctx}: own client seed used (${mine.join(',')} in ${ended.clientSeeds.join(',')}; ` +
              `commitments ${h.commitmentsReceived}, seed sent ${(h.seedEmittedAt ?? 0) - (h.startedAt ?? 0)} ms rel. handStarted; ` +
              `seats ${JSON.stringify(started.seats)})`,
          ).toBe(true);
          const myPositions = pos.hole[kBySeat.get(mySeat)!] ?? [];
          expect(myHole, `${ctx}: hole = deck at dealPositions`).toEqual(myPositions.map((p) => deck[p]));
        }
      }
    }

    // (e) identical public event sequences (types in order, ignoring cardProof).
    const seq = (b: Bot): Map<number, string> =>
      new Map(
        b.handsOf(gameId).map((h) => [
          h.handNumber,
          events(h)
            .filter((e) => e.type !== 'cardProof')
            .map((e) => e.type)
            .join(','),
        ]),
      );
    const s1 = seq(b1);
    for (const b of [b2, b3]) {
      const s = seq(b);
      expect([...s.keys()]).toEqual([...s1.keys()]);
      for (const [n, types] of s1) expect(s.get(n), `${b.name} hand ${n}`).toBe(types);
    }

    // (c) chips: everything cashed out, nothing created or lost.
    const wallets = await Promise.all(players.map((b) => b.wallet()));
    expect(wallets.reduce((a, x) => a + x, 0)).toBe(3 * SIGNUP_CHIPS);
    const sum = await pool.query<{ total: string | number | null }>('select sum(amount) as total from ledger_entries');
    expect(Number(sum.rows[0]?.total ?? 0)).toBe(0);
    const tables = await pool.query<{ total: string | number | null }>(
      `select coalesce(sum(e.amount), 0) as total from ledger_entries e join ledger_accounts a on a.id = e.account_id
        where a.kind = 'table' and a.game_id = $1`,
      [gameId],
    );
    expect(Number(tables.rows[0]?.total ?? 0)).toBe(0);
  });

  it('an idle bot is timed out (check if legal, else fold) after turnSeconds', { timeout: 60_000 }, async () => {
    const active = await newBot('Active Bot');
    const idle = await newBot('Idle Bot', { idle: true });
    const gameId = await createGame(active, [idle], { turnSeconds: 1, timeBankSeconds: 0 });
    for (const b of [active, idle]) expect((await b.join(gameId)).ok).toBe(true);
    active.sit(gameId, 0, BUY_IN);
    idle.sit(gameId, 1, BUY_IN);

    // At least 2 hands, and at least 2 idle turns (the active bot may end a hand before the idle bot acts).
    const idleTurns = (): number =>
      idle.received.filter((r) => {
        if (r.name !== 'hand:event' || r.gameId !== gameId) return false;
        const ev = (r.payload as HandEventMessage).event;
        return ev.type === 'action' && ev.auto === 'timeout';
      }).length;
    await idle.waitFor(() => idle.handsEnded(gameId) >= 2 && idleTurns() >= 2, 45_000, '2 hands with 2 idle timeouts');
    active.autoResit = false;
    idle.autoResit = false;
    active.host(gameId, { kind: 'end' });
    await active.waitFor(() => isFinished(active, gameId), 20_000, 'table:status finished');

    expect(idle.sent).toEqual([]);
    let timeouts = 0;
    for (const h of idle.handsOf(gameId)) {
      const idleSeat = h.started!.seats.find((s) => s.playerId === idle.id)?.seat;
      expect(idleSeat).toBeDefined();
      let pending: { at: number; canCheck: boolean } | null = null;
      for (const { event: ev, at } of h.events) {
        if (ev.type === 'toAct' && ev.seat === idleSeat) pending = { at, canCheck: ev.legal.canCheck };
        if (ev.type === 'action' && ev.seat === idleSeat) {
          expect(pending, `hand ${h.handNumber}: action without toAct`).not.toBeNull();
          expect(ev.auto).toBe('timeout');
          expect(ev.kind).toBe(pending!.canCheck ? 'check' : 'fold');
          const waited = at - pending!.at;
          expect(waited, `hand ${h.handNumber}: timeout after ${waited} ms`).toBeGreaterThanOrEqual(800);
          expect(waited, `hand ${h.handNumber}: timeout after ${waited} ms`).toBeLessThanOrEqual(3000);
          pending = null;
          timeouts++;
        }
      }
    }
    expect(timeouts).toBeGreaterThanOrEqual(2);
  });

  it('a user who is not invited cannot join and receives nothing from the game', { timeout: 60_000 }, async () => {
    const host = await newBot('Host Bot');
    const guest = await newBot('Guest Bot');
    const outsider = await newBot('Outsider');
    const gameId = await createGame(host, [guest]);
    for (const b of [host, guest]) expect((await b.join(gameId)).ok).toBe(true);
    host.sit(gameId, 0, BUY_IN);
    guest.sit(gameId, 1, BUY_IN);
    await host.waitFor(() => host.handsEnded(gameId) >= 1, 20_000, '1 handEnded');

    const ack = await outsider.join(gameId);
    expect(ack).toEqual({ ok: false, error: 'forbidden' });
    outsider.sit(gameId, 3, BUY_IN);

    await host.waitFor(() => host.handsEnded(gameId) >= 3, 20_000, '3 handEnded');
    host.autoResit = false;
    guest.autoResit = false;
    host.host(gameId, { kind: 'end' });
    await host.waitFor(() => isFinished(host, gameId), 20_000, 'table:status finished');

    const leaked = outsider.received.filter((r) => r.gameId === gameId);
    expect(leaked.map((r) => r.name)).toEqual([]);
    const handEvents = outsider.received.filter(
      (r) => r.name === 'hand:event' && (r.payload as HandEventMessage).gameId === gameId,
    );
    expect(handEvents).toEqual([]);
    // The sit attempt is refused too.
    expect(outsider.received.some((r) => r.name === 'error')).toBe(true);
    expect(await outsider.wallet()).toBe(SIGNUP_CHIPS);
  });
});
