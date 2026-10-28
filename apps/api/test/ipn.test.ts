import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, handleIpn } from '../src/services/orders.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The gateway notification handler, tested against a real database.
 *
 * The property that matters most here is simple: **every successful
 * payment must be booked**. A notification that is accepted with
 * `RspCode 00` but posts nothing to the ledger means the buyer's money
 * disappeared - the gateway cash did not grow and no liability towards
 * the buyer was created.
 */
const dbAvailable = await isDatabaseReachable();

const GATEWAY_CASH = 'asset:gateway_cash';
const REFUND_PAYABLE = 'liability:refund_payable';

describe.skipIf(!dbAvailable)('handleIpn', () => {
  let db: IsolatedDb;
  let data: TestData;

  beforeAll(async () => {
    db = await createIsolatedDb('ipn');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A successful gateway notification for an order. */
  async function successIpn(orderId: string, amountVnd: number, txnNo: string) {
    return handleIpn(db.sql, {
      orderId,
      amountVnd,
      transactionId: txnNo,
      transactionRef: orderId,
      ok: true,
      code: '00',
      raw: { vnp_TxnRef: orderId, vnp_TransactionNo: txnNo },
    });
  }

  it('books a normal payment into the seller escrow', async () => {
    const fx = await data.fixture('ipn-capture');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    const cashBefore = await data.balance(GATEWAY_CASH);
    const result = await successIpn(order.id, 1_100_000, 'TXN-CAPTURE-1');

    expect(result.status).toBe('PAID');
    expect(result.applied).toBe(true);
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore + 1_100_000);
    expect(await data.balance(`liability:user:${fx.seller.id}:pending`)).toBe(950_000);
  });

  it('never books the same notification twice', async () => {
    const fx = await data.fixture('ipn-idem');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    await successIpn(order.id, 1_100_000, 'TXN-SAME');
    const cashAfterFirst = await data.balance(GATEWAY_CASH);

    // The same notification again - the gateway retries, and the buyer
    // refreshes the page.
    for (let i = 0; i < 3; i++) {
      const replay = await successIpn(order.id, 1_100_000, 'TXN-SAME');
      expect(replay.applied).toBe(false);
    }

    expect(await data.balance(GATEWAY_CASH)).toBe(cashAfterFirst);
  });

  it('books a declined payment as a failure and returns the ticket', async () => {
    const fx = await data.fixture('ipn-decline');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 2,
    });
    expect(await data.quantitySold(fx.listing.id)).toBe(2);

    const cashBefore = await data.balance(GATEWAY_CASH);
    const result = await handleIpn(db.sql, {
      orderId: order.id,
      amountVnd: 2_200_000,
      transactionId: 'TXN-DECLINE',
      ok: false,
      code: '99',
      raw: {},
    });

    expect(result.status).toBe('FAILED');
    // A declined payment moves no money.
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore);
    // ... but the reserved tickets go back on sale.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('refuses a notification whose amount does not match the order', async () => {
    const fx = await data.fixture('ipn-amount');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    const cashBefore = await data.balance(GATEWAY_CASH);
    await expect(
      successIpn(order.id, 999_999, 'TXN-WRONG-AMOUNT'),
    ).rejects.toThrow(/không khớp/);

    // A wrong amount must not move a single dong.
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore);
    expect(await data.orderStatus(order.id)).toBe('PENDING_PAYMENT');
  });

  it('books a late payment as money owed back to the buyer', async () => {
    const fx = await data.fixture('ipn-late');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    // The reservation window passed but the sweep has not run yet.
    await db.sql`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order.id}
    `;

    const cashBefore = await data.balance(GATEWAY_CASH);
    const refundBefore = await data.balance(REFUND_PAYABLE);

    const result = await successIpn(order.id, 1_100_000, 'TXN-LATE');

    expect(result.status).toBe('REFUND_REQUIRED');
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore + 1_100_000);
    expect(await data.balance(REFUND_PAYABLE)).toBe(refundBefore + 1_100_000);
    // The ticket comes back to the market.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('books a payment for an order that was already paid', async () => {
    // The buyer paid once, and then paid a *second* time - a retry at the
    // gateway that produced a new transaction number. The second payment
    // is real money that arrived, so it has to be booked somewhere.
    const fx = await data.fixture('ipn-double-pay');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    await successIpn(order.id, 1_100_000, 'TXN-FIRST');
    const cashAfterFirst = await data.balance(GATEWAY_CASH);
    const refundBefore = await data.balance(REFUND_PAYABLE);

    const result = await successIpn(order.id, 1_100_000, 'TXN-SECOND');

    expect(result.applied).toBe(true);
    // The money must be somewhere: the gateway holds more, and the buyer
    // is owed it back.
    expect(await data.balance(GATEWAY_CASH)).toBe(cashAfterFirst + 1_100_000);
    expect(await data.balance(REFUND_PAYABLE)).toBe(refundBefore + 1_100_000);
  });

  it('books a payment for an order that was already released', async () => {
    // The event was completed and the money was paid out to the seller.
    // A late second payment still has to be booked - the seller must not
    // receive it twice.
    const fx = await data.fixture('ipn-after-release');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    await successIpn(order.id, 1_100_000, 'TXN-BEFORE-RELEASE');
    await db.sql`UPDATE orders SET status = 'RELEASED' WHERE id = ${order.id}`;

    const cashBefore = await data.balance(GATEWAY_CASH);
    const refundBefore = await data.balance(REFUND_PAYABLE);

    const result = await successIpn(order.id, 1_100_000, 'TXN-AFTER-RELEASE');

    expect(result.applied).toBe(true);
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore + 1_100_000);
    expect(await data.balance(REFUND_PAYABLE)).toBe(refundBefore + 1_100_000);
  });

  it('books a payment for an order that was already refunded', async () => {
    const fx = await data.fixture('ipn-after-refund');
    const order = await createOrder(db.sql, {
      buyerId: fx.buyer.id,
      listingId: fx.listing.id,
      quantity: 1,
    });

    await db.sql`
      UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = ${order.id}
    `;
    await successIpn(order.id, 1_100_000, 'TXN-REFUND-1');

    const cashBefore = await data.balance(GATEWAY_CASH);
    const refundBefore = await data.balance(REFUND_PAYABLE);

    const result = await successIpn(order.id, 1_100_000, 'TXN-REFUND-2');

    expect(result.applied).toBe(true);
    expect(await data.balance(GATEWAY_CASH)).toBe(cashBefore + 1_100_000);
    expect(await data.balance(REFUND_PAYABLE)).toBe(refundBefore + 1_100_000);
  });
});
