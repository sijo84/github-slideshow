import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameSettingsInput } from '@poker/protocol';
import { buildApp } from '../src/app.js';
import type { TableManager } from '../src/realtime/tableManager.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';
import { buyIn, grant } from '../src/wallet/ledger.js';

type User = Awaited<ReturnType<typeof makeUser>>;
type Headers = Awaited<ReturnType<typeof authed>>;
type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
interface UserRef {
  id: string;
  displayName: string;
  avatarUrl: string;
}
interface Game {
  id: string;
  name: string;
  startsAt: string;
  status: string;
  settings: Record<string, unknown>;
  host: UserRef;
  invites: { user: UserRef; rsvp: Rsvp }[];
  myRsvp: Rsvp | null;
  isHost: boolean;
}
interface GameSummary {
  id: string;
  name: string;
  startsAt: string;
  status: string;
  kind: string;
  hostId: string;
  hostName: string;
  myRsvp: Rsvp | null;
  invitedCount: number;
}
interface Settlement {
  nets: { userId: string; name: string; net: number }[];
  transfers: { from: string; to: string; chips: number }[];
  text: string;
}

const NOW = Date.parse('2030-01-01T18:00:00.000Z');
const LATER = '2030-01-02T19:30:00.000Z';

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  app = await buildApp({ pool, config: testConfig(), clock: () => NOW });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

function cashSettings(overrides: Partial<GameSettingsInput> = {}): GameSettingsInput {
  return {
    kind: 'cash',
    maxSeats: 6,
    levels: [{ level: 1, smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none', durationMinutes: 60 }],
    minBuyIn: 200,
    maxBuyIn: 2000,
    startingStack: 1000,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    showAllInEquity: true,
    ...overrides,
  };
}

function tournamentSettings(): GameSettingsInput {
  return cashSettings({
    kind: 'tournament',
    levels: [
      { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, anteKind: 'none', durationMinutes: 10 },
      { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, anteKind: 'none', durationMinutes: 10 },
    ],
    rebuys: { allowed: true, untilLevel: 2 },
    payouts: [60, 40],
  });
}

async function userWithHeaders(name: string): Promise<{ user: User; h: Headers }> {
  const user = await makeUser(pool, name);
  return { user, h: await authed(app, user) };
}

async function befriend(a: string, b: string): Promise<void> {
  await pool.query(`insert into friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [a, b]);
}

async function createGame(h: Headers, payload: object, target: FastifyInstance = app): Promise<Game> {
  const res = await target.inject({ method: 'POST', url: '/api/games', headers: h, payload });
  expect(res.statusCode).toBe(201);
  return res.json<Game>();
}

/** A host, a friend who is invited and a stranger, plus a scheduled game. */
async function setup(settings: GameSettingsInput = cashSettings()): Promise<{
  host: User;
  hostH: Headers;
  guest: User;
  guestH: Headers;
  stranger: User;
  strangerH: Headers;
  game: Game;
}> {
  const { user: host, h: hostH } = await userWithHeaders('Hosty');
  const { user: guest, h: guestH } = await userWithHeaders('Guesty');
  const { user: stranger, h: strangerH } = await userWithHeaders('Strangy');
  await befriend(host.id, guest.id);
  const game = await createGame(hostH, { name: 'Friday Night', startsAt: LATER, settings });
  const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/invites`, headers: hostH, payload: { userIds: [guest.id] } });
  expect(res.statusCode).toBe(200);
  return { host, hostH, guest, guestH, stranger, strangerH, game };
}

async function storedSettings(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ settings: Record<string, unknown> }>('select settings from games where id = $1', [id]);
  return rows[0]!.settings;
}

async function status(id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>('select status from games where id = $1', [id]);
  return rows[0]!.status;
}

