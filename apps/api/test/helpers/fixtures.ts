import type { Sql } from '../../src/db/types.js';
import { ensurePlatformAccounts, ensureUserAccounts } from '../../src/db/accounts.js';

export interface TestUser {
  id: string;
  name: string;
  role: 'buyer' | 'seller' | 'admin';
}

export interface TestListing {
  id: string;
  eventId: string;
  sellerId: string;
  title: string;
  quantityTotal: number;
  quantitySold: number;
  priceVnd: number;
}

/**
 * Builds the rows a test needs, in the shape the application expects.
 *
 * The names are unique per test so a failed run can be traced back to the
 * test that created the row, and the users are looked up by that name so
 * the helper is idempotent.
 */
export class TestData {
  constructor(private readonly sql: Sql) {}

  async user(name: string, role: TestUser['role']): Promise<TestUser> {
    const rows = await this.sql<{ id: string; name: string; role: string }[]>`
      INSERT INTO users (name, role)
      VALUES (${name}, ${role})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name, role
    `;
    const user = rows[0]!;
    await ensureUserAccounts(this.sql, user.id, user.name);
    return { id: user.id, name: user.name, role: role };
  }

  async event(name: string, opts: { startsInDays?: number; status?: 'scheduled' | 'completed' } = {}) {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO events (name, venue, starts_at, status)
      VALUES (
        ${name},
        ${'Test venue'},
        now() + (${opts.startsInDays ?? 30} * interval '1 day'),
        ${opts.status ?? 'scheduled'}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async listing(
    eventId: string,
    sellerId: string,
    opts: { title?: string; quantityTotal?: number; priceVnd?: number } = {},
  ): Promise<TestListing> {
    const title = opts.title ?? `Listing ${randomId()}`;
    const quantityTotal = opts.quantityTotal ?? 10;
    const priceVnd = opts.priceVnd ?? 1_000_000;
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
      VALUES (${eventId}, ${sellerId}, ${title}, ${quantityTotal}, ${priceVnd})
      RETURNING id
    `;
    return {
      id: rows[0]!.id,
      eventId,
      sellerId,
      title,
      quantityTotal,
      quantitySold: 0,
      priceVnd,
    };
  }

  /** Creates a buyer, a seller and a listing on a fresh event. */
  async fixture(label: string) {
    await ensurePlatformAccounts(this.sql);
    const buyer = await this.user(`Buyer ${label}`, 'buyer');
    const seller = await this.user(`Seller ${label}`, 'seller');
    const eventId = await this.event(`Event ${label}`);
    const listing = await this.listing(eventId, seller.id, {
      title: `Listing ${label}`,
      quantityTotal: 10,
      priceVnd: 1_000_000,
    });
    return { buyer, seller, eventId, listing };
  }

  /** The number of tickets currently reserved on a listing. */
  async quantitySold(listingId: string): Promise<number> {
    const rows = await this.sql<{ quantity_sold: number }[]>`
      SELECT quantity_sold FROM listings WHERE id = ${listingId}
    `;
    return rows[0]!.quantity_sold;
  }

  /**
   * The balance of one ledger account, by its code.
   *
   * The sign follows the account kind, exactly like `computeBalances` in
   * the ledger service: an asset is debit-positive, a liability (or
   * revenue, or equity) is credit-positive. So "how much cash is at the
   * gateway" and "how much do we owe the buyer" are both positive
   * numbers, which is what a test wants to assert on.
   */
  async balance(accountCode: string): Promise<number> {
    const rows = await this.sql<{ kind: string; balance: string }[]>`
      SELECT
        a.kind,
        COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_vnd
                          ELSE -e.amount_vnd END), 0)::text AS balance
      FROM ledger_accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.code = ${accountCode}
      GROUP BY a.kind
    `;
    const row = rows[0];
    if (!row) return 0;
    // `signed` is debit - credit. An asset is debit-positive, a liability
    // (or revenue, or equity) is credit-positive.
    const signed = Number(row.balance);
    const creditPositive =
      row.kind === 'liability' || row.kind === 'revenue' || row.kind === 'equity';
    // `|| 0` normalises -0 to 0, so a test can compare against 0 directly.
    return (creditPositive ? -signed : signed) || 0;
  }

  async orderStatus(orderId: string): Promise<string | undefined> {
    const rows = await this.sql<{ status: string }[]>`
      SELECT status FROM orders WHERE id = ${orderId}
    `;
    return rows[0]?.status;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}
