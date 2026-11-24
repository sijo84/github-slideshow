/**
 * Game routes (all require a signed-in user; mounted under /api).
 * A "member" of a game is its host or a user with a game_invites row.
 *
 * type UserRef     = { id: string; displayName: string; avatarUrl: string }
 * type Rsvp        = 'pending' | 'yes' | 'no' | 'maybe'
 * type GameStatus  = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled'
 * type Game        = { id: string; name: string; startsAt: string (ISO); status: GameStatus;
 *                      settings: GameSettings; host: UserRef; invites: { user: UserRef; rsvp: Rsvp }[];
 *                      myRsvp: Rsvp | null; isHost: boolean }
 *                    (invites sorted by display name; myRsvp is null when I am not invited)
 * type GameSummary = { id: string; name: string; startsAt: string; status: GameStatus; kind: 'cash' | 'tournament';
 *                      hostId: string; hostName: string; myRsvp: Rsvp | null; invitedCount: number }
 *
 * POST  /api/games                 body { name: string (1–60 trimmed), startsAt: ISO date-time, settings: GameSettingsInput }
 *   201 Game                       settings stored with defaults applied; startsAt must be ≥ now − 5 min (400 otherwise)
 * GET   /api/games
 *   200 { games: GameSummary[] }   games I host or am invited to, not cancelled, newest startsAt first
 * GET   /api/games/:id
 *   200 Game                       403 if not a member, 404 if unknown
 * PATCH /api/games/:id/settings    body { settings: Partial<GameSettings> }   (host only)
 *   200 Game                       merged over the stored settings and validated (400 on failure);
 *                                  kind/maxSeats cannot change once the game is past 'open' (400);
 *                                  409 when finished or cancelled. When the table is live the change goes
 *                                  through the table manager (applied at the next hand).
 * POST  /api/games/:id/invites     body { userIds: uuid[] (1–20) }   (host only)
 *   200 Game                       400 { error: 'You can only invite friends' } if any user is not an accepted
 *                                  friend of the host; newly invited users get an 'invite' notification
 * POST  /api/games/:id/rsvp        body { rsvp: 'yes' | 'no' | 'maybe' }   (invited users only; 403 otherwise)
 *   200 { rsvp }
 * GET   /api/games/:id/calendar.ics   (members)
 *   200 text/calendar attachment "poker-game.ics" (3-hour event starting at startsAt, UTC)
 * POST  /api/games/:id/open        (host only)
 *   200 Game                       409 unless status is 'scheduled'
 * POST  /api/games/:id/cancel      (host only)
 *   200 { ok: true }               409 unless status is 'scheduled' or 'open'
 * GET   /api/games/:id/settlement  (members)
 *   200 { nets: { userId: string; name: string; net: number }[]; transfers: { from: string; to: string; chips: number }[]; text: string }
 *                                  cash: net = sum of hand nets; tournament: net = prize − buy-in entries × startingStack.
 *                                  409 { error: 'Results are not final yet' } when the nets do not sum to 0.
 *
 * Any :id that is not a UUID → 400. Not signed in → 401. Every error body is { error: string }.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createEvent } from 'ics';
import { z } from 'zod';
import { settle, settlementText } from '@poker/engine';
import { GameSettingsSchema, PartialGameSettingsSchema, type GameSettings } from '@poker/protocol';
import { requireUser, type SessionUser } from '../auth/session.js';
import { notify } from '../notify.js';
import { avatarUrlFor } from '../storage/avatars.js';
import { areFriends } from './friends.js';

type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
type GameStatus = 'scheduled' | 'open' | 'running' | 'paused' | 'finished' | 'cancelled';

interface UserRef {
  id: string;
  displayName: string;
  avatarUrl: string;
}

interface Game {
  id: string;
  name: string;
  startsAt: string;
  status: GameStatus;
  settings: GameSettings;
  host: UserRef;
  invites: { user: UserRef; rsvp: Rsvp }[];
  myRsvp: Rsvp | null;
  isHost: boolean;
}

interface GameRow {
  id: string;
  name: string;
  starts_at: Date;
  status: GameStatus;
  settings: GameSettings;
  host: string;
  host_name: string;
  host_avatar: string | null;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const IdParams = z.object({ id: z.uuid() });
const CreateBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  startsAt: z.iso.datetime({ offset: true }),
  settings: z.unknown(),
});
const PatchBody = z.strictObject({ settings: z.unknown() });
const InviteBody = z.strictObject({ userIds: z.array(z.uuid()).min(1).max(20) });
const RsvpBody = z.strictObject({ rsvp: z.enum(['yes', 'no', 'maybe']) });

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user;
}

export default async function (app: FastifyInstance): Promise<void> {
  const pool = app.deps.pool;

  async function loadRow(id: string): Promise<GameRow> {
    const { rows } = await pool.query<GameRow>(
      `select g.id, g.name, g.starts_at, g.status, g.settings, g.host,
              u.display_name as host_name, u.avatar_path as host_avatar
         from games g join users u on u.id = g.host
        where g.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Game not found');
    return row;
  }

  async function inviteRsvp(gameId: string, userId: string): Promise<Rsvp | null> {
    const { rows } = await pool.query<{ rsvp: Rsvp }>(
      'select rsvp from game_invites where game_id = $1 and user_id = $2',
      [gameId, userId],
    );
    return rows[0]?.rsvp ?? null;
  }

  /** Loads the game and checks that `userId` is a member; 404 / 403 otherwise. */
  async function loadForMember(id: string, userId: string): Promise<{ row: GameRow; isHost: boolean; myRsvp: Rsvp | null }> {
    const row = await loadRow(id);
    const isHost = row.host === userId;
    const myRsvp = await inviteRsvp(id, userId);
    const invited = myRsvp !== null;
    if (!isHost && !invited) throw new HttpError(403, "You don't have access to this game");
    return { row, isHost, myRsvp };
  }

  /** Loads the game and checks that `userId` is its host; 404 / 403 otherwise. */
  async function loadForHost(id: string, userId: string): Promise<GameRow> {
    const row = await loadRow(id);
    if (row.host !== userId) throw new HttpError(403, 'Only the host can do that');
    return row;
  }

  async function gameView(id: string, userId: string): Promise<Game> {
    const row = await loadRow(id);
    const { rows: invites } = await pool.query<{ user_id: string; display_name: string; avatar_path: string | null; rsvp: Rsvp }>(
      `select i.user_id, u.display_name, u.avatar_path, i.rsvp
         from game_invites i join users u on u.id = i.user_id
        where i.game_id = $1
        order by u.display_name, i.user_id`,
      [id],
    );
    const mine = invites.find((i) => i.user_id === userId);
    return {
      id: row.id,
      name: row.name,
      startsAt: row.starts_at.toISOString(),
      status: row.status,
      settings: row.settings,
      host: { id: row.host, displayName: row.host_name, avatarUrl: avatarUrlFor({ id: row.host, avatar_path: row.host_avatar }) },
      invites: invites.map((i) => ({
        user: { id: i.user_id, displayName: i.display_name, avatarUrl: avatarUrlFor({ id: i.user_id, avatar_path: i.avatar_path }) },
        rsvp: i.rsvp,
      })),
      myRsvp: mine?.rsvp ?? null,
      isHost: row.host === userId,
    };
  }

  function liveTables(): FastifyInstance['tables'] | null {
    if (!app.hasDecorator('tables')) return null;
    const tables = app.tables as FastifyInstance['tables'] | undefined;
    return tables ?? null;
  }

  app.post('/games', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const body = CreateBody.parse(req.body);
    const settings = GameSettingsSchema.parse(body.settings);
    const startsAt = new Date(body.startsAt);
    if (startsAt.getTime() < app.deps.clock() - FIVE_MINUTES_MS) {
      return reply.code(400).send({ error: 'The start time is in the past' });
    }
    const { rows } = await pool.query<{ id: string }>(
      `insert into games (host, name, settings, starts_at, status) values ($1, $2, $3, $4, 'scheduled') returning id`,
      [me, body.name, JSON.stringify(settings), startsAt],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert into games returned no row');
    return reply.code(201).send(await gameView(id, me));
  });

  app.get('/games', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { rows } = await pool.query<{
      id: string;
      name: string;
      starts_at: Date;
      status: GameStatus;
      kind: 'cash' | 'tournament';
      host: string;
      host_name: string;
      my_rsvp: Rsvp | null;
      invited_count: number;
    }>(
      `select g.id, g.name, g.starts_at, g.status, g.settings->>'kind' as kind, g.host, u.display_name as host_name,
              (select i.rsvp from game_invites i where i.game_id = g.id and i.user_id = $1) as my_rsvp,
              (select count(*)::int from game_invites i where i.game_id = g.id) as invited_count
         from games g join users u on u.id = g.host
        where g.status <> 'cancelled'
          and (g.host = $1 or exists (select 1 from game_invites i where i.game_id = g.id and i.user_id = $1))
        order by g.starts_at desc, g.id`,
      [me],
    );
    return {
      games: rows.map((r) => ({
        id: r.id,
        name: r.name,
        startsAt: r.starts_at.toISOString(),
        status: r.status,
        kind: r.kind,
        hostId: r.host,
        hostName: r.host_name,
        myRsvp: r.my_rsvp,
        invitedCount: r.invited_count,
      })),
    };
  });

  app.get('/games/:id', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const row = await loadRow(id);
    const isHost = row.host === me;
    const invited = (await inviteRsvp(id, me)) !== null;
    if (!isHost && !invited) return reply.code(403).send({ error: "You don't have access to this game" });
    return gameView(id, me);
  });

  app.patch('/games/:id/settings', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);
    const row = await loadForHost(id, me);
    if (row.status === 'finished' || row.status === 'cancelled') {
      throw new HttpError(409, 'This game is over');
    }
    const partial = PartialGameSettingsSchema.parse(body.settings);
    GameSettingsSchema.parse({ ...row.settings, ...partial });
    if (row.status !== 'scheduled' && row.status !== 'open') {
      if (
        (partial.kind !== undefined && partial.kind !== row.settings.kind) ||
        (partial.maxSeats !== undefined && partial.maxSeats !== row.settings.maxSeats)
      ) {
        throw new HttpError(400, 'Game type and seat count cannot change after the game has started');
      }
    }
    const tables = liveTables();
    if (tables?.isOpen(id)) {
      // The table manager stores the change and writes games.settings itself.
      await tables.host(id, me, { kind: 'updateSettings', settings: partial });
    } else {
      const merged = GameSettingsSchema.parse({ ...row.settings, ...partial });
      await pool.query('update games set settings = $2 where id = $1', [id, JSON.stringify(merged)]);
    }
    return gameView(id, me);
  });

  app.post('/games/:id/invites', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req);
    const { id } = IdParams.parse(req.params);
    const body = InviteBody.parse(req.body);
    const row = await loadForHost(id, me.id);
    const userIds = [...new Set(body.userIds)];
    for (const userId of userIds) {
      if (!(await areFriends(pool, me.id, userId))) throw new HttpError(400, 'You can only invite friends');
    }
    const { rows } = await pool.query<{ user_id: string }>(
      `insert into game_invites (game_id, user_id)
       select $1, u from unnest($2::uuid[]) as u
       on conflict do nothing
       returning user_id`,
      [id, userIds],
    );
    for (const r of rows) {
      await notify(pool, r.user_id, 'invite', `${row.host_name} invited you to ${row.name}`, `/games/${id}`);
    }
    return gameView(id, me.id);
  });

  app.post('/games/:id/rsvp', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const { rsvp } = RsvpBody.parse(req.body);
    await loadRow(id);
    const { rowCount } = await pool.query('update game_invites set rsvp = $3 where game_id = $1 and user_id = $2', [id, me, rsvp]);
    if (rowCount === 0) throw new HttpError(403, 'Only invited players can RSVP');
    return { rsvp };
  });

  app.get('/games/:id/calendar.ics', { preHandler: requireUser }, async (req, reply) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const { row } = await loadForMember(id, me);
    const { error, value } = createEvent({
      title: row.name,
      start: row.starts_at.getTime(),
      startInputType: 'utc',
      startOutputType: 'utc',
      duration: { hours: 3 },
      description: `${row.name}: a play-money poker home game hosted by ${row.host_name}.`,
      uid: `${row.id}@poker`,
    });
    if (error || value === undefined) throw error ?? new Error('could not build the calendar event');
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'attachment; filename="poker-game.ics"')
      .send(value);
  });

  app.post('/games/:id/open', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const row = await loadForHost(id, me);
    if (row.status !== 'scheduled') throw new HttpError(409, 'Only a scheduled game can be opened');
    const tables = liveTables();
    if (tables) {
      await tables.open(id);
    } else {
      await pool.query(`update games set status = 'open' where id = $1 and status = 'scheduled'`, [id]);
    }
    return gameView(id, me);
  });

  app.post('/games/:id/cancel', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    await loadForHost(id, me);
    const { rowCount } = await pool.query(
      `update games set status = 'cancelled' where id = $1 and status in ('scheduled', 'open')`,
      [id],
    );
    if (rowCount === 0) throw new HttpError(409, 'Only a scheduled or open game can be cancelled');
    return { ok: true };
  });

  app.get('/games/:id/settlement', { preHandler: requireUser }, async (req) => {
    const me = currentUser(req).id;
    const { id } = IdParams.parse(req.params);
    const { row } = await loadForMember(id, me);
    const { rows } = await pool.query<{ user_id: string; name: string; hand_net: number; hands: number; entries: number; prize: number }>(
      `with hand_nets as (
         select hp.user_id, sum(hp.net)::bigint as hand_net, count(*)::int as hands
           from hand_players hp join hands h on h.id = hp.hand_id
          where h.game_id = $1
          group by hp.user_id
       ), entries as (
         select a.user_id, count(*)::int as entries
           from ledger_entries e join ledger_accounts a on a.id = e.account_id
          where a.kind = 'table' and a.game_id = $1 and e.reason = 'buy-in' and e.amount > 0
          group by a.user_id
       ), players as (
         select user_id from hand_nets union select user_id from entries
       )
       select p.user_id, u.display_name as name,
              coalesce(hn.hand_net, 0) as hand_net, coalesce(hn.hands, 0) as hands,
              coalesce(en.entries, 0) as entries, coalesce(tr.prize, 0) as prize
         from players p
         join users u on u.id = p.user_id
         left join hand_nets hn on hn.user_id = p.user_id
         left join entries en on en.user_id = p.user_id
         left join tournament_results tr on tr.game_id = $1 and tr.user_id = p.user_id
        order by u.display_name, p.user_id`,
      [id],
    );
    const tournament = row.settings.kind === 'tournament';
    const nets = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      net: tournament ? Number(r.prize) - Number(r.entries) * row.settings.startingStack : Number(r.hand_net),
    }));
    const sum = nets.reduce((acc, n) => acc + n.net, 0);
    if (sum !== 0) throw new HttpError(409, 'Results are not final yet');
    const { transfers } = settle(nets.map((n) => ({ playerId: n.userId, chips: n.net })));
    const names: Record<string, string> = {};
    for (const n of nets) names[n.userId] = n.name;
    return { nets, transfers, text: settlementText(transfers, names) };
  });
}
