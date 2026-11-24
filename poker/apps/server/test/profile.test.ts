import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { deleteAvatar, initialsSvg, sniffImageType } from '../src/storage/avatars.js';
import { authed, makeUser, testConfig, testDb } from '../src/test/helpers.js';

const AVATAR_CSP = "default-src 'none'; img-src 'self'; sandbox";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const BOUNDARY = '----pokerTestBoundary7MA4YWxk';

let db: Awaited<ReturnType<typeof testDb>>;
let pool: Pool;
let config: Config;
let app: FastifyInstance;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 1x1 PNG: signature + IHDR + IDAT + IEND. */
function tinyPng(): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

function multipart(fieldName: string, fileName: string, contentType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function onlyTextField(): Buffer {
  return Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`);
}

async function upload(user: { id: string }, body: Buffer, headers?: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/api/profile/avatar',
    headers: headers ?? { ...(await authed(app, user)), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: body,
  });
}

async function avatarPathOf(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ avatar_path: string | null }>('select avatar_path from users where id = $1', [id]);
  return rows[0]?.avatar_path ?? null;
}

function filesFor(id: string): string[] {
  return readdirSync(config.avatarDir).filter((f) => f.startsWith(id));
}

beforeAll(async () => {
  db = await testDb();
  pool = db.pool;
  config = testConfig();
  app = await buildApp({ pool, config });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.cleanup();
});

describe('POST /api/profile/avatar', () => {
  it('stores a PNG, serves it with strict headers, and replaces the old file on re-upload', async () => {
    const user = await makeUser(pool, 'Png User');
    const res = await upload(user, multipart('avatar', 'me.png', 'image/png', tinyPng()));
    expect(res.statusCode).toBe(200);
    const { avatarUrl } = res.json<{ avatarUrl: string }>();
    expect(avatarUrl).toMatch(new RegExp(`^/avatars/${user.id}-[0-9a-f]{16}\\.png$`));
    const first = path.basename(avatarUrl);
    expect(existsSync(path.join(config.avatarDir, first))).toBe(true);
    expect(await avatarPathOf(user.id)).toBe(first);

    const served = await app.inject({ method: 'GET', url: avatarUrl });
    expect(served.statusCode).toBe(200);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe(AVATAR_CSP);
    expect(served.rawPayload.equals(tinyPng())).toBe(true);

    const again = await upload(user, multipart('avatar', 'me2.png', 'image/png', tinyPng()));
    expect(again.statusCode).toBe(200);
    const second = path.basename(again.json<{ avatarUrl: string }>().avatarUrl);
    expect(second).not.toBe(first);
    expect(existsSync(path.join(config.avatarDir, first))).toBe(false);
    expect(existsSync(path.join(config.avatarDir, second))).toBe(true);
    expect(filesFor(user.id)).toEqual([second]);
  });

  it('rejects HTML disguised as x.png and writes nothing', async () => {
    const user = await makeUser(pool, 'Html User');
    const res = await upload(user, multipart('avatar', 'x.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Avatar must be a PNG, JPEG or WebP image' });
    expect(filesFor(user.id)).toEqual([]);
    expect(await avatarPathOf(user.id)).toBeNull();
  });

  it('rejects a 1.1 MB file with 413', async () => {
    const user = await makeUser(pool, 'Big User');
    const big = Buffer.concat([tinyPng(), Buffer.alloc(1_153_434)]);
    const res = await upload(user, multipart('avatar', 'big.png', 'image/png', big));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'Avatar must be 1 MB or smaller' });
    expect(filesFor(user.id)).toEqual([]);
  });

  it('accepts JPEG and WebP by magic bytes, whatever the declared name/type', async () => {
    const user = await makeUser(pool, 'Jpeg User');
    const jpg = await upload(user, multipart('avatar', 'a.gif', 'application/octet-stream', JPEG));
    expect(jpg.statusCode).toBe(200);
    expect(jpg.json<{ avatarUrl: string }>().avatarUrl).toMatch(/\.jpg$/);
    const webp = await upload(user, multipart('avatar', '../../evil.txt', 'text/plain', WEBP));
    expect(webp.statusCode).toBe(200);
    expect(webp.json<{ avatarUrl: string }>().avatarUrl).toMatch(new RegExp(`^/avatars/${user.id}-[0-9a-f]{16}\\.webp$`));
    expect(filesFor(user.id)).toHaveLength(1);
  });

  it('answers 400 when no file is sent', async () => {
    const user = await makeUser(pool, 'No File');
    const res = await upload(user, onlyTextField());
    expect(res.statusCode).toBe(400);
    const notMultipart = await app.inject({
      method: 'POST',
      url: '/api/profile/avatar',
      headers: { ...(await authed(app, user)), 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(notMultipart.statusCode).toBe(400);
  });

  it('answers 401 when not signed in', async () => {
    const res = await upload({ id: 'x' }, multipart('avatar', 'me.png', 'image/png', tinyPng()), {
      origin: config.publicOrigin,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/profile/avatar', () => {
  it('removes the file and falls back to the SVG url', async () => {
    const user = await makeUser(pool, 'Del User');
    const up = await upload(user, multipart('avatar', 'me.png', 'image/png', tinyPng()));
    const file = path.basename(up.json<{ avatarUrl: string }>().avatarUrl);
    const res = await app.inject({ method: 'DELETE', url: '/api/profile/avatar', headers: await authed(app, user) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ avatarUrl: `/api/users/${user.id}/avatar.svg` });
    expect(existsSync(path.join(config.avatarDir, file))).toBe(false);
    expect(await avatarPathOf(user.id)).toBeNull();
  });
});

describe('GET /api/users/:id', () => {
  it('returns the public profile', async () => {
    const user = await makeUser(pool, 'Bob Smith');
    const viewer = await makeUser(pool, 'Viewer');
    const res = await app.inject({ method: 'GET', url: `/api/users/${user.id}`, headers: await authed(app, viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: user.id, displayName: 'Bob Smith', avatarUrl: `/api/users/${user.id}/avatar.svg` });
  });

  it('404s an unknown uuid, 400s a non-uuid, 401s without a session', async () => {
    const viewer = await makeUser(pool, 'Viewer Two');
    const headers = await authed(app, viewer);
    const unknown = await app.inject({ method: 'GET', url: '/api/users/00000000-0000-4000-8000-000000000000', headers });
    expect(unknown.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/users/not-a-uuid', headers });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: `/api/users/${viewer.id}` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('GET /api/users/:id/avatar.svg', () => {
  it('serves an SVG with escaped initials and a stable colour', async () => {
    const user = await makeUser(pool, '<b &x');
    const res = await app.inject({ method: 'GET', url: `/api/users/${user.id}/avatar.svg` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['content-security-policy']).toBe(SVG_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toContain('>&lt;&amp;</text>');
    expect(res.body).not.toContain('<b');
    expect(res.body.match(/</g)).toHaveLength(5); // <svg, <circle, <text, </text>, </svg>

    const again = await app.inject({ method: 'GET', url: `/api/users/${user.id}/avatar.svg` });
    const fill = (s: string) => /<circle[^>]*fill="([^"]+)"/.exec(s)?.[1];
    expect(fill(again.body)).toBe(fill(res.body));
    expect(fill(initialsSvg('Other Name', user.id))).toBe(fill(res.body));
  });

  it('uses up to two initials, upper-cased', () => {
    expect(initialsSvg('alice bob carol', 'id')).toContain('>AB</text>');
  });

  it('404s an unknown user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/00000000-0000-4000-8000-000000000000/avatar.svg' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/profile', () => {
  it('validates and trims the display name', async () => {
    const user = await makeUser(pool, 'Patch User');
    const headers = await authed(app, user);
    const short = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { displayName: ' a ' } });
    expect(short.statusCode).toBe(400);
    const long = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { displayName: 'x'.repeat(25) } });
    expect(long.statusCode).toBe(400);
    const missing = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: {} });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { displayName: '  New Name  ' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: user.id, displayName: 'New Name', avatarUrl: `/api/users/${user.id}/avatar.svg` });
  });
});

describe('storage helpers', () => {
  it('sniffs magic bytes only', () => {
    expect(sniffImageType(tinyPng())).toBe('png');
    expect(sniffImageType(JPEG)).toBe('jpg');
    expect(sniffImageType(WEBP)).toBe('webp');
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it('deleteAvatar refuses path-like names and ignores missing files', async () => {
    await expect(deleteAvatar(config.avatarDir, '../x.png')).rejects.toThrow();
    await expect(deleteAvatar(config.avatarDir, 'a/b.png')).rejects.toThrow();
    await expect(deleteAvatar(config.avatarDir, 'a\\b.png')).rejects.toThrow();
    await expect(deleteAvatar(config.avatarDir, 'missing.png')).resolves.toBeUndefined();
  });
});
