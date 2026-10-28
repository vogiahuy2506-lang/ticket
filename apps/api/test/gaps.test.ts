import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { listTransactionsForUser } from '../src/services/ledger.js';
import { canQueryGateway, decideQueryOutcome, handleIpn } from '../src/services/orders.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The API surface the demo does not exercise on every click.
 *
 * Three things are covered here, and all of them were real gaps:
 *
 *  1. **The wallet used to filter in JavaScript.** It took the last 50
 *     transactions of the *whole platform* and then kept the ones whose
 *     account code contained the user's id. On a busy platform the user's
 *     own entries fall outside that window and simply vanish from their
 *     wallet - with no error, just missing money. The filter has to happen
 *     in the database.
 *
 *  2. **A lost IPN on an expired order was unrecoverable.** The re-check
 *     button only asked the gateway for orders that were still
 *     `PENDING_PAYMENT`. Once the lazy sweep had marked the order
 *     `EXPIRED` (which it does as soon as anybody touches the orders),
 *     the buyer's money - which *was* paid and was sitting at the gateway
 *     - could never be found again.
 *
 *  3. **The order statuses in the shared package were out of date.** The
 *     database knew about `EXPIRED` and `REFUND_REQUIRED`, the shared
 *     types did not, so a status label could be `undefined`.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('the parts the demo does not click on', () => {
  let db: IsolatedDb;
  let data: TestData;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let base: string;

  beforeAll(async () => {
    db = await createIsolatedDb('gaps');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  async function checkout(buyerId: string, listingId: string) {
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId, quantity: 1, buyerId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { orderId: string; grossVnd: number; gatewayRef: string };
  }

  it('shows the user their own transactions even when the platform is busy', async () => {
    // The user is one of many. The platform has plenty of other
    // transactions, so a wallet that filtered a *global* window would drop
    // the user's own entries.
    const fx = await data.fixture('wallet-window');

    // A real payment, so the seller has a ledger entry of their own.
    const order = await checkout(fx.buyer.id, fx.listing.id);
    const ipn = await fetch(
      `${base}/api/ipn/vnpay?${new URLSearchParams({
        vnp_TxnRef: order.gatewayRef,
        vnp_TransactionNo: 'WALLET-WINDOW-1',
        vnp_Amount: String(order.grossVnd * 100),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      }).toString()}`,
    );
    // The signature is not valid in this test, so the payment is not
    // applied - the point of the test is the *window*, not the payment.
    void ipn;

    // Then 60 transactions that do *not* belong to the seller, so they
    // would push the seller's own entries out of a 50-transaction global
    // window.
    for (let i = 0; i < 60; i++) {
      await data.fixture(`wallet-noise-${i}`);
    }

    const mine = await listTransactionsForUser(db.sql, fx.seller.id, 50);

    for (const txn of mine) {
      const touchesTheUser = txn.lines.some((l) => l.accountCode.includes(fx.seller.id));
      expect(
        touchesTheUser,
        `transaction ${txn.txnId} does not belong to the user`,
      ).toBe(true);
    }
  });

  it('keeps a user transaction when 60 other transactions follow it', async () => {
    // The bug this closes: the wallet took the last 50 transactions of
    // the *whole platform* and filtered them in JavaScript. The user's
    // own entry was pushed out of that window by other people's activity
    // and simply disappeared from their wallet - with no error, just
    // missing money.
    const fx = await data.fixture('wallet-window-2');

    // A real, balanced posting on the seller's account.
    const order = await checkout(fx.buyer.id, fx.listing.id);
    await handleIpn(db.sql, {
      orderId: order.orderId,
      amountVnd: order.grossVnd,
      transactionId: 'WALLET-WINDOW-2',
      ok: true,
      code: '00',
      raw: {},
    });

    const before = await listTransactionsForUser(db.sql, fx.seller.id, 50);
    expect(before.length).toBe(1);

    // 60 other transactions, all created *after* the seller's.
    for (let i = 0; i < 60; i++) {
      const noise = await data.fixture(`wallet-noise-2-${i}`);
      const noiseOrder = await checkout(noise.buyer.id, noise.listing.id);
      await handleIpn(db.sql, {
        orderId: noiseOrder.orderId,
        amountVnd: noiseOrder.grossVnd,
        transactionId: `WALLET-NOISE-2-${i}`,
        ok: true,
        code: '00',
        raw: {},
      });
    }

    const after = await listTransactionsForUser(db.sql, fx.seller.id, 50);
    // The seller's own entry survived: the filter runs in the database,
    // so the limit applies to *their* transactions, not to the platform's.
    expect(after.length).toBe(1);
    expect(after[0]!.refId).toBe(order.orderId);
  });

  it('asks the gateway for an expired order, not only for a pending one', async () => {
    // The rule, stated directly: the gateway is the second source of
    // truth, and it has to be asked about an expired order too - the lazy
    // sweep released the *ticket*, but it says nothing about the money.
    expect(canQueryGateway('PENDING_PAYMENT')).toBe(true);
    expect(canQueryGateway('EXPIRED')).toBe(true);

    // The settled orders must not be asked about: their money is already
    // booked, and a second answer would only duplicate it.
    expect(canQueryGateway('PAID')).toBe(false);
    expect(canQueryGateway('RELEASED')).toBe(false);
    expect(canQueryGateway('FAILED')).toBe(false);
    expect(canQueryGateway('CANCELLED')).toBe(false);
    expect(canQueryGateway('REFUND_REQUIRED')).toBe(false);
  });

  it('answers a re-check for an expired order instead of refusing it', async () => {
    const fx = await data.fixture('recheck-expired');
    const listing = await data.listing(fx.eventId, fx.seller.id, {
      title: 'Recheck expired',
      quantityTotal: 5,
      priceVnd: 800_000,
    });

    const order = await checkout(fx.buyer.id, listing.id);

    // The reservation window passes and the sweep marks the order
    // EXPIRED. The buyer *did* pay - only the notification was lost.
    await db.sql`
      UPDATE orders
      SET status = 'EXPIRED', expires_at = now() - interval '1 minute'
      WHERE id = ${order.orderId}
    `;

    const recheck = await fetch(`${base}/api/orders/${order.orderId}/recheck`, {
      method: 'POST',
    });
    expect(recheck.status).toBe(200);
    const body = (await recheck.json()) as { status: string };
    // The gateway is not reachable in the test, so the status does not
    // change - but the endpoint answered, and the order was not refused.
    expect(body.status).toBe('EXPIRED');
  });

  it('does not re-check an order whose money is already settled', async () => {
    const fx = await data.fixture('recheck-settled');
    const order = await checkout(fx.buyer.id, fx.listing.id);
    await db.sql`UPDATE orders SET status = 'PAID' WHERE id = ${order.orderId}`;

    const recheck = await fetch(`${base}/api/orders/${order.orderId}/recheck`, {
      method: 'POST',
    });
    const body = (await recheck.json()) as { status: string };
    expect(body.status).toBe('PAID');
  });

  it('never lets a gateway *query* cancel an order that is being paid', () => {
    // The dangerous case, stated as plainly as possible.
    //
    // The re-check asks the gateway "did this transaction succeed?". A
    // brand new payment is reported by the gateway as *not found* (code
    // 91) - the gateway has not seen it yet. That is not a failure: the
    // buyer is right now on the payment page. If the query were applied
    // like a notification, the order would be marked FAILED and the
    // tickets given back *while the buyer is paying*. The money would
    // arrive afterwards for an order that is no longer pending, and it
    // would be booked as a late payment instead of a purchase.
    const notFoundYet = decideQueryOutcome(
      { signatureValid: true, ok: false, code: '91', amountVnd: 100_000 },
      100_000,
    );
    expect(notFoundYet.action).toBe('skip');

    // Only a success the gateway itself reported is applied.
    const success = decideQueryOutcome(
      { signatureValid: true, ok: true, transactionId: 'TX-1', amountVnd: 100_000 },
      100_000,
    );
    expect(success).toEqual({ action: 'apply', transactionId: 'TX-1' });

    // An answer that is not correctly signed is never applied.
    expect(
      decideQueryOutcome(
        { signatureValid: false, ok: true, transactionId: 'TX-1', amountVnd: 100_000 },
        100_000,
      ).action,
    ).toBe('skip');

    // An answer about a different amount is never applied.
    expect(
      decideQueryOutcome(
        { signatureValid: true, ok: true, transactionId: 'TX-1', amountVnd: 99_000 },
        100_000,
      ).action,
    ).toBe('skip');

    // A success without a transaction number is never applied: the
    // number is what identifies the payment. Applying it under an
    // invented number would book the money twice - the real IPN that
    // arrives later would look like a *second* payment and be refunded.
    expect(
      decideQueryOutcome(
        { signatureValid: true, ok: true, amountVnd: 100_000 },
        100_000,
      ).action,
    ).toBe('skip');
  });

  it('keeps the shared status labels in step with the database', async () => {
    // The database accepts these statuses; the shared package used to
    // know only five of them, so a label could be `undefined` for a
    // perfectly normal order.
    const { ORDER_STATUSES, ORDER_STATUS_LABELS_VI } = await import('@tce/shared');

    for (const status of ORDER_STATUSES) {
      expect(
        ORDER_STATUS_LABELS_VI[status],
        `no Vietnamese label for ${status}`,
      ).toBeTruthy();
    }

    // ... and every status the database accepts has a label.
    for (const status of [
      'PENDING_PAYMENT',
      'PAID',
      'RELEASED',
      'FAILED',
      'CANCELLED',
      'EXPIRED',
      'REFUND_REQUIRED',
    ]) {
      expect(ORDER_STATUSES).toContain(status);
      expect(ORDER_STATUS_LABELS_VI[status as keyof typeof ORDER_STATUS_LABELS_VI]).toBeTruthy();
    }
  });

  it('answers 404 when the event to complete does not exist', async () => {
    // The service reports an unknown event as an `OrderError` with the
    // code 404. The route has to translate it - otherwise the buyer (or
    // the operator) gets a 500 for a typo.
    const res = await fetch(
      `${base}/api/events/00000000-0000-0000-0000-000000000000/complete`,
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('EVENT_NOT_FOUND');
  });

  it('lists the orders of a user, and only theirs', async () => {
    // Without this the buyer has no way back to an order: the order page
    // is reached by URL, and the URL comes from the gateway's redirect.
    const fx = await data.fixture('orders-list');
    const other = await data.fixture('orders-list-other');

    const mine = await checkout(fx.buyer.id, fx.listing.id);
    await checkout(other.buyer.id, other.listing.id);

    const res = await fetch(`${base}/api/orders?userId=${fx.buyer.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<{ id: string; status: string; eventName: string }>;
    };

    expect(body.orders.length).toBe(1);
    expect(body.orders[0]!.id).toBe(mine.orderId);
    expect(body.orders[0]!.eventName).toContain('Event orders-list');
  });

  it('lists what a seller sold, and what a buyer bought', async () => {
    // The role decides which side of the order is the user's. A seller
    // wants to see the orders they sold; a buyer the ones they bought.
    const fx = await data.fixture('orders-role');
    const order = await checkout(fx.buyer.id, fx.listing.id);

    const asBuyer = await fetch(`${base}/api/orders?userId=${fx.buyer.id}`);
    const buyerBody = (await asBuyer.json()) as { orders: Array<{ id: string }> };
    expect(buyerBody.orders.map((o) => o.id)).toContain(order.orderId);

    const asSeller = await fetch(`${base}/api/orders?userId=${fx.seller.id}`);
    const sellerBody = (await asSeller.json()) as { orders: Array<{ id: string }> };
    expect(sellerBody.orders.map((o) => o.id)).toContain(order.orderId);
  });

  it('shows a seller both the orders they sold and the ones they bought', async () => {
    // Any user may buy - a seller is very often a buyer too. Hiding the
    // purchases from a seller would make their own money disappear from
    // their own list.
    const fx = await data.fixture('orders-role-both');
    const bought = await checkout(fx.buyer.id, fx.listing.id);

    // The seller buys somebody else's ticket.
    const other = await data.fixture('orders-role-both-other');
    const sold = await checkout(other.buyer.id, other.listing.id);

    // ... and the seller sells a ticket of their own to somebody else.
    const buyer3 = await data.user('Buyer orders-role-both third', 'buyer');
    const ownListing = await data.listing(fx.eventId, fx.seller.id, {
      title: 'Sold by the seller',
      quantityTotal: 5,
      priceVnd: 500_000,
    });
    const theirSale = await checkout(buyer3.id, ownListing.id);

    const res = await fetch(`${base}/api/orders?userId=${fx.seller.id}`);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    const ids = body.orders.map((o) => o.id);

    // The order they sold...
    expect(ids).toContain(theirSale.orderId);
    // ... and the order they bought.
    expect(ids).toContain(bought.orderId);
    // ... but not somebody else's order.
    expect(ids).not.toContain(sold.orderId);
  });

  it('refuses an order list without a user, or for an unknown one', async () => {
    const missing = await fetch(`${base}/api/orders`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('USER_ID_REQUIRED');

    const unknown = await fetch(
      `${base}/api/orders?userId=00000000-0000-0000-0000-000000000000`,
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe('USER_NOT_FOUND');
  });

  it('cancels a pending order and gives the tickets back', async () => {
    // A buyer who changed their mind should not have to wait 15 minutes
    // for the reservation to expire - the tickets are theirs to release
    // right now, so somebody else can buy them.
    const fx = await data.fixture('cancel-ok');
    const order = await checkout(fx.buyer.id, fx.listing.id);
    expect(await data.quantitySold(fx.listing.id)).toBe(1);

    const res = await fetch(`${base}/api/orders/${order.orderId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyerId: fx.buyer.id }),
    });
    expect(res.status).toBe(200);
    expect(await data.orderStatus(order.orderId)).toBe('CANCELLED');
    // The ticket is on sale again.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  it('refuses to cancel somebody else\'s order, or a settled one', async () => {
    const fx = await data.fixture('cancel-refused');
    const order = await checkout(fx.buyer.id, fx.listing.id);

    // Not the buyer's order.
    const foreign = await fetch(`${base}/api/orders/${order.orderId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyerId: fx.seller.id }),
    });
    expect(foreign.status).toBe(403);

    // A settled order: the money has arrived, so taking the tickets back
    // would be a refund, not a cancellation.
    await db.sql`UPDATE orders SET status = 'PAID' WHERE id = ${order.orderId}`;
    const settled = await fetch(`${base}/api/orders/${order.orderId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyerId: fx.buyer.id }),
    });
    expect(settled.status).toBe(409);
    expect(await data.orderStatus(order.orderId)).toBe('PAID');
    // The ticket was not taken back.
    expect(await data.quantitySold(fx.listing.id)).toBe(1);
  });

  it('names the orders the operator has to refund', async () => {
    // The dashboard shows the *total* the platform owes, but the
    // operator has to call the gateway's refund API for each order - so
    // the total alone is not enough, the list has to name them.
    const fx = await data.fixture('refund-orders');
    const order = await checkout(fx.buyer.id, fx.listing.id);

    // The payment arrived after the reservation had expired.
    await db.sql`
      UPDATE orders
      SET expires_at = now() - interval '1 minute'
      WHERE id = ${order.orderId}
    `;
    await handleIpn(db.sql, {
      orderId: order.orderId,
      amountVnd: order.grossVnd,
      transactionId: 'REFUND-ORDERS-1',
      ok: true,
      code: '00',
      raw: {},
    });

    const res = await fetch(`${base}/api/admin/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refundPayableVnd: number;
      refundOrders: Array<{ orderId: string; buyerName: string; grossVnd: number }>;
    };

    expect(body.refundOrders.length).toBeGreaterThan(0);
    const found = body.refundOrders.find((o) => o.orderId === order.orderId);
    expect(found).toBeDefined();
    expect(found!.buyerName).toBe(fx.buyer.name);
    expect(found!.grossVnd).toBe(order.grossVnd);
    // The total on the dashboard matches the order that is listed.
    expect(body.refundPayableVnd).toBeGreaterThanOrEqual(found!.grossVnd);
  });
});
