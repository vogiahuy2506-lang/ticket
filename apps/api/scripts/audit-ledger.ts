/**
 * Checks that the journal is balanced.
 *
 * Every transaction must satisfy `sum(debit) == sum(credit)`. This is the
 * one invariant that has to hold no matter what the application does, so
 * it is worth checking independently of the test suite - the CI runs it
 * after everything else, against whatever the whole run left behind.
 *
 * It used to be an inline `npx tsx -e "..."` in the CI workflow, which
 * failed for a reason that had nothing to do with the ledger: `tsx -e`
 * evaluates the snippet as CommonJS, where a top-level `await` is a
 * syntax error. The check never ran, and the workflow went red. A script
 * file is compiled as an ES module (the package is `"type": "module"`), so
 * the top-level `await` is fine here.
 *
 * Usage:
 *   npx tsx apps/api/scripts/audit-ledger.ts
 *
 * Exits with code 1 when the journal is unbalanced.
 */

import { getSql } from '../src/db/client.js';
import { auditLedger } from '../src/services/ledger.js';

async function main(): Promise<void> {
  const sql = getSql();
  const audit = await auditLedger(sql);

  if (!audit.ok) {
    console.error('unbalanced transactions:', audit.unbalanced);
    process.exit(1);
  }

  const counted = await sql<{ n: number }[]>`
    SELECT COUNT(DISTINCT txn_id)::int AS n FROM ledger_entries
  `;

  console.log(
    `[audit] the journal is balanced (${counted[0]?.n ?? 0} transaction(s) checked)`,
  );
}

main().catch((err) => {
  console.error('[audit] failed:', err);
  process.exit(1);
});