describe('POST /games', () => {
  it('creates a scheduled game with defaults applied', async () => {
    const { user, h } = await userWithHeaders('Creator');
    const game = await createGame(h, { name: '  Poker Night  ', startsAt: LATER, settings: cashSettings() });
    expect(game.name).toBe('Poker Night');
    expect(game.status).toBe('scheduled');
    expect(game.startsAt).toBe(LATER);
    expect(game.isHost).toBe(true);
    expect(game.myRsvp).toBeNull();
    expect(game.invites).toEqual([]);
    expect(game.host).toEqual({ id: user.id, displayName: 'Creator', avatarUrl: `/api/users/${user.id}/avatar.svg` });
    expect(game.settings).toMatchObject({ turnSeconds: 20, timeBankSeconds: 60, timeBankTopUpSeconds: 10, autoStart: true });
    expect(await storedSettings(game.id)).toMatchObject({ turnSeconds: 20, autoStart: true, kind: 'cash' });
  });

  it('accepts a start up to 5 minutes in the past', async () => {
    const { h } = await userWithHeaders('Creator');
    const startsAt = new Date(NOW - 4 * 60 * 1000).toISOString();
    await createGame(h, { name: 'Now-ish', startsAt, settings: cashSettings() });
  });

  it('rejects invalid settings, a past start and a bad name', async () => {
    const { h } = await userWithHeaders('Creator');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/games', headers: h, payload });

    const badPayouts = await post({ name: 'X', startsAt: LATER, settings: cashSettings({ payouts: [50, 40] }) });
    expect(badPayouts.statusCode).toBe(400);
    expect(badPayouts.json<{ error: string }>().error).toMatch(/payouts/);
    expect((await post({ name: 'X', startsAt: LATER, settings: cashSettings({ minBuyIn: 5000 }) })).statusCode).toBe(400);
    expect((await post({ name: 'X', startsAt: LATER, settings: { kind: 'cash' } })).statusCode).toBe(400);

    const past = await post({ name: 'X', startsAt: new Date(NOW - 6 * 60 * 1000).toISOString(), settings: cashSettings() });
    expect(past.statusCode).toBe(400);
    expect(past.json<{ error: string }>().error).toMatch(/past/);

    expect((await post({ name: '   ', startsAt: LATER, settings: cashSettings() })).statusCode).toBe(400);
    expect((await post({ name: 'x'.repeat(61), startsAt: LATER, settings: cashSettings() })).statusCode).toBe(400);
    expect((await post({ name: 'X', startsAt: 'tomorrow', settings: cashSettings() })).statusCode).toBe(400);
  });

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/games' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /games', () => {
  it('lists games for the host and the invitee, not for a stranger', async () => {
    const { host, hostH, guest, guestH, strangerH, game } = await setup();
    const list = async (h: Headers) => {
      const res = await app.inject({ method: 'GET', url: '/api/games', headers: h });
      expect(res.statusCode).toBe(200);
      return res.json<{ games: GameSummary[] }>().games;
    };

    const hostGames = await list(hostH);
    expect(hostGames).toEqual([
      {
        id: game.id,
        name: 'Friday Night',
        startsAt: LATER,
        status: 'scheduled',
        kind: 'cash',
        hostId: host.id,
        hostName: 'Hosty',
        myRsvp: null,
        invitedCount: 1,
      },
    ]);
    const guestGames = await list(guestH);
    expect(guestGames.map((g) => g.id)).toEqual([game.id]);
    expect(guestGames[0]!.myRsvp).toBe('pending');
    expect(await list(strangerH)).toEqual([]);

    // A newer game comes first; cancelled games are hidden.
    const later = await createGame(hostH, { name: 'Next week', startsAt: '2030-01-09T19:30:00.000Z', settings: cashSettings() });
    expect((await list(hostH)).map((g) => g.id)).toEqual([later.id, game.id]);
    await app.inject({ method: 'POST', url: `/api/games/${later.id}/cancel`, headers: hostH });
    expect((await list(hostH)).map((g) => g.id)).toEqual([game.id]);
    expect(guest.id).toBeTruthy();
  });
});

describe('GET /games/:id', () => {
  it('returns the game to the host and the invitee', async () => {
    const { guest, hostH, guestH, game } = await setup();
    const asHost = await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: hostH });
    expect(asHost.statusCode).toBe(200);
    const hostView = asHost.json<Game>();
    expect(hostView.isHost).toBe(true);
    expect(hostView.invites).toEqual([
      { user: { id: guest.id, displayName: 'Guesty', avatarUrl: `/api/users/${guest.id}/avatar.svg` }, rsvp: 'pending' },
    ]);

    const asGuest = await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: guestH });
    expect(asGuest.statusCode).toBe(200);
    expect(asGuest.json<Game>()).toMatchObject({ isHost: false, myRsvp: 'pending', name: 'Friday Night' });
  });

  it('non-invited user gets 403', async () => {
    const { strangerH, game } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: strangerH });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "You don't have access to this game" });
  });

  it('404 for an unknown game, 400 for a bad id', async () => {
    const { h } = await userWithHeaders('Someone');
    expect((await app.inject({ method: 'GET', url: `/api/games/${randomUUID()}`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/games/nope', headers: h })).statusCode).toBe(400);
  });
});

describe('POST /games/:id/invites', () => {
  it('invites friends only and notifies each new invitee once', async () => {
    const { host, hostH, guest, strangerH, stranger, game } = await setup();
    const { user: friend2 } = await userWithHeaders('Friendo');
    await befriend(friend2.id, host.id);
    const { user: pendingFriend } = await userWithHeaders('Pendo');
    await pool.query(`insert into friendships (requester, addressee, status) values ($1, $2, 'pending')`, [host.id, pendingFriend.id]);

    const invite = (h: Headers, userIds: string[]) =>
      app.inject({ method: 'POST', url: `/api/games/${game.id}/invites`, headers: h, payload: { userIds } });

    const notFriend = await invite(hostH, [friend2.id, stranger.id]);
    expect(notFriend.statusCode).toBe(400);
    expect(notFriend.json()).toEqual({ error: 'You can only invite friends' });
    expect((await invite(hostH, [pendingFriend.id])).statusCode).toBe(400);
    const { rows: none } = await pool.query('select 1 from game_invites where game_id = $1 and user_id = $2', [game.id, friend2.id]);
    expect(none).toHaveLength(0);

    // Re-inviting the guest is ignored; friend2 is added.
    const ok = await invite(hostH, [guest.id, friend2.id, friend2.id]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Game>().invites.map((i) => i.user.id).sort()).toEqual([friend2.id, guest.id].sort());
    expect((await invite(hostH, [friend2.id])).statusCode).toBe(200);

    const { rows } = await pool.query<{ user_id: string; kind: string; text: string; link: string }>(
      `select user_id, kind, text, link from notifications where kind = 'invite' and link = $1 order by user_id`,
      [`/games/${game.id}`],
    );
    expect(rows.filter((r) => r.user_id === guest.id)).toHaveLength(1);
    expect(rows.filter((r) => r.user_id === friend2.id)).toEqual([
      { user_id: friend2.id, kind: 'invite', text: 'Hosty invited you to Friday Night', link: `/games/${game.id}` },
    ]);

    // Only the host can invite.
    expect((await invite(strangerH, [stranger.id])).statusCode).toBe(403);
    expect((await invite(hostH, [])).statusCode).toBe(400);
  });
});

describe('POST /games/:id/rsvp', () => {
  it('lets the invitee answer; 403 for a stranger and the host', async () => {
    const { hostH, guestH, strangerH, game } = await setup();
    const rsvp = (h: Headers, value: string) =>
      app.inject({ method: 'POST', url: `/api/games/${game.id}/rsvp`, headers: h, payload: { rsvp: value } });

    const res = await rsvp(guestH, 'yes');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rsvp: 'yes' });
    const view = await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: guestH });
    expect(view.json<Game>().myRsvp).toBe('yes');
    expect((await rsvp(guestH, 'maybe')).json()).toEqual({ rsvp: 'maybe' });

    expect((await rsvp(strangerH, 'yes')).statusCode).toBe(403);
    expect((await rsvp(hostH, 'yes')).statusCode).toBe(403);
    expect((await rsvp(guestH, 'pending')).statusCode).toBe(400);
  });
});

