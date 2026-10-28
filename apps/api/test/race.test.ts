import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createOrder, releaseEventEscrow } from '../src/services/orders.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The race between a checkout and the completion of the event.
 *
 * This is the bug that a reviewer found and the test suite did not: the
 * checkout read the event's status *without locking the row*, while the
 * escrow release locked the orders but not the event. So this interleaving
 * was possible:
 *
 *   1. checkout reads `events.status = 'scheduled'`
 *   2. the operator completes the event, releasing the escrow
 *   3. checkout inserts the order for an event that is already over
 *   4. the buyer pays, the money goes into the seller escrow
 *   5. nothing ever releases it - the event was completed in step 2
 *
 * The money would be trapped in escrow with no way out.
 *
 * The fix is the row lock, on both sides:
 *   - the checkout takes a *shared* lock on the event (`FOR SHARE`)
 *   - the release takes an *exclusive* one (`FOR UPDATE`)
 *
 * The two cannot hold the same row at the same time, so either the
 * checkout sees `completed` and refuses, or the release waits for the
 * checkout and then includes its order.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('checkout vs. event completion', () => {
  let db: IsolatedDb;
  let data: TestData;

  beforeAll(async () => {
    db = await createIsolatedDb('race');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('rejects a checkout for an event that was completed', async () => {
    const fx = await data.fixture('race-completed');
    await db.sql`UPDATE events SET status = 'completed' WHERE id = ${fx.eventId}`;

    await expect(
      createOrder(db.sql, {
        buyerId: fx.buyer.id,
        listingId: fx.listing.id,
        quantity: 1,
      }),
    ).rejects.toThrow(/đã hoàn tất/);
  });

  it('serialises a checkout that runs at the same time as the completion', async () => {
    // The real race, driven through two independent connections so the
    // two transactions really do overlap in the database.
    const fx = await data.fixture('race-concurrent');

    // A second connection to the same isolated schema.
    const other = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: db.schema },
    });
    // The checkout runs in its own transaction on the other connection,
    // and holds the shared lock on the event row for as long as it lives.
    const checkout = other.begin(async (tx) => {
      await tx`SELECT id FROM events WHERE id = ${fx.eventId} FOR SHARE`;
      // A short pause while the shared lock is held, so the release on the
      // first connection has to wait for it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rows = await tx`
        INSERT INTO orders (
          buyer_id, listing_id, event_id, seller_id, quantity,
          unit_price_vnd, subtotal_vnd, buyer_fee_vnd, seller_fee_vnd,
          gross_vnd, seller_net_vnd, platform_fee_vnd, status, gateway, expires_at
        )
        VALUES (
          ${fx.buyer.id}, ${fx.listing.id}, ${fx.eventId}, ${fx.seller.id}, 1,
          1000000, 1000000, 100000, 50000, 1100000, 950000, 150000,
          'PENDING_PAYMENT', 'vnpay', now() + interval '15 minutes'
        )
        RETURNING id, status
      `;
      // The reservation of the ticket, exactly like `createOrder` does it.
      await tx`
        UPDATE listings
        SET quantity_sold = quantity_sold + 1
        WHERE id = ${fx.listing.id}
      `;
      return rows[0]!;
    });

    // Give the checkout a moment to take its shared lock.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The release runs on the first connection. It has to wait for the
    // shared lock to be released.
    const release = releaseEventEscrow(db.sql, { eventId: fx.eventId });

    const [order, released] = await Promise.all([checkout, release]);
    await other.end();

    // The checkout won the race, so the release must have waited for it
    // and must have picked the order up. The order cannot be left
    // PENDING_PAYMENT: that is the state whose money would be trapped.
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(released.cancelled).toBe(1);
    expect(await data.orderStatus(order.id)).toBe('CANCELLED');

    // The tickets went back to the listing.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('holds a shared lock on the event while the checkout runs', async () => {
    // The lock itself, checked directly, so the test is deterministic
    // instead of depending on a lucky interleaving.
    //
    // The checkout reads the event's status with `FOR SHARE`. A shared
    // lock blocks an exclusive one, so while the checkout is running the
    // escrow release (`FOR UPDATE` on the same row) has to wait. Without
    // the shared lock the release would sail through, and the two could
    // interleave badly.
    const fx = await data.fixture('race-lock');

    const other = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: db.schema },
    });
    // A third connection, because `other` is already busy holding the
    // shared lock.
    const locker = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: db.schema },
    });

    // The checkout's transaction: it reads the event with a shared lock
    // and holds it.
    const checkout = other.begin(async (tx) => {
      await tx`SELECT status FROM events WHERE id = ${fx.eventId} FOR SHARE`;
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // From the other connection, the exclusive lock has to wait. A short
    // `lock_timeout` turns "it would have blocked" into a clean error
    // instead of a hang.
    await locker`SET lock_timeout = '250ms'`;
    let blocked: string | null = null;
    try {
      await locker`SELECT id FROM events WHERE id = ${fx.eventId} FOR UPDATE`;
    } catch (err) {
      blocked = err instanceof Error ? err.message : String(err);
    }

    await checkout;
    await other.end();
    await locker.end();

    expect(
      String(blocked),
      'the escrow release was not blocked by the checkout',
    ).toMatch(/lock timeout|canceling statement/i);
  });

  it('does not deadlock when the checkout and the release overlap', async () => {
    // The lock *order* matters as much as the lock itself.
    //
    // If the checkout locked the listing row first and the event row
    // second, while the release locked the event row first and the
    // listing row second, the database would deadlock:
    //
    //   checkout                     escrow release
    //   ---------------------------  ---------------------------
    //   holds the listing row        holds the event row
    //   wants the event row (SHARE)  wants the listing row (UPDATE)
    //
    // Postgres would detect it and kill one of the two transactions. The
    // buyer would see a failed checkout (or a failed release), which is
    // bad enough - but the deadlock is also a symptom of the wrong lock
    // order, and the fix is to take the locks in the *same* order on
    // both sides: event first, then listing.
    //
    // The test runs the two against each other many times: a deadlock
    // would show up as a "deadlock detected" error.
    const fx = await data.fixture('race-deadlock');

    const other = postgres(db.url, {
      max: 2,
      onnotice: () => {},
      connection: { search_path: db.schema },
    });

    for (let round = 0; round < 8; round++) {
      // A fresh event per round: the release completes the event, so the
      // next round would be refused with "already completed".
      const eventId = await data.event(`Event race-deadlock ${round}`);
      const listing = await data.listing(eventId, fx.seller.id, {
        title: `Deadlock listing ${round}`,
        quantityTotal: 10,
        priceVnd: 1_000_000,
      });

      // The *real* checkout runs on its own connection, so the two
      // transactions really overlap in the database. The service takes
      // the locks in its own order - that is what is being tested.
      const checkout = other.begin(async (tx) => {
        await createOrder(tx, {
          buyerId: fx.buyer.id,
          listingId: listing.id,
          quantity: 1,
        });
        // Hold the transaction open a little, so the release overlaps it.
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // The release runs on the main connection, in parallel.
      const release = releaseEventEscrow(db.sql, { eventId });

      // Both outcomes are legitimate, and neither may be a deadlock:
      //   - the checkout wins: the release waits for it and includes the
      //     order in the escrow
      //   - the release wins: the checkout sees `completed` and is refused
      //     with a clean error (never a deadlock, never a hang)
      const [checkoutResult] = await Promise.all([
        checkout.then(
          () => 'created' as const,
          (err: Error) => {
            if (/đã hoàn tất/.test(err.message)) return 'refused' as const;
            throw err;
          },
        ),
        release,
      ]);

      expect(
        ['created', 'refused'],
        `round ${round} failed with an unexpected outcome`,
      ).toContain(checkoutResult);
    }

    await other.end();
  });

  it('never leaves a paid order on a completed event', async () => {
    // The invariant, stated without any interleaving: once the event is
    // completed, there is no order of it that is still waiting for a
    // payment. Such an order would be a ticket that is reserved forever
    // and money that is trapped in escrow.
    const fx = await data.fixture('race-invariant');

    await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    await releaseEventEscrow(db.sql, { eventId: fx.eventId });

    const rows = await db.sql<{ id: string; status: string }[]>`
      SELECT id, status FROM orders WHERE event_id = ${fx.eventId}
    `;
    for (const row of rows) {
      expect(row.status, `order ${row.id} is still ${row.status}`).not.toBe(
        'PENDING_PAYMENT',
      );
    }
  });

  it('releases the escrow of an order that was paid before the completion', async () => {
    const fx = await data.fixture('race-release');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    // Pay it: the money goes into the seller's pending escrow.
    await db.sql`
      INSERT INTO payments (order_id, provider, provider_txn_id, amount_vnd, status)
      VALUES (${order.id}, 'vnpay', ${`RACE-${Date.now()}`}, 1100000, 'SUCCEEDED')
    `;
    await db.sql`UPDATE orders SET status = 'PAID' WHERE id = ${order.id}`;
    await db.sql`
      INSERT INTO ledger_transactions (ref_type, ref_id, memo)
      VALUES ('PAYMENT_CAPTURE', ${order.id}, 'race fixture')
    `;
    const txn = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_transactions
      WHERE ref_type = 'PAYMENT_CAPTURE' AND ref_id = ${order.id}
      ORDER BY created_at DESC LIMIT 1
    `;
    const cash = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = 'asset:gateway_cash' LIMIT 1
    `;
    const pending = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = ${`liability:user:${fx.seller.id}:pending`} LIMIT 1
    `;
    const fee = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = 'revenue:platform_fee' LIMIT 1
    `;
    await db.sql`
      INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
      VALUES
        (${txn[0]!.id}, ${cash[0]!.id}, 'debit', 1100000),
        (${txn[0]!.id}, ${pending[0]!.id}, 'credit', 950000),
        (${txn[0]!.id}, ${fee[0]!.id}, 'credit', 150000)
    `;

    const released = await releaseEventEscrow(db.sql, { eventId: fx.eventId });

    expect(released.released).toBe(1);
    expect(released.releasedVnd).toBe(950000);
    expect(await data.orderStatus(order.id)).toBe('RELEASED');
    expect(await data.balance(`liability:user:${fx.seller.id}:available`)).toBe(950000);
    expect(await data.balance(`liability:user:${fx.seller.id}:pending`)).toBe(0);
  });
});
