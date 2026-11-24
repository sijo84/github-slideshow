export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  secureCookies: boolean;
  avatarDir: string;
  publicOrigin: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT, 3001),
    host: env.HOST || 'localhost',
    databaseUrl: env.DATABASE_URL || 'postgres://poker:poker@localhost:5432/poker_dev',
    secureCookies: parseBool(env.SECURE_COOKIES, false),
    avatarDir: env.AVATAR_DIR || 'apps/server/data/avatars',
    publicOrigin: env.PUBLIC_ORIGIN || 'http://localhost:5173',
  };
}
