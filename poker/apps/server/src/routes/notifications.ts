/**
 * In-app notifications (all routes require a signed-in user).
 *
 * GET  /api/notifications
 *   200 { unread: number,                    // count of ALL my unread notifications
 *         notifications: {                   // my latest 50, newest first
 *           id: string, kind: string, text: string, link: string | null,
 *           read: boolean, createdAt: string // ISO 8601
 *         }[] }
 *
 * POST /api/notifications/:id/read          // :id is a positive integer string
 *   200 { ok: true }
 *   400 { error }  bad id
 *   404 { error }  not found (or not mine)
 *
 * POST /api/notifications/read-all
 *   200 { ok: true }
 *
 * 401 { error: 'Not signed in' } when there is no session.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';

const LIST_LIMIT = 50;

// Up to 18 digits keeps the value inside Postgres bigint range.
const IdParams = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/, 'Invalid notification id') });

interface NotificationRow {
  id: string | number;
  kind: string;
  text: string;
  link: string | null;
  read: boolean;
  created_at: Date;
}

function userId(req: FastifyRequest): string {
  const id = req.user?.id;
  if (!id) throw Object.assign(new Error('Not signed in'), { statusCode: 401 });
  return id;
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/notifications', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const [list, count] = await Promise.all([
      pool.query<NotificationRow>(
        `select id, kind, text, link, read, created_at from notifications
         where user_id = $1 order by created_at desc, id desc limit $2`,
        [me, LIST_LIMIT],
      ),
      pool.query<{ n: number }>('select count(*)::int as n from notifications where user_id = $1 and not read', [me]),
    ]);
    return {
      unread: count.rows[0]?.n ?? 0,
      notifications: list.rows.map((r) => ({
        id: String(r.id),
        kind: r.kind,
        text: r.text,
        link: r.link,
        read: r.read,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  // Declared before '/:id/read'; the static segment wins in find-my-way regardless.
  app.post('/notifications/read-all', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    await pool.query('update notifications set read = true where user_id = $1 and not read', [me]);
    return { ok: true };
  });

  app.post('/notifications/:id/read', { preHandler: requireUser }, async (req, reply) => {
    const me = userId(req);
    const { id } = IdParams.parse(req.params);
    const res = await pool.query('update notifications set read = true where id = $1 and user_id = $2', [id, me]);
    if (res.rowCount === 0) return reply.code(404).send({ error: 'Notification not found' });
    return { ok: true };
  });
}
