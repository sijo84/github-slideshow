import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';

const INT8_OID = 20;

function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint value ${value} is outside the safe integer range`);
  }
  return n;
}

// Per-pool type overrides (not the global pg.types registry): int8/bigint (OID 20)
// comes back as a JS number. Chips are safe integers; unsafe values throw.
function makeTypes(): pg.TypeOverrides {
  const types = new pg.TypeOverrides();
  types.setTypeParser(INT8_OID, 'text', parseInt8);
  return types;
}

/** Creates a pg Pool. `extra` is merged into the config (e.g. connection `options`). */
export function makePool(url: string, extra: Omit<PoolConfig, 'connectionString' | 'types'> = {}): Pool {
  return new pg.Pool({ ...extra, connectionString: url, types: makeTypes() });
}
