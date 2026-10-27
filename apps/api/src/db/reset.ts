import { getSql } from './client.js';

/**
 * Drops and recreates every table. Used by `npm run db:reset`.
 *
 * The append-only triggers have to go first: `DROP TABLE` fires a
 * `DELETE`-shaped event on every row, and the trigger would refuse it. The
 * triggers are recreated by the next migration.
 */
export async function reset(): Promise<void> {
  const sql = getSql();
  await sql.unsafe(`
    DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
    DROP TRIGGER IF EXISTS ledger_transactions_no_update ON ledger_transactions;
    DROP TRIGGER IF EXISTS payments_no_update ON payments;
    DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
    DROP FUNCTION IF EXISTS forbid_ledger_mutation();
  `);
  await sql.unsafe(`
    DROP TABLE IF EXISTS ledger_entries, ledger_transactions, ledger_accounts,
      payments, payment_events, orders, listings, events, users CASCADE
  `);
  console.log('[reset] tables dropped');
}

const isMain =
  process.argv[1]?.endsWith('reset.ts') || process.argv[1]?.endsWith('reset.js');
if (isMain) {
  reset()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[reset] failed', err);
      process.exit(1);
    });
}
