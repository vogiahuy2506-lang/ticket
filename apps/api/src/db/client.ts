import postgres from 'postgres';
import type { Sql } from './types.js';

const globalForDb = globalThis as unknown as { __tceSql?: Sql };

export function getSql(): Sql {
  if (!globalForDb.__tceSql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    globalForDb.__tceSql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
    }) as unknown as Sql;
  }
  return globalForDb.__tceSql;
}
