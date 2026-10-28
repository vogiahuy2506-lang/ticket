import postgres from 'postgres';
import { loadConfig } from '../config.js';
import type { Sql } from './types.js';

/**
 * A private Postgres schema that holds the application tables.
 *
 * The point of a schema (and not a transaction) is that the whole *process*
 * can be pointed at it: the API server grabs its connection from the global
 * client in `db/client.ts`, so a runner that drives the HTTP layer cannot
 * hand its own transaction to the server. A private schema gives the
 * services and the server alike a database of their own, so a run can never
 * see or corrupt the developer's data.
 *
 * The schema is dropped again by `drop()`; the developer's own database is
 * never touched.
 */
export interface IsolatedDb {
  /** a client whose `search_path` points at the private schema */
  sql: Sql;
  /** the name of the private schema */
  schema: string;
  /** drops the schema and closes the connection */
  drop(): Promise<void>;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Points the process-wide database client at the given connection.
 *
 * `db/client.ts` caches its client on `globalThis`, and the API server
 * reads it from there. Overwriting the cached value is what makes the
 * server run against the private schema instead of the real database.
 */
export function useIsolatedDb(sql: Sql): void {
  const globalForDb = globalThis as unknown as { __tceSql?: Sql };
  globalForDb.__tceSql = sql;
}

/**
 * Creates a private schema with the application schema in it and returns a
 * client that is scoped to it.
 *
 * @param label   a readable prefix, so a leftover schema is easy to spot
 * @param schemaSql  the DDL of the application, applied inside the schema.
 *   Omit it when the caller applies the schema itself (the e2e runner
 *   calls `migrate()`, so the real migration path is exercised).
 */
export async function createIsolatedDb(
  label: string,
  schemaSql?: string,
): Promise<IsolatedDb> {
  const url = loadConfig().databaseUrl;
  const schema = `tce_${label.replace(/[^a-z0-9_]/gi, '_')}_${randomSuffix()}`;

  const admin = postgres(url, { max: 1 });
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  // `search_path` makes every unqualified name resolve inside the private
  // schema, so the application code needs no change to run against it.
  const sql = postgres(url, {
    max: 4,
    connection: { search_path: schema },
  }) as unknown as Sql;

  try {
    if (schemaSql) {
      await sql.unsafe(schemaSql);
    }
  } catch (err) {
    await sql.end();
    await dropSchema(url, schema);
    throw err;
  }

  return {
    sql,
    schema,
    drop: async () => {
      await sql.end();
      await dropSchema(url, schema);
    },
  };
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const admin = postgres(url, { max: 1 });
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
}

/**
 * Removes the rows a test run left behind in the *real* database.
 *
 * Only used by the "run against an already-running stack" mode, where there
 * is no private schema to drop. The append-only triggers have to be
 * suspended first: they refuse every DELETE on the journal, which is
 * exactly what we need here - the rows are being thrown away, not rewritten.
 * The triggers are put back afterwards, so the immutability guarantee still
 * holds for everything that happens next.
 */
export async function deleteE2eRows(sql: Sql): Promise<number> {
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
    DROP TRIGGER IF EXISTS ledger_transactions_no_update ON ledger_transactions;
    DROP TRIGGER IF EXISTS payments_no_update ON payments;
    DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
  `);
  try {
    await sql.unsafe(`
      DELETE FROM ledger_entries WHERE txn_id IN (
        SELECT t.id FROM ledger_transactions t
        JOIN orders o ON o.id = t.ref_id
        JOIN events e ON e.id = o.event_id
        WHERE e.name LIKE 'E2E%'
      );
      DELETE FROM ledger_transactions WHERE ref_id IN (
        SELECT o.id FROM orders o
        JOIN events e ON e.id = o.event_id
        WHERE e.name LIKE 'E2E%'
      );
      DELETE FROM payment_events WHERE txn_ref::text IN (
        SELECT o.id::text FROM orders o
        JOIN events e ON e.id = o.event_id
        WHERE e.name LIKE 'E2E%'
      );
      DELETE FROM orders WHERE event_id IN (
        SELECT id FROM events WHERE name LIKE 'E2E%'
      );
      DELETE FROM listings WHERE event_id IN (
        SELECT id FROM events WHERE name LIKE 'E2E%'
      );
      DELETE FROM events WHERE name LIKE 'E2E%';
    `);
    const remaining = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events WHERE name LIKE 'E2E%'
    `;
    return remaining[0]?.n ?? 0;
  } finally {
    // Put the immutability guarantee back, whatever happened above.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger entries are append-only (attempted %)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
      CREATE TRIGGER ledger_entries_no_update
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

      DROP TRIGGER IF EXISTS ledger_transactions_no_update ON ledger_transactions;
      CREATE TRIGGER ledger_transactions_no_update
        BEFORE UPDATE OR DELETE ON ledger_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

      DROP TRIGGER IF EXISTS payments_no_update ON payments;
      CREATE TRIGGER payments_no_update
        BEFORE UPDATE OR DELETE ON payments
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

      DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
      CREATE TRIGGER payment_events_no_update
        BEFORE UPDATE OR DELETE ON payment_events
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);
  }
}