describe('GET /games/:id/calendar.ics', () => {
  it('returns an iCalendar event to members', async () => {
    const { guestH, game } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}/calendar.ics`, headers: guestH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="poker-game.ics"');
    expect(res.body).toContain('BEGIN:VEVENT');
    expect(res.body).toContain('Friday Night');
    expect(res.body).toContain(`UID:${game.id}@poker`);
    expect(res.body).toContain('DTSTART:20300102T193000Z');
    expect(res.body).toContain('DURATION:PT3H');
    expect(res.body).toMatch(/play-money/);
  });

  it('non-invited user gets 403', async () => {
    const { strangerH, game } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/games/${game.id}/calendar.ics`, headers: strangerH });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /games/:id/settings', () => {
  it('merges and validates the host change', async () => {
    const { hostH, guestH, game } = await setup();
    const patch = (h: Headers, settings: object) =>
      app.inject({ method: 'PATCH', url: `/api/games/${game.id}/settings`, headers: h, payload: { settings } });

    const res = await patch(hostH, { turnSeconds: 30, maxSeats: 8 });
    expect(res.statusCode).toBe(200);
    expect(res.json<Game>().settings).toMatchObject({ turnSeconds: 30, maxSeats: 8, minBuyIn: 200, timeBankSeconds: 60 });
    expect(await storedSettings(game.id)).toMatchObject({ turnSeconds: 30, maxSeats: 8, minBuyIn: 200 });

    expect((await patch(guestH, { turnSeconds: 40 })).statusCode).toBe(403);
    // Valid alone, invalid once merged (minBuyIn > maxBuyIn).
    expect((await patch(hostH, { minBuyIn: 5000 })).statusCode).toBe(400);
    // Unknown key / bad type.
    expect((await patch(hostH, { bogus: 1 })).statusCode).toBe(400);
    expect((await patch(hostH, { turnSeconds: 'x' })).statusCode).toBe(400);
    expect(await storedSettings(game.id)).toMatchObject({ turnSeconds: 30, minBuyIn: 200 });
  });

  it('rejects kind/maxSeats changes once running, and any change when finished', async () => {
    const { hostH, game } = await setup();
    const patch = (settings: object) =>
      app.inject({ method: 'PATCH', url: `/api/games/${game.id}/settings`, headers: hostH, payload: { settings } });
    await pool.query(`update games set status = 'running' where id = $1`, [game.id]);
    expect((await patch({ maxSeats: 9 })).statusCode).toBe(400);
    expect((await patch({ maxSeats: 6, turnSeconds: 25 })).statusCode).toBe(200);
    await pool.query(`update games set status = 'finished' where id = $1`, [game.id]);
    expect((await patch({ turnSeconds: 30 })).statusCode).toBe(409);
  });
});

