import { getSql } from './client.js';

/**
 * Drops and recreates every table. Used by `npm run db:reset`.
 */
export async function reset(): Promise<void> {
  const sql = getSql();
  await sql.unsafe(`
    DROP TABLE IF EXISTS ledger_entries, ledger_transactions, ledger_accounts,
      payments, orders, listings, events, users CASCADE
  `);
  console.log('[reset] tables dropped');
}

const isMain = process.argv[1]?.endsWith('reset.ts');
if (isMain) {
  reset()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[reset] failed', err);
      process.exit(1);
    });
}
