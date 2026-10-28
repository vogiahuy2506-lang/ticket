import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadConfig } from '../../src/config.js';
import {
  createIsolatedDb as createSchema,
  useIsolatedDb,
  type IsolatedDb,
} from '../../src/db/isolated.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The schema of the application, read straight from the source so the
 * tests always run against the real schema - a copy in the test folder
 * would drift and hide a migration bug.
 */
const SCHEMA_SQL = readFileSync(
  join(here, '..', '..', 'src', 'db', 'schema.sql'),
  'utf8',
);

export type { IsolatedDb };

/**
 * Creates a private Postgres schema with the application schema in it and
 * returns a client that is scoped to it.
 *
 * Why a schema and not a transaction: the API server grabs its connection
 * from the global client in `db/client.ts`, so a test that drives the HTTP
 * layer cannot hand its own transaction to the server. A private schema
 * gives the *whole process* - services and server alike - a database of
 * its own, so a test can never see or corrupt the developer's data.
 *
 * The schema is dropped again in `drop()`; the developer's own database is
 * never touched.
 */
export async function createIsolatedDb(label = 'test'): Promise<IsolatedDb> {
  return createSchema(label, SCHEMA_SQL);
}

/**
 * Points the process-wide database client at the isolated database.
 *
 * `db/client.ts` caches its client on `globalThis`, and the API server
 * reads it from there. Overwriting the cached value is what makes the
 * server run against the test schema instead of the developer's database.
 */
export { useIsolatedDb };

/**
 * Checks that a database is reachable.
 *
 * The integration tests need one; the unit tests do not. When there is no
 * database the integration tests are skipped with a loud warning instead of
 * failing the whole suite - but in CI a missing database is a hard error,
 * because a silently skipped suite is worse than a red build.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    const sql = postgres(loadConfig().databaseUrl, {
      max: 1,
      connect_timeout: 5,
    });
    try {
      await sql`SELECT 1`;
      return true;
    } finally {
      await sql.end();
    }
  } catch (err) {
    if (process.env.CI) {
      throw new Error(
        `The database is not reachable (${loadConfig().databaseUrl}): ${
          (err as Error).message
        }. In CI the integration tests must run, not skip.`,
      );
    }
    console.warn(
      `[test] no database at ${loadConfig().databaseUrl} - the integration tests are skipped. ` +
        'Start Postgres (docker compose up db) to run them.',
    );
    return false;
  }
}