describe('with a table manager decorated', () => {
  it('sends live settings changes through the manager and opens via tables.open', async () => {
    const fake = {
      isOpen: vi.fn(() => true),
      host: vi.fn(async () => undefined),
      open: vi.fn(async (gameId: string) => {
        await pool.query(`update games set status = 'open' where id = $1`, [gameId]);
      }),
    };
    const app2 = await buildApp({ pool, config: testConfig(), clock: () => NOW });
    app2.decorate('tables', fake as unknown as TableManager);
    await app2.ready();
    try {
      const host = await makeUser(pool, 'Livehost');
      const h = await authed(app2, host);
      const game = await createGame(h, { name: 'Live', startsAt: LATER, settings: cashSettings() }, app2);
      const before = await storedSettings(game.id);

      const res = await app2.inject({
        method: 'PATCH',
        url: `/api/games/${game.id}/settings`,
        headers: h,
        payload: { settings: { turnSeconds: 45 } },
      });
      expect(res.statusCode).toBe(200);
      expect(fake.host).toHaveBeenCalledWith(game.id, host.id, { kind: 'updateSettings', settings: { turnSeconds: 45 } });
      expect(await storedSettings(game.id)).toEqual(before);

      const opened = await app2.inject({ method: 'POST', url: `/api/games/${game.id}/open`, headers: h });
      expect(opened.statusCode).toBe(200);
      expect(fake.open).toHaveBeenCalledWith(game.id);
      expect(opened.json<Game>().status).toBe('open');
    } finally {
      await app2.close();
    }
  });
});

describe('POST /games/:id/open and /cancel', () => {
  it('opens a scheduled game (host only)', async () => {
    const { hostH, guestH, game } = await setup();
    expect((await app.inject({ method: 'POST', url: `/api/games/${game.id}/open`, headers: guestH })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: `/api/games/${game.id}/open`, headers: hostH });
    expect(res.statusCode).toBe(200);
    expect(res.json<Game>().status).toBe('open');
    expect(await status(game.id)).toBe('open');
    expect((await app.inject({ method: 'POST', url: `/api/games/${game.id}/open`, headers: hostH })).statusCode).toBe(409);
  });

  it('cancels a scheduled or open game (host only)', async () => {
    const { hostH, guestH, game } = await setup();
    const cancel = (h: Headers) => app.inject({ method: 'POST', url: `/api/games/${game.id}/cancel`, headers: h });
    expect((await cancel(guestH)).statusCode).toBe(403);
    await app.inject({ method: 'POST', url: `/api/games/${game.id}/open`, headers: hostH });
    const res = await cancel(hostH);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await status(game.id)).toBe('cancelled');
    expect((await cancel(hostH)).statusCode).toBe(409);

    const { game: running, hostH: h2 } = await setup();
    await pool.query(`update games set status = 'running' where id = $1`, [running.id]);
    expect((await app.inject({ method: 'POST', url: `/api/games/${running.id}/cancel`, headers: h2 })).statusCode).toBe(409);
  });
});

