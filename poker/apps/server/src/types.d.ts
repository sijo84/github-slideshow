import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { SessionUser } from './auth/session.js';
import type { TableManager } from './realtime/tableManager.js';

declare module 'fastify' {
  interface FastifyInstance {
    deps: { pool: Pool; config: Config; clock: () => number };
    /** Decorated by main.ts / tests, not by buildApp; routes must tolerate it being absent. */
    tables: TableManager;
  }
  interface FastifyRequest {
    user?: SessionUser;
  }
}
