import type postgres from 'postgres';

/**
 * postgres.js exposes two flavours of the query helper:
 *  - `Sql`          the root connection (can start a transaction)
 *  - `TransactionSql` the connection scoped to an open transaction
 *
 * Ledger/ordering services accept either, so the same code runs inside or
 * outside a transaction.
 */
export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

/**
 * Runs a callback inside a transaction.
 *
 * If we already are inside a transaction we open a savepoint instead, so
 * nested service calls (e.g. a ledger posting inside an order transaction)
 * stay atomic without trying to start a second, independent transaction.
 */
export async function withTx<T>(
  db: Db,
  cb: (tx: Tx) => Promise<T>,
): Promise<T> {
  if ('begin' in db) {
    return (await db.begin(async (tx) => cb(tx))) as T;
  }
  return (await db.savepoint(async (tx) => cb(tx))) as T;
}
