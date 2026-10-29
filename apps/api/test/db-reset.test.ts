import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolatedDb,
  isDatabaseReachable,
  useIsolatedDb,
  type IsolatedDb,
} from './helpers/db.js';
import { reset } from '../src/db/reset.js';

/**
 * The reset command.
 *
 * `db:reset` used to drop the tables and stop there, while the README
 * called it "wipe and re-seed" - so following the documentation left the
 * reviewer with an empty database and no demo data. The command now does
 * the whole cycle: drop, migrate, seed.
 *
 * These tests pin that behaviour, because the difference between "the
 * database was emptied" and "the database was reset" is invisible until
 * somebody looks for the demo data afterwards.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('db:reset', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    // A private schema, so the reset below never touches the developer's
    // own database. The reset drops the tables *inside* this schema.
    db = await createIsolatedDb('reset');
    useIsolatedDb(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('leaves the demo data behind, not an empty database', async () => {
    const before = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(before[0]?.n ?? 0).toBe(0);

    await reset();

    // The users, the events and the listings are all back.
    const users = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(users[0]?.n).toBe(6);

    const events = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
    `;
    expect(events[0]?.n).toBe(2);

    const listings = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM listings
    `;
    expect(listings[0]?.n).toBe(6);
  });

  it('leaves no order and no journal entry behind', async () => {
    // A reset database is a *demo* database: it has to start from zero
    // money, so the escrow and the ledger can be shown from the top.
    const orders = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM orders
    `;
    expect(orders[0]?.n).toBe(0);

    const txns = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_transactions
    `;
    expect(txns[0]?.n).toBe(0);

    const entries = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ledger_entries
    `;
    expect(entries[0]?.n).toBe(0);
  });

  it('recreates the append-only triggers it had to drop', async () => {
    // The reset drops the triggers, because `DROP TABLE` fires a
    // DELETE-shaped event and the trigger would refuse it. If the
    // migration did not put them back, the journal would become
    // editable - so this is checked, not assumed.
    const triggers = await db.sql<{ name: string }[]>`
      SELECT t.tgname AS name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND NOT t.tgisinternal
        AND t.tgname IN (
          'ledger_entries_no_update',
          'ledger_transactions_no_update',
          'payments_no_update',
          'payment_events_no_update'
        )
    `;
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'ledger_entries_no_update',
      'ledger_transactions_no_update',
      'payment_events_no_update',
      'payments_no_update',
    ]);
  });

  it('can be run twice in a row', async () => {
    // The reviewer may reset before every demo. The second run has to
    // land on the same clean state, not on an error.
    await reset();
    await reset();

    const users = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
    `;
    expect(users[0]?.n).toBe(6);

    const orders = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM orders
    `;
    expect(orders[0]?.n).toBe(0);
  });
});
