/**
 * Profile + avatar routes (all under /api).
 *
 * GET    /users/:id             (signed in)  → 200 { id: string, displayName: string, avatarUrl: string }
 *                                              400 bad uuid, 404 unknown user
 * GET    /users/:id/avatar.svg  (public)     → 200 image/svg+xml, initials on a colour circle; 404 unknown user
 * PATCH  /profile { displayName }            → 200 { id, displayName, avatarUrl }; 400 unless 2–24 chars after trimming
 * POST   /profile/avatar  multipart, file field `avatar` (PNG, JPEG or WebP, ≤ 1 MB)
 *                                            → 200 { avatarUrl: string }
 *                                              400 { error } no file / not an image, 413 { error } too large
 * DELETE /profile/avatar                     → 200 { avatarUrl: string } (the generated SVG URL)
 *
 * avatarUrl is `/avatars/<file>` for an uploaded avatar, else `/api/users/<id>/avatar.svg`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';
import { avatarUrlFor, deleteAvatar, initialsSvg, saveAvatar, sniffImageType } from '../storage/avatars.js';

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const TOO_LARGE = 'Avatar must be 1 MB or smaller';
const NOT_IMAGE = 'Avatar must be a PNG, JPEG or WebP image';

const IdParams = z.object({ id: z.uuid() });
const PatchBody = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, 'Display name must be 2 to 24 characters')
    .max(24, 'Display name must be 2 to 24 characters'),
});

interface UserRow {
  id: string;
  display_name: string;
  avatar_path: string | null;
}

function userId(req: FastifyRequest): string {
  if (!req.user) throw Object.assign(new Error('Not signed in'), { statusCode: 401 });
  return req.user.id;
}

function publicProfile(row: UserRow): { id: string; displayName: string; avatarUrl: string } {
  return { id: row.id, displayName: row.display_name, avatarUrl: avatarUrlFor(row) };
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool, config } = app.deps;

  async function findUser(id: string): Promise<UserRow | undefined> {
    const { rows } = await pool.query<UserRow>('select id, display_name, avatar_path from users where id = $1', [id]);
    return rows[0];
  }

  app.get('/users/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const row = await findUser(id);
    if (!row) return reply.code(404).send({ error: 'User not found' });
    return publicProfile(row);
  });

  app.get('/users/:id/avatar.svg', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const row = await findUser(id);
    if (!row) return reply.code(404).send({ error: 'User not found' });
    return reply
      .type('image/svg+xml')
      .header('cache-control', 'public, max-age=3600')
      .header('content-security-policy', SVG_CSP)
      .send(initialsSvg(row.display_name, row.id));
  });

  app.patch('/profile', { preHandler: requireUser }, async (req, reply) => {
    const { displayName } = PatchBody.parse(req.body);
    const { rows } = await pool.query<UserRow>(
      'update users set display_name = $2 where id = $1 returning id, display_name, avatar_path',
      [userId(req), displayName],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'User not found' });
    return publicProfile(row);
  });

  app.post('/profile/avatar', { preHandler: requireUser }, async (req, reply) => {
    const id = userId(req);
    let buf: Buffer;
    try {
      const file = await req.file();
      if (!file || file.fieldname !== 'avatar') {
        file?.file.resume();
        return reply.code(400).send({ error: 'Missing avatar file' });
      }
      buf = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: TOO_LARGE });
    } catch (err) {
      const code = errCode(err);
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: TOO_LARGE });
      if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return reply.code(400).send({ error: 'Missing avatar file' });
      throw err;
    }

    const ext = sniffImageType(buf);
    if (!ext) return reply.code(400).send({ error: NOT_IMAGE });

    const fileName = await saveAvatar(config.avatarDir, id, buf, ext);
    let previous: string | null;
    try {
      const { rows } = await pool.query<{ old: string | null }>(
        `update users u set avatar_path = $2 from (select avatar_path as old from users where id = $1 for update) o
          where u.id = $1 returning o.old`,
        [id, fileName],
      );
      if (!rows[0]) {
        await deleteAvatar(config.avatarDir, fileName);
        return reply.code(404).send({ error: 'User not found' });
      }
      previous = rows[0].old;
    } catch (err) {
      await deleteAvatar(config.avatarDir, fileName);
      throw err;
    }
    if (previous) {
      await deleteAvatar(config.avatarDir, previous).catch((err: unknown) => req.log.warn({ err }, 'old avatar not removed'));
    }
    return { avatarUrl: avatarUrlFor({ id, avatar_path: fileName }) };
  });

  app.delete('/profile/avatar', { preHandler: requireUser }, async (req, reply) => {
    const id = userId(req);
    const { rows } = await pool.query<{ old: string | null }>(
      `update users u set avatar_path = null from (select avatar_path as old from users where id = $1 for update) o
        where u.id = $1 returning o.old`,
      [id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'User not found' });
    const previous = rows[0].old;
    if (previous) {
      await deleteAvatar(config.avatarDir, previous).catch((err: unknown) => req.log.warn({ err }, 'old avatar not removed'));
    }
    return { avatarUrl: avatarUrlFor({ id, avatar_path: null }) };
  });
}
