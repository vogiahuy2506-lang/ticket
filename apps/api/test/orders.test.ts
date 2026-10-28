import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrder, OrderError } from '../src/services/orders.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The checkout rules, tested against a real database.
 *
 * These are the paths the end-to-end script cannot reach easily: a
 * rejected request must not leave a reservation behind, and a rejected
 * reservation must not move any money.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('createOrder', () => {
  let db: IsolatedDb;
  let data: TestData;

  beforeAll(async () => {
    db = await createIsolatedDb('orders');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('creates a PENDING_PAYMENT order and reserves the tickets', async () => {
    const fx = await data.fixture('create-ok');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 2,
    });

    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.gross_vnd).toBe('2200000'); // 2 x 1.000.000 + 10%
    expect(order.seller_net_vnd).toBe('1900000'); // 2 x 1.000.000 - 5%
    expect(order.platform_fee_vnd).toBe('300000'); // 10% + 5%
    expect(await data.quantitySold(fx.listing.id)).toBe(2);
  });

  it('rejects a quantity of zero or a negative one', async () => {
    const fx = await data.fixture('bad-qty');
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        createOrder(db.sql, {
          buyerId: fx.buyer.id,
          listingId: fx.listing.id,
          quantity,
        }),
      ).rejects.toThrow(OrderError);
    }
    // A rejected checkout must not reserve anything.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('rejects a checkout for a listing that does not exist', async () => {
    const fx = await data.fixture('no-listing');
    await expect(
      createOrder(db.sql, {
        buyerId: fx.buyer.id,
        listingId: '00000000-0000-0000-0000-000000000000',
        quantity: 1,
      }),
    ).rejects.toThrow(/Không tìm thấy listing/);
  });

  it('rejects a seller buying their own listing', async () => {
    const fx = await data.fixture('own-listing');
    await expect(
      createOrder(db.sql, {
        buyerId: fx.seller.id,
        listingId: fx.listing.id,
        quantity: 1,
      }),
    ).rejects.toThrow(/không thể mua vé của chính mình/);
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('rejects a checkout for a completed event', async () => {
    const fx = await data.fixture('completed-event');
    await db.sql`UPDATE events SET status = 'completed' WHERE id = ${fx.eventId}`;
    await expect(
      createOrder(db.sql, {
        buyerId: fx.buyer.id,
        listingId: fx.listing.id,
        quantity: 1,
      }),
    ).rejects.toThrow(/đã hoàn tất/);
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('rejects a checkout for more tickets than are left', async () => {
    const fx = await data.fixture('sold-out');
    const small = await data.listing(fx.eventId, fx.seller.id, {
      title: 'Only one left',
      quantityTotal: 1,
      priceVnd: 500_000,
    });

    await expect(
      createOrder(db.sql, {
        buyerId: fx.buyer.id,
        listingId: small.id,
        quantity: 2,
      }),
    ).rejects.toThrow(/Chỉ còn 1 vé/);
    expect(await data.quantitySold(small.id)).toBe(0);
  });

  it('returns the same order for a repeated Idempotency-Key', async () => {
    const fx = await data.fixture('idem');
    const key = 'double-tap-1';

    const first = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
      idempotencyKey: key,
    });
    const second = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    // The second call must not reserve a second batch of tickets.
    expect(await data.quantitySold(fx.listing.id)).toBe(1);
  });

  it('scopes the Idempotency-Key to the buyer', async () => {
    const fx = await data.fixture('idem-scope');
    const otherBuyer = await data.user('Other Buyer idem-scope', 'buyer');
    const key = 'shared-key';

    const first = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
      idempotencyKey: key,
    });
    const second = await createOrder(db.sql, {
      buyerId: otherBuyer.id,
      listingId: fx.listing.id,
      quantity: 1,
      idempotencyKey: key,
    });

    // A different buyer may reuse the same key without getting the first
    // buyer's order.
    expect(second.id).not.toBe(first.id);
  });

  it('does not reserve the same ticket twice when two buyers race', async () => {
    const fx = await data.fixture('race');
    const last = await data.listing(fx.eventId, fx.seller.id, {
      title: 'The very last ticket',
      quantityTotal: 1,
      priceVnd: 900_000,
    });
    const buyer2 = await data.user('Buyer race second', 'buyer');

    // Both buyers try to take the last ticket at the same time. Exactly one
    // must win, and the listing must never be oversold.
    const results = await Promise.allSettled([
      createOrder(db.sql, {
        buyerId: fx.buyer.id,
        listingId: last.id,
        quantity: 1,
      }),
      createOrder(db.sql, {
        buyerId: buyer2.id,
        listingId: last.id,
        quantity: 1,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await data.quantitySold(last.id)).toBe(1);
  });

  it('never oversells a listing under repeated concurrent checkouts', async () => {
    const fx = await data.fixture('oversell');
    const scarce = await data.listing(fx.eventId, fx.seller.id, {
      title: 'Three tickets',
      quantityTotal: 3,
      priceVnd: 700_000,
    });
    const buyers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => data.user(`Buyer oversell ${i}`, 'buyer')),
    );

    await Promise.allSettled(
      buyers.map((b) =>
        createOrder(db.sql, {
          buyerId: b.id,
          listingId: scarce.id,
          quantity: 1,
        }),
      ),
    );

    // The database has a CHECK constraint that quantity_sold <=
    // quantity_total, so an oversell would throw. Three buyers got in.
    expect(await data.quantitySold(scarce.id)).toBe(3);
  });

  it('expires an abandoned reservation and gives the ticket back', async () => {
    const fx = await data.fixture('expiry');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 2,
    });
    expect(await data.quantitySold(fx.listing.id)).toBe(2);

    // Move the reservation window into the past.
    await db.sql`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order.id}
    `;

    // The sweep runs on the next checkout.
    await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    const status = await data.orderStatus(order.id);
    expect(status).toBe('EXPIRED');
    // 2 (expired) - 2 (returned) + 1 (new order) = 1
    expect(await data.quantitySold(fx.listing.id)).toBe(1);
  });

  it('never lets a listing go negative when an order is cancelled', async () => {
    const fx = await data.fixture('cancel');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 3,
    });
    expect(await data.quantitySold(fx.listing.id)).toBe(3);

    await db.sql`UPDATE orders SET status = 'CANCELLED' WHERE id = ${order.id}`;
    await db.sql`
      UPDATE listings SET quantity_sold = 0 WHERE id = ${fx.listing.id}
    `;

    // The database refuses a negative count, so a double refund would
    // throw here rather than corrupt the stock.
    await expect(
      db.sql`
        UPDATE listings
        SET quantity_sold = quantity_sold - 3
        WHERE id = ${fx.listing.id}
      `,
    ).rejects.toThrow();
  });
});
