import { createHash, randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ImageExt = 'png' | 'jpg' | 'webp';

/** `/avatars/<avatar_path>` for an uploaded avatar, else the generated SVG URL. */
export function avatarUrlFor(user: { id: string; avatar_path: string | null }): string {
  return user.avatar_path ? `/avatars/${user.avatar_path}` : `/api/users/${user.id}/avatar.svg`;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detects PNG / JPEG / WebP from the magic bytes only; null for anything else. */
export function sniffImageType(buf: Buffer): ImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'webp']);

/** Writes `<userId>-<16 hex>.<ext>` into `dir` (exclusive create) and returns the file name. */
export async function saveAvatar(dir: string, userId: string, buf: Buffer, ext: ImageExt): Promise<string> {
  if (!UUID_RE.test(userId)) throw new Error('invalid user id');
  if (!EXTS.has(ext)) throw new Error('invalid extension');
  const fileName = `${userId}-${randomBytes(8).toString('hex')}.${ext}`;
  await writeFile(path.join(dir, fileName), buf, { flag: 'wx' });
  return fileName;
}

/** Deletes `dir/fileName`; ignores a missing file; refuses names with path separators or `..`. */
export async function deleteAvatar(dir: string, fileName: string): Promise<void> {
  if (fileName === '' || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('invalid avatar file name');
  }
  try {
    await unlink(path.join(dir, fileName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** First letters of up to two words, upper-cased. */
export function initialsOf(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase();
}

/** A hue-based colour derived from a hash of the user id. */
export function colorFor(userId: string): string {
  const hue = createHash('sha256').update(userId).digest().readUInt16BE(0) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/** A 128x128 SVG: the user's (escaped) initials on a circle coloured by their id. */
export function initialsSvg(displayName: string, userId: string): string {
  const initials = escapeXml(initialsOf(displayName));
  const fill = colorFor(userId);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<circle cx="64" cy="64" r="64" fill="${fill}"/>` +
    `<text x="64" y="64" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-size="52" font-weight="600" fill="#ffffff">${initials}</text>` +
    `</svg>`
  );
}
