import postgres from 'postgres';
import type { Sql } from './types.js';
import { loadConfig } from '../config.js';

const globalForDb = globalThis as unknown as { __tceSql?: Sql };

export function getSql(): Sql {
  if (!globalForDb.__tceSql) {
    // loadConfig() reads DATABASE_URL from the root .env (see ./env.ts) and
    // falls back to a local Postgres when it is not set at all.
    const url = loadConfig().databaseUrl;
    globalForDb.__tceSql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
    }) as unknown as Sql;
  }
  return globalForDb.__tceSql;
}
