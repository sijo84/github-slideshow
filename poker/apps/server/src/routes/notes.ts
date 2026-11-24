import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/session.js';

/*
 * Private player notes. A note is only ever visible to its author.
 *
 * Note = { subjectId: string, text: string, color: 'red'|'orange'|'yellow'|'green'|'blue'|'purple' | null,
 *          updatedAt: string (ISO 8601) | null }
 *
 * GET    /api/notes             → { notes: Note[] }   my notes, newest first
 * GET    /api/notes/:subjectId  → Note                my note on that user, or the empty note
 *                                                      { subjectId, text: '', color: null, updatedAt: null };
 *                                                      404 if the user does not exist
 * PUT    /api/notes/:subjectId  { text: string (≤ 2000), color: Color | null }
 *                               → Note                upsert; 400 on yourself, 404 if the user does not exist
 * DELETE /api/notes/:subjectId  → { ok: true }        also when there was no note
 *
 * All routes need a session (401 { error } otherwise); errors are { error: string }.
 */

export const NOTE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface Note {
  subjectId: string;
  text: string;
  color: NoteColor | null;
  updatedAt: string | null;
}

interface NoteRow {
  subject: string;
  text: string;
  color: NoteColor | null;
  updated_at: Date;
}

const paramsSchema = z.object({ subjectId: z.uuid() });
const bodySchema = z.object({
  text: z.string().max(2000, 'Note is too long (max 2000 characters)'),
  color: z.enum(NOTE_COLORS).nullable(),
});

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function userId(req: FastifyRequest): string {
  if (!req.user) throw httpError(401, 'Not signed in');
  return req.user.id;
}

function toNote(row: NoteRow): Note {
  return { subjectId: row.subject, text: row.text, color: row.color, updatedAt: row.updated_at.toISOString() };
}

function emptyNote(subjectId: string): Note {
  return { subjectId, text: '', color: null, updatedAt: null };
}

async function assertUserExists(pool: Pool, id: string): Promise<void> {
  const { rowCount } = await pool.query('select 1 from users where id = $1', [id]);
  if (!rowCount) throw httpError(404, 'User not found');
}

export default async function (app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;

  app.get('/notes', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { rows } = await pool.query<NoteRow>(
      'select subject, text, color, updated_at from notes where author = $1 order by updated_at desc, subject',
      [me],
    );
    return { notes: rows.map(toNote) };
  });

  app.get('/notes/:subjectId', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { subjectId } = paramsSchema.parse(req.params);
    await assertUserExists(pool, subjectId);
    const { rows } = await pool.query<NoteRow>(
      'select subject, text, color, updated_at from notes where author = $1 and subject = $2',
      [me, subjectId],
    );
    const row = rows[0];
    return row ? toNote(row) : emptyNote(subjectId);
  });

  app.put('/notes/:subjectId', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { subjectId } = paramsSchema.parse(req.params);
    const { text, color } = bodySchema.parse(req.body);
    if (subjectId === me) throw httpError(400, 'You cannot write a note on yourself');
    await assertUserExists(pool, subjectId);
    const { rows } = await pool.query<NoteRow>(
      `insert into notes (author, subject, text, color, updated_at) values ($1, $2, $3, $4, now())
       on conflict (author, subject) do update set text = excluded.text, color = excluded.color, updated_at = now()
         where notes.author = $1
       returning subject, text, color, updated_at`,
      [me, subjectId, text, color],
    );
    const row = rows[0];
    if (!row) throw new Error('note upsert returned no row');
    return toNote(row);
  });

  app.delete('/notes/:subjectId', { preHandler: requireUser }, async (req) => {
    const me = userId(req);
    const { subjectId } = paramsSchema.parse(req.params);
    await pool.query('delete from notes where author = $1 and subject = $2', [me, subjectId]);
    return { ok: true };
  });
}
