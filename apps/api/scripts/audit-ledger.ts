/**
 * Checks that the journal is balanced.
 *
 * Every transaction must satisfy `sum(debit) == sum(credit)`. This is the
 * one invariant that has to hold no matter what the application does, so
 * it is worth checking independently of the test suite.
 *
 * Where the data lives:
 *   - by default the script reads the *main* schema of `DATABASE_URL`,
 *     which has to be migrated already (`npm run db:init`);
 *   - `AUDIT_SCHEMA` names a schema to read instead;
 *   - `AUDIT_SCHEMA_FILE` names a *file* that contains a schema name -
 *     this is how the CI audits the private schema the e2e run created,
 *     whose name is random and therefore only known at runtime.
 *
 * Why it is a script file and not an inline `npx tsx -e "..."`: the snippet
 * form is evaluated as CommonJS, where a top-level `await` is a syntax
 * error, so the check never ran and the workflow went red for a reason
 * that had nothing to do with the ledger.
 *
 * Usage:
 *   npx tsx apps/api/scripts/audit-ledger.ts
 *
 * Exits with code 1 when the journal is unbalanced.
 */

import { existsSync, readFileSync } from 'node:fs';
import { getSql } from '../src/db/client.js';
import { createScopedDb } from '../src/db/isolated.js';
import { auditLedger } from '../src/services/ledger.js';
import type { Sql } from '../src/db/types.js';

/**
 * Resolves the schema to audit.
 *
 * The file wins over the plain variable, because the CI passes a file: the
 * schema name of the e2e run is random, so it can only be known at runtime.
 */
function resolveSchema(): string | undefined {
  const file = process.env.AUDIT_SCHEMA_FILE;
  if (file) {
    if (!existsSync(file)) {
      throw new Error(
        `The schema file ${file} does not exist - the e2e run did not finish`,
      );
    }
    const name = readFileSync(file, 'utf8').trim();
    if (!name) {
      throw new Error(`The schema file ${file} is empty`);
    }
    return name;
  }

  const schema = process.env.AUDIT_SCHEMA;
  return schema && schema.trim() ? schema.trim() : undefined;
}

async function main(): Promise<void> {
  const schema = resolveSchema();
  const sql: Sql = schema ? await createScopedDb(schema) : getSql();

  try {
    const audit = await auditLedger(sql);

    if (!audit.ok) {
      console.error('[audit] unbalanced transactions:', audit.unbalanced);
      process.exit(1);
    }

    const counted = await sql<{ n: number }[]>`
      SELECT COUNT(DISTINCT txn_id)::int AS n FROM ledger_entries
    `;

    console.log(
      `[audit] the journal is balanced (${counted[0]?.n ?? 0} transaction(s) checked${
        schema ? ` in schema ${schema}` : ''
      })`,
    );
  } finally {
    if (schema) {
      await sql.end();
    }
  }
}

main().catch((err) => {
  // The most likely cause is an unmigrated database. Say so plainly
  // instead of letting a Postgres error code hide the real problem.
  const code = (err as { code?: string }).code;
  if (code === '42P01') {
    const schema = process.env.AUDIT_SCHEMA ?? '(the main schema)';
    console.error(
      `[audit] the tables do not exist in ${schema} - run \`npm run db:init\` first`,
    );
  } else {
    console.error('[audit] failed:', err);
  }
  process.exit(1);
});
