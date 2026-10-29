import { getSql } from './client.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

/**
 * Puts the database back into the state a fresh clone has: every table
 * dropped, the schema applied again, and the demo data seeded.
 *
 * Decision (brief was silent): `db:reset` used to drop the tables and
 * stop there, while the README called it "wipe and re-seed". That was a
 * trap: following the documentation left the reviewer with an empty
 * database and no demo data, and the two commands needed to get back
 * (`db:reset` then `db:init`) were easy to get wrong.
 *
 * A command called "reset" should leave the database *reset*, not
 * half-reset. So the whole cycle lives here, and the README, the test
 * plan and the troubleshooting notes all describe the same single
 * command.
 *
 * The append-only triggers have to go first: `DROP TABLE` fires a
 * `DELETE`-shaped event on every row, and the trigger would refuse it.
 * The triggers are recreated by `migrate()` right afterwards.
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

  // The schema and the demo data are put back, so the database is
  // *reset* rather than emptied. `migrate()` recreates the triggers the
  // drop above had to remove.
  await migrate();
  await seed();
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
