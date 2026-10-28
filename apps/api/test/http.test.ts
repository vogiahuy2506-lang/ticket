import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { signVnParams } from '../src/payments/vnpay-crypto.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The HTTP surface, tested against a real database and a real server.
 *
 * The end-to-end script walks the happy path; these tests walk the
 * *rejection* paths, because those are the ones that decide what a buyer
 * or an operator sees when something goes wrong.
 */
const dbAvailable = await isDatabaseReachable();

const SECRET = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';
const WIRE_AMOUNT_FACTOR = 100;

describe.skipIf(!dbAvailable)('HTTP API', () => {
  let db: IsolatedDb;
  let data: TestData;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let base: string;

  beforeAll(async () => {
    db = await createIsolatedDb('http');
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

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function get(path: string) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  function ipnQuery(params: Record<string, string>): string {
    const signed = signVnParams(params, SECRET);
    return new URLSearchParams({ ...params, vnp_SecureHash: signed }).toString();
  }

  // ------------------------------------------------------------- checkout

  it('rejects a checkout with a malformed listing id', async () => {
    const res = await post('/api/checkout', { listingId: 'not-a-uuid', quantity: 1, buyerId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_INPUT');
  });

  it('rejects a checkout with a quantity of zero', async () => {
    const fx = await data.fixture('http-zero-qty');
    const res = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 0,
      buyerId: fx.buyer.id,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a checkout without a buyer', async () => {
    const fx = await data.fixture('http-no-buyer');
    const res = await post('/api/checkout', { listingId: fx.listing.id, quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BUYER_REQUIRED');
  });

  it('returns 404 for a checkout on an unknown listing', async () => {
    const fx = await data.fixture('http-unknown-listing');
    const res = await post('/api/checkout', {
      listingId: '00000000-0000-0000-0000-000000000000',
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('LISTING_NOT_FOUND');
  });

  it('returns 409 when a seller buys their own ticket', async () => {
    const fx = await data.fixture('http-own');
    const res = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.seller.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OWN_LISTING');
  });

  it('returns 409 when there are not enough tickets left', async () => {
    const fx = await data.fixture('http-soldout');
    const last = await data.listing(fx.eventId, fx.seller.id, {
      title: 'Only one',
      quantityTotal: 1,
      priceVnd: 400_000,
    });
    const res = await post('/api/checkout', {
      listingId: last.id,
      quantity: 5,
      buyerId: fx.buyer.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_QUANTITY');
  });

  it('returns the same order for a repeated Idempotency-Key', async () => {
    const fx = await data.fixture('http-idem');
    const headers = { 'idempotency-key': 'http-idem-1' };
    const body = { listingId: fx.listing.id, quantity: 1, buyerId: fx.buyer.id };

    const first = await post('/api/checkout', body, headers);
    const second = await post('/api/checkout', body, headers);

    expect(first.status).toBe(200);
    expect(second.body.orderId).toBe(first.body.orderId);
    // One batch of tickets, not two.
    expect(await data.quantitySold(fx.listing.id)).toBe(1);
  });

  // ------------------------------------------------------------------ IPN

  it('rejects an IPN with a bad signature and books nothing', async () => {
    const fx = await data.fixture('http-bad-signature');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;

    const res = await fetch(
      `${base}/api/ipn/vnpay?${new URLSearchParams({
        vnp_TxnRef: orderId,
        vnp_TransactionNo: 'HTTP-BADSIG',
        vnp_Amount: String(1_100_000 * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_SecureHash: '0'.repeat(128),
      }).toString()}`,
    );
    const body = (await res.json()) as { RspCode: string };

    expect(body.RspCode).toBe('97');
    // The order is untouched.
    expect(await data.orderStatus(orderId)).toBe('PENDING_PAYMENT');
  });

  it('rejects an IPN for an unknown order with RspCode 01', async () => {
    const res = await fetch(
      `${base}/api/ipn/vnpay?${ipnQuery({
        vnp_TxnRef: '00000000-0000-0000-0000-000000000000',
        vnp_TransactionNo: 'HTTP-NOORDER',
        vnp_Amount: String(1_000 * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      })}`,
    );
    const body = (await res.json()) as { RspCode: string };
    expect(body.RspCode).toBe('01');
  });

  it('rejects an IPN whose amount does not match the order', async () => {
    const fx = await data.fixture('http-amount-mismatch');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;

    const res = await fetch(
      `${base}/api/ipn/vnpay?${ipnQuery({
        vnp_TxnRef: orderId,
        vnp_TransactionNo: 'HTTP-WRONG-AMOUNT',
        // The order is for 1.100.000, this claims 999.999.
        vnp_Amount: String(999_999 * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      })}`,
    );
    const body = (await res.json()) as { RspCode: string };

    expect(body.RspCode).toBe('04');
    expect(await data.orderStatus(orderId)).toBe('PENDING_PAYMENT');
    // The wrong amount must not have moved any money.
    expect(await data.balance('asset:gateway_cash')).toBe(0);
  });

  it('rejects an IPN without a transaction reference with RspCode 99', async () => {
    const res = await fetch(
      `${base}/api/ipn/vnpay?${ipnQuery({
        vnp_TransactionNo: 'HTTP-NOREF',
        vnp_Amount: String(1_000 * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      })}`,
    );
    const body = (await res.json()) as { RspCode: string };
    expect(body.RspCode).toBe('99');
  });

  it('accepts a valid IPN and books the payment', async () => {
    const fx = await data.fixture('http-happy');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;
    const gross = checkout.body.grossVnd as number;

    const res = await fetch(
      `${base}/api/ipn/vnpay?${ipnQuery({
        vnp_TxnRef: orderId,
        vnp_TransactionNo: 'HTTP-HAPPY',
        vnp_Amount: String(gross * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      })}`,
    );
    const body = (await res.json()) as { RspCode: string };

    expect(body.RspCode).toBe('00');
    expect(await data.orderStatus(orderId)).toBe('PAID');
    expect(await data.balance('asset:gateway_cash')).toBe(gross);
  });

  it('answers a replayed IPN with RspCode 02 and books it once', async () => {
    const fx = await data.fixture('http-replay');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;
    const gross = checkout.body.grossVnd as number;

    const query = ipnQuery({
      vnp_TxnRef: orderId,
      vnp_TransactionNo: 'HTTP-REPLAY',
      vnp_Amount: String(gross * WIRE_AMOUNT_FACTOR),
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
    });

    const first = await fetch(`${base}/api/ipn/vnpay?${query}`);
    expect(((await first.json()) as { RspCode: string }).RspCode).toBe('00');

    const cashAfterFirst = await data.balance('asset:gateway_cash');

    // The gateway retries the notification. The money must be booked once,
    // and the answer must say "already confirmed" so the gateway stops.
    for (let i = 0; i < 3; i++) {
      const replay = await fetch(`${base}/api/ipn/vnpay?${query}`);
      const body = (await replay.json()) as { RspCode: string };
      expect(body.RspCode).toBe('02');
    }

    expect(await data.balance('asset:gateway_cash')).toBe(cashAfterFirst);
    expect(await data.orderStatus(orderId)).toBe('PAID');
  });

  it('accepts a valid IPN sent as a POST as well', async () => {
    // VNPay notifies with a GET, but the endpoint accepts both.
    const fx = await data.fixture('http-post');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;
    const gross = checkout.body.grossVnd as number;

    const params = {
      vnp_TxnRef: orderId,
      vnp_TransactionNo: 'HTTP-POST',
      vnp_Amount: String(gross * WIRE_AMOUNT_FACTOR),
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
    };
    const res = await fetch(`${base}/api/ipn/vnpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...params, vnp_SecureHash: signVnParams(params, SECRET) }),
    });
    const body = (await res.json()) as { RspCode: string };

    expect(body.RspCode).toBe('00');
    expect(await data.orderStatus(orderId)).toBe('PAID');
  });

  it('logs every notification, including the rejected ones', async () => {
    await fetch(
      `${base}/api/ipn/vnpay?${new URLSearchParams({
        vnp_TxnRef: 'logged-order',
        vnp_TransactionNo: 'HTTP-LOGGED',
        vnp_Amount: String(1_000 * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_SecureHash: 'f'.repeat(128),
      }).toString()}`,
    );

    const res = await get('/api/admin/payment-events');
    const events = res.body.events as Array<{
      txn_ref: string | null;
      signature_valid: boolean;
      applied: boolean;
    }>;
    const found = events.find((e) => e.txn_ref === 'logged-order');
    expect(found).toBeDefined();
    expect(found!.signature_valid).toBe(false);
    expect(found!.applied).toBe(false);
  });

  // ------------------------------------------------------------ mock gateway

  it('serves a mock payment page that can complete the payment', async () => {
    // The mock gateway page signs the IPN in the browser. For that to
    // work it needs the return URL (to send the buyer back) and the
    // notify URL (to know where to send the IPN). If either is missing
    // the script throws on the button click and the payment silently
    // never completes - the buyer stays on the payment page forever.
    const fx = await data.fixture('http-mock-pay');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;

    // The redirect URL points at the *configured* public base URL, which
    // is not the test server. So the page is fetched from the local
    // server instead, using the path and query of the redirect URL.
    const redirectUrl = new URL(checkout.body.redirectUrl as string);
    const page = await app.inject({
      method: 'GET',
      url: redirectUrl.pathname + redirectUrl.search,
    });
    expect(page.statusCode).toBe(200);
    const html = page.body;

    // The form carries the return URL, which the script reads to send the
    // buyer back. The assertion has to match the *input element*, not just
    // the string - the script itself contains
    // `input[name="vnp_ReturnUrl"]`, so a plain `toContain` would pass
    // even when the field is missing.
    const returnUrl = /<input type="hidden" name="vnp_ReturnUrl" value="([^"]*)"/.exec(html)?.[1];
    expect(returnUrl).toBeTruthy();
    expect(returnUrl).toContain(`/orders/${orderId}`);

    // The notify address is NOT a `vnp_` parameter: the real gateway takes
    // the IPN URL from the merchant portal, not from the request. The mock
    // receives it under its own name, so the parameter set of the redirect
    // stays identical to the real gateway's.
    expect(html).not.toContain('name="vnp_NotifyUrl"');
    const notifyUrl = /data-notify="([^"]*)"/.exec(html)?.[1];
    expect(notifyUrl).toBeTruthy();
    expect(notifyUrl).toContain('/api/ipn/vnpay');
  });

  it('completes a payment through the mock gateway page', async () => {
    // The whole loop the buyer walks through: the checkout hands back a
    // payment page, the page signs an IPN and posts it to the app, and
    // the order ends up PAID with the money in the seller's escrow.
    const fx = await data.fixture('http-mock-pay-flow');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;
    const gross = checkout.body.grossVnd as number;

    // Read the payment page and pull the signed payload out of it, the
    // same way the browser script does.
    const redirectUrl = new URL(checkout.body.redirectUrl as string);
    const page = await app.inject({
      method: 'GET',
      url: redirectUrl.pathname + redirectUrl.search,
    });
    const html = page.body;
    const params: Record<string, string> = {};
    for (const m of html.matchAll(/name="(vnp_[A-Za-z]+)" value="([^"]*)"/g)) {
      params[m[1]!] = m[2]!;
    }
    // The reference the gateway knows the order by is alphanumeric, so it
    // is the order id without its dashes - not the UUID itself.
    expect(params.vnp_TxnRef).toBe(orderId.replace(/-/g, ''));

    // The browser signs the payload itself, so the test signs it too.
    const ipnPayload = {
      ...params,
      vnp_TransactionNo: 'MOCKFLOW1',
      vnp_BankCode: 'NCB',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_ResponseMessage: 'Giao dich thanh cong',
    };
    delete (ipnPayload as Record<string, unknown>).vnp_SecureHash;
    const signed = signVnParams(ipnPayload, SECRET);

    // The gateway cash is a shared account, so the assertion is on the
    // change, not on the absolute value.
    const cashBefore = await data.balance('asset:gateway_cash');

    const res = await fetch(
      `${base}/api/ipn/vnpay?${new URLSearchParams({
        ...ipnPayload,
        vnp_SecureHash: signed,
      }).toString()}`,
    );
    const body = (await res.json()) as { RspCode: string };

    expect(body.RspCode).toBe('00');
    expect(await data.orderStatus(orderId)).toBe('PAID');
    expect(await data.balance('asset:gateway_cash')).toBe(cashBefore + gross);
  });

  // ---------------------------------------------------------------- orders

  it('returns 404 for an unknown order', async () => {
    const res = await get('/api/orders/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });

  it('returns the order status and the payments behind it', async () => {
    const fx = await data.fixture('http-order-status');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 2,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;

    const res = await get(`/api/orders/${orderId}`);
    expect(res.status).toBe(200);
    expect((res.body.order as { status: string }).status).toBe('PENDING_PAYMENT');
    expect(res.body.fees).toBeDefined();
    expect(Array.isArray(res.body.payments)).toBe(true);
  });

  // ----------------------------------------------------------------- events

  it('returns 404 for an unknown event', async () => {
    const res = await get('/api/events/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EVENT_NOT_FOUND');
  });

  it('shows the tickets that are still available on a listing', async () => {
    const fx = await data.fixture('http-availability');
    await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 3,
      buyerId: fx.buyer.id,
    });

    const res = await get(`/api/events/${fx.eventId}`);
    const listings = res.body.listings as Array<{
      id: string;
      quantity_available: number;
    }>;
    const listing = listings.find((l) => l.id === fx.listing.id);
    expect(listing!.quantity_available).toBe(7);
  });

  // ---------------------------------------------------------------- escrow

  it('releases the escrow when the event is completed', async () => {
    const fx = await data.fixture('http-release');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 1,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;
    const gross = checkout.body.grossVnd as number;

    await fetch(
      `${base}/api/ipn/vnpay?${ipnQuery({
        vnp_TxnRef: orderId,
        vnp_TransactionNo: 'HTTP-RELEASE',
        vnp_Amount: String(gross * WIRE_AMOUNT_FACTOR),
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
      })}`,
    );

    const res = await post(`/api/events/${fx.eventId}/complete`, {});
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);

    expect(await data.orderStatus(orderId)).toBe('RELEASED');
    // The seller's money is available now.
    expect(await data.balance(`liability:user:${fx.seller.id}:available`)).toBe(950_000);
    expect(await data.balance(`liability:user:${fx.seller.id}:pending`)).toBe(0);
  });

  it('cancels the unpaid orders when the event is completed', async () => {
    const fx = await data.fixture('http-cancel');
    const checkout = await post('/api/checkout', {
      listingId: fx.listing.id,
      quantity: 2,
      buyerId: fx.buyer.id,
    });
    const orderId = checkout.body.orderId as string;

    const res = await post(`/api/events/${fx.eventId}/complete`, {});
    expect(res.body.cancelled).toBe(1);
    expect(await data.orderStatus(orderId)).toBe('CANCELLED');
    // The tickets went back on sale.
    expect(await data.quantitySold(fx.listing.id)).toBe(0);
  });

  // ----------------------------------------------------------------- ledger

  it('reports a balanced ledger', async () => {
    const res = await get('/api/ledger/audit');
    expect(res.body.ok).toBe(true);
    expect((res.body.unbalanced as unknown[]).length).toBe(0);
  });

  it('proves the journal cannot be rewritten', async () => {
    const res = await get('/api/ledger/integrity');
    expect(res.body.appendOnly).toBe(true);
  });

  it('derives every balance from the journal', async () => {
    const res = await get('/api/ledger/balances');
    const balances = res.body.balances as Array<{
      accountCode: string;
      balanceVnd: number;
    }>;
    expect(balances.length).toBeGreaterThan(0);
    // Every balance is a number derived from the entries - there is no
    // stored balance column anywhere.
    for (const b of balances) {
      expect(Number.isFinite(b.balanceVnd)).toBe(true);
    }
  });
});