describe('GET /games/:id/settlement', () => {
  async function insertHand(gameId: string, handNumber: number, nets: { userId: string; seat: number; net: number }[]): Promise<void> {
    const handId = randomUUID();
    await pool.query(
      `insert into hands (id, game_id, hand_number, record, started_at, ended_at) values ($1, $2, $3, '{}', now(), now())`,
      [handId, gameId, handNumber],
    );
    for (const n of nets) {
      await pool.query('insert into hand_players (hand_id, user_id, seat, net) values ($1, $2, $3, $4)', [handId, n.userId, n.seat, n.net]);
    }
  }

  function settlement(h: Headers, gameId: string) {
    return app.inject({ method: 'GET', url: `/api/games/${gameId}/settlement`, headers: h });
  }

  it('cash game: nets are the sums of hand nets (F2)', async () => {
    const { host, hostH, guest, guestH, game } = await setup();
    const { user: third } = await userWithHeaders('Thirdy');
    await befriend(host.id, third.id);
    await app.inject({ method: 'POST', url: `/api/games/${game.id}/invites`, headers: hostH, payload: { userIds: [third.id] } });

    await insertHand(game.id, 1, [
      { userId: host.id, seat: 0, net: 300 },
      { userId: guest.id, seat: 1, net: -100 },
      { userId: third.id, seat: 2, net: -200 },
    ]);
    await insertHand(game.id, 2, [
      { userId: host.id, seat: 0, net: -50 },
      { userId: guest.id, seat: 1, net: 50 },
    ]);
    await pool.query(`update games set status = 'finished' where id = $1`, [game.id]);

    const res = await settlement(guestH, game.id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Settlement>();
    const byId = Object.fromEntries(body.nets.map((n) => [n.userId, n]));
    expect(byId[host.id]).toEqual({ userId: host.id, name: 'Hosty', net: 250 });
    expect(byId[guest.id]!.net).toBe(-50);
    expect(byId[third.id]!.net).toBe(-200);
    expect(body.nets).toHaveLength(3);
    expect(body.transfers).toEqual([
      { from: third.id, to: host.id, chips: 200 },
      { from: guest.id, to: host.id, chips: 50 },
    ]);
    expect(body.text).toContain('Thirdy owes Hosty $200');
    expect(body.text).toContain('Guesty owes Hosty $50');
    expect(body.text).toContain('Play money only.');
  });

  it('tournament: net = prize − entries × startingStack, counting rebuys (F2)', async () => {
    const { host, hostH, guest, game } = await setup(tournamentSettings());
    const { user: third } = await userWithHeaders('Thirdy');
    await befriend(host.id, third.id);
    await app.inject({ method: 'POST', url: `/api/games/${game.id}/invites`, headers: hostH, payload: { userIds: [third.id] } });

    for (const u of [host, guest, third]) {
      await grant(pool, u.id, 10_000, 'test grant');
      await buyIn(pool, u.id, game.id, 1000);
    }
    await buyIn(pool, third.id, game.id, 1000); // rebuy: a second buy-in entry
    // Prize pool 4,000: 60% / 40%.
    await pool.query(
      `insert into tournament_results (game_id, user_id, place, prize) values ($1, $2, 1, 2400), ($1, $3, 2, 1600), ($1, $4, 3, 0)`,
      [game.id, guest.id, host.id, third.id],
    );

    const res = await settlement(hostH, game.id);
    expect(res.statusCode).toBe(200);
    const body = res.json<Settlement>();
    const nets = Object.fromEntries(body.nets.map((n) => [n.userId, n.net]));
    expect(nets).toEqual({ [guest.id]: 1400, [host.id]: 600, [third.id]: -2000 });
    expect(body.nets.reduce((a, n) => a + n.net, 0)).toBe(0);
    expect(body.transfers).toEqual([
      { from: third.id, to: guest.id, chips: 1400 },
      { from: third.id, to: host.id, chips: 600 },
    ]);
    expect(body.text).toContain('Thirdy owes Guesty $1,400');
    expect(body.text).toContain('Thirdy owes Hosty $600');
  });

  it('409 while the results are not final', async () => {
    const { host, hostH, guest, game } = await setup(tournamentSettings());
    for (const u of [host, guest]) {
      await grant(pool, u.id, 10_000, 'test grant');
      await buyIn(pool, u.id, game.id, 1000);
    }
    const res = await settlement(hostH, game.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Results are not final yet' });
  });

  it('an empty game settles to "Everyone is even."', async () => {
    const { hostH, game } = await setup();
    const res = await settlement(hostH, game.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<Settlement>()).toMatchObject({ nets: [], transfers: [] });
    expect(res.json<Settlement>().text).toContain('Everyone is even.');
  });

  it('non-invited user gets 403', async () => {
    const { strangerH, game } = await setup();
    expect((await settlement(strangerH, game.id)).statusCode).toBe(403);
  });
});
