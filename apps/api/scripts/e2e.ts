/**
 * End-to-end smoke test of the money flow against a running stack.
 *
 * It exercises the exact path a real buyer takes:
 *   1. create an order (checkout)
 *   2. the gateway calls back the IPN endpoint (simulated here with a valid
 *      signature - the same code path VNPay uses)
 *   3. the same IPN is replayed to prove idempotency
 *   4. the event is marked as completed -> escrow is released
 *   5. every balance is read back from the ledger and the invariants are
 *      asserted
 *
 * Usage:
 *   npm run e2e -w @tce/api
 *
 * By default the runner boots its own API server on an ephemeral port, so the
 * check needs nothing but a reachable database. Set E2E_EXTERNAL=1 to run the
 * assertions against an already-running stack instead.
 */

import crypto from 'node:crypto';
import { computeFees } from '@tce/shared';
import { getSql } from '../src/db/client.js';
import { signVnParams } from '../src/payments/vnpay-crypto.js';

const SECRET = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';

/**
 * Direct database access.
 *
 * The assertions normally go through the HTTP API, but a few of them have
 * to put the database into a state that cannot be reached from outside -
 * for example an order whose reservation has expired. Writing that state
 * directly is the honest way to test it.
 */
const sql = getSql();

/** The API base URL. Set by the runner before the assertions start. */
let API = process.env.API_BASE_URL ?? 'http://localhost:3001';

export function setApiBase(url: string): void {
  API = url.replace(/\/$/, '');
}

/**
 * The fixture this run works on. The runner provisions a brand new event and
 * listing and hands the ids over, so the assertions never depend on which
 * event happens to be first in the list. Without this, a second run would
 * pick up an event left over from a previous run and the balance deltas
 * would not line up.
 */
let FIXTURE: { eventId: string; listingId: string } | null = null;

export function setFixture(ids: { eventId: string; listingId: string }): void {
  FIXTURE = ids;
}

export function getFixture(): { eventId: string; listingId: string } | null {
  return FIXTURE;
}

/**
 * The exact signing algorithm of the gateway: HMAC-SHA512 over the
 * alphabetically sorted, URL-encoded `key=value` list.
 *
 * The test signs its own IPN payloads instead of asking the API to sign
 * them, so it proves the server verifies a signature it did not produce.
 */
function sign(params: Record<string, string>): string {
  return signVnParams(params, SECRET);
}

/**
 * The gateway multiplies every amount by 100 on the wire.
 */
const WIRE_AMOUNT_FACTOR = 100;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ok - ${message}`);
}

export async function runAssertions(): Promise<void> {
  console.log(`E2E against ${API}\n`);

  // ---------------------------------------------------------------- setup
  const { users } = await json<{ users: Array<{ id: string; name: string; role: string }> }>(
    '/api/users',
  );
  const buyer = users.find((u) => u.role === 'buyer')!;

  const { events } = await json<{ events: Array<{ id: string; name: string; status: string }> }>(
    '/api/events',
  );
  // Use the fixture the runner provisioned. It is always a fresh, scheduled
  // event, so the assertions are independent of what the seed data or a
  // previous run left behind. When the runner is used the exact ids are
  // handed over; the fallback below only matters when the assertions are
  // run against an already-running stack.
  const fixture = getFixture();
  const e2eEvents = events.filter((e) => e.name.startsWith('E2E event'));
  const event =
    (fixture && events.find((e) => e.id === fixture.eventId)) ??
    e2eEvents.find((e) => e.status === 'scheduled') ??
    events.find((e) => e.status === 'scheduled') ??
    e2eEvents[0] ??
    events[0];
  if (!event) {
    throw new Error('No events in the database - run `npm run db:init` first');
  }
  console.log(`event=${event.name} (status=${event.status})`);
  const { listings } = await json<{
    listings: Array<{
      id: string;
      title: string;
      price_vnd: string;
      quantity_sold: number;
      quantity_available: number;
      seller_id: string;
    }>;
  }>(`/api/events/${event.id}`);
  const listing =
    (fixture && listings.find((l) => l.id === fixture.listingId)) ??
    listings.find((l) => l.title === 'E2E listing') ??
    listings[0];
  if (!listing) {
    throw new Error('No listing on the E2E event');
  }
  // The seller of the listing is the one whose money moves, so the
  // assertions must follow the listing, not a hard-coded user.
  const seller = users.find((u) => u.id === listing.seller_id)!;
  if (!seller) {
    throw new Error(`Listing ${listing.id} has an unknown seller`);
  }
  const price = Number(listing.price_vnd);
  const quantity = 2;
  console.log(`listing=${listing.title} price=${price} x${quantity} seller=${seller.name}\n`);

  // ------------------------------------------------------------- checkout
  const idemKey = `e2e-${Date.now()}`;
  const checkout = await json<{
    orderId: string;
    gatewayRef: string;
    redirectUrl: string;
    grossVnd: number;
  }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': idemKey },
      body: JSON.stringify({ listingId: listing.id, quantity, buyerId: buyer.id }),
    },
  );
  const orderId = checkout.orderId;
  const gatewayRef = checkout.gatewayRef;
  console.log(`order ${orderId} created, redirect -> ${checkout.redirectUrl.slice(0, 90)}...`);

  // The reference the gateway knows the order by is alphanumeric, so it is
  // not the order's UUID - the notification carries it instead.
  assert(
    gatewayRef === orderId.replace(/-/g, ''),
    'the gateway reference is the order id without its dashes',
  );
  assert(
    /^[a-z0-9]+$/.test(gatewayRef),
    'the gateway reference is alphanumeric, as the parameter table requires',
  );

  const expectedSubtotal = price * quantity;
  const expectedBuyerFee = Math.round((expectedSubtotal * 10) / 100);
  const expectedSellerFee = Math.round((expectedSubtotal * 5) / 100);
  const expectedGross = expectedSubtotal + expectedBuyerFee;
  const expectedSellerNet = expectedSubtotal - expectedSellerFee;

  assert(checkout.grossVnd === expectedGross, `buyer pays ${expectedGross} (subtotal + 10%)`);

  const before = await json<{ order: { status: string } }>(`/api/orders/${orderId}`);
  assert(before.order.status === 'PENDING_PAYMENT', 'order starts as PENDING_PAYMENT');

  // ------------------------------------------- checkout idempotency
  // The same Idempotency-Key must return the SAME order, not create a
  // second one (a double-tapped "Pay" button).
  const replayCheckout = await json<{ orderId: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': idemKey },
      body: JSON.stringify({ listingId: listing.id, quantity, buyerId: buyer.id }),
    },
  );
  assert(
    replayCheckout.orderId === orderId,
    'replaying the checkout with the same Idempotency-Key returns the same order',
  );

  // Snapshot the balances *before* the payment so the assertions below are
  // deltas. That way the script can be run repeatedly against a database
  // that already holds data from previous runs.
  const balancesBefore = await json<{
    balances: Array<{ accountCode: string; balanceVnd: number }>;
  }>('/api/ledger/balances');
  const beforeByCode = new Map(
    balancesBefore.balances.map((b) => [b.accountCode, b.balanceVnd]),
  );
  const pendingBefore = beforeByCode.get(`liability:user:${seller.id}:pending`) ?? 0;
  const availableBefore = beforeByCode.get(`liability:user:${seller.id}:available`) ?? 0;
  const feeBefore = beforeByCode.get('revenue:platform_fee') ?? 0;
  const cashBefore = beforeByCode.get('asset:gateway_cash') ?? 0;

  // ------------------------------------------------------------------ IPN
  // The payload follows the real wire format: the amount is multiplied by
  // 100, a successful payment has both the response code and the transaction
  // status set to '00', and the notification arrives as a GET request.
  const payload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(expectedGross * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: gatewayRef,
    vnp_OrderInfo: `Thanh toan don hang ${orderId.slice(0, 8)}`,
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2E${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  payload.vnp_SecureHash = sign(payload);

  const ipnRes = await fetch(
    `${API}/api/ipn/vnpay?${new URLSearchParams(payload).toString()}`,
    { method: 'GET' },
  );
  const ipnBody = (await ipnRes.json()) as { RspCode: string };
  assert(ipnBody.RspCode === '00', 'IPN accepted (RspCode 00)');

  const paid = await json<{ order: { status: string } }>(`/api/orders/${orderId}`);
  assert(paid.order.status === 'PAID', 'order is PAID after the IPN');

  // ------------------------------------------------- idempotent replay x3
  // The gateway retries a notification it did not get an answer for. The
  // money must be booked exactly once, and the answer must be `02`
  // ("already confirmed") so the gateway stops retrying.
  for (let i = 0; i < 3; i++) {
    const replayRes = await fetch(
      `${API}/api/ipn/vnpay?${new URLSearchParams(payload).toString()}`,
      { method: 'GET' },
    );
    const replayBody = (await replayRes.json()) as { RspCode: string };
    assert(
      replayBody.RspCode === '02',
      'a replayed IPN is answered with RspCode 02 (already confirmed)',
    );
  }
  console.log('  ... replayed the same IPN 3 times');

  // ------------------------------------------------------- ledger check
  const { balances } = await json<{
    balances: Array<{ accountCode: string; balanceVnd: number }>;
  }>('/api/ledger/balances');
  const byCode = new Map(balances.map((b) => [b.accountCode, b.balanceVnd]));

  const pending = byCode.get(`liability:user:${seller.id}:pending`) ?? 0;
  const available = byCode.get(`liability:user:${seller.id}:available`) ?? 0;
  const fee = byCode.get('revenue:platform_fee') ?? 0;
  const cash = byCode.get('asset:gateway_cash') ?? 0;

  assert(
    pending === pendingBefore + expectedSellerNet,
    `seller pending balance grew by ${expectedSellerNet} (money is escrowed, not available)`,
  );
  assert(
    available === availableBefore,
    'seller available balance did not change before the event ends',
  );
  assert(
    fee === feeBefore + expectedBuyerFee + expectedSellerFee,
    `platform kept ${expectedBuyerFee + expectedSellerFee} (10% + 5%)`,
  );
  assert(cash === cashBefore + expectedGross, `gateway holds ${expectedGross} more`);

  const audit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(audit.ok, 'every ledger transaction is balanced (debit == credit)');

  // ------------------------------------------- the replay booked nothing
  // The IPN was sent 4 times in total. The ledger must contain exactly ONE
  // capture for this order, so the balances above are the proof.
  const txnCount = await json<{ transactions: Array<{ refId: string | null }> }>(
    '/api/ledger/transactions',
  );
  const capturesForOrder = txnCount.transactions.filter(
    (t) => t.refId === orderId && t.refType === 'PAYMENT_CAPTURE',
  );
  assert(
    capturesForOrder.length === 1,
    `the replayed IPN booked the money exactly once (found ${capturesForOrder.length})`,
  );

  // -------------------------------------------- a declined payment
  // A valid notification that reports a *failed* payment must still be
  // applied: the order becomes FAILED and the reserved tickets go back to
  // the listing. Dropping it would strand those tickets forever - a real
  // bug that only shows up when the buyer declines at the gateway.
  const soldBeforeDecline = (
    await json<{ listings: Array<{ id: string; quantity_sold: number }> }>(
      `/api/events/${event.id}`,
    )
  ).listings.find((l) => l.id === listing.id)?.quantity_sold;

  const declineCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-decline-${Date.now()}` },
      body: JSON.stringify({ listingId: listing.id, quantity: 1, buyerId: buyer.id }),
    },
  );
  const declineOrderId = declineCheckout.orderId;

  const declinedPayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(declineCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: declineCheckout.gatewayRef,
    vnp_OrderInfo: `Thanh toan don hang ${declineOrderId.slice(0, 8)}`,
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2EFAIL${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '99',
    vnp_TransactionStatus: '99',
    vnp_ResponseMessage: 'Giao dich bi huy',
  };
  declinedPayload.vnp_SecureHash = sign(declinedPayload);

  const declineRes = await fetch(
    `${API}/api/ipn/vnpay?${new URLSearchParams(declinedPayload).toString()}`,
    { method: 'GET' },
  );
  const declineBody = (await declineRes.json()) as { RspCode: string };
  assert(
    declineBody.RspCode === '00',
    'a declined payment is still a valid notification (accepted, not dropped)',
  );

  const declinedOrder = await json<{ order: { status: string } }>(
    `/api/orders/${declineOrderId}`,
  );
  assert(declinedOrder.order.status === 'FAILED', 'a declined payment marks the order FAILED');

  // The ticket that was reserved for the declined order must be back on the
  // listing - otherwise the stock leaks away with every failed payment.
  const listingAfterDecline = await json<{
    listings: Array<{ id: string; quantity_sold: number }>;
  }>(`/api/events/${event.id}`);
  const soldAfterDecline = listingAfterDecline.listings.find(
    (l) => l.id === listing.id,
  )?.quantity_sold;
  assert(
    soldAfterDecline === soldBeforeDecline,
    'a declined payment returns the reserved ticket to the listing',
  );

  // --------------------------------------- a successful retry after a decline
  // The buyer declined at the gateway and then paid successfully on a retry
  // (a new transaction number, so the idempotency key does not match).
  // The order is already FAILED, but the buyer *did* pay this time, so the
  // money must be booked - as money owed back to the buyer, because the
  // tickets went back to the listing after the decline.
  //
  // Before the fix the notification was accepted (RspCode 00) but nothing
  // was posted to the ledger: the buyer's money simply disappeared.
  const retryCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>('/api/checkout', {
    method: 'POST',
    headers: { 'idempotency-key': `e2e-retry-${Date.now()}` },
    body: JSON.stringify({ listingId: listing.id, quantity: 1, buyerId: buyer.id }),
  });
  const retryDeclinePayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(retryCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: retryCheckout.gatewayRef,
    vnp_OrderInfo: 'decline then retry',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2ERETRYFAIL${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '99',
    vnp_TransactionStatus: '99',
    vnp_ResponseMessage: 'Giao dich bi huy',
  };
  retryDeclinePayload.vnp_SecureHash = sign(retryDeclinePayload);
  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(retryDeclinePayload).toString()}`, {
    method: 'GET',
  });

  const refundBefore = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;

  const retrySuccessPayload: Record<string, string> = {
    ...retryDeclinePayload,
    vnp_TransactionNo: `E2ERETRYOK${Date.now()}`,
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  delete retrySuccessPayload.vnp_SecureHash;
  retrySuccessPayload.vnp_SecureHash = sign(retrySuccessPayload);

  const retryRes = await fetch(
    `${API}/api/ipn/vnpay?${new URLSearchParams(retrySuccessPayload).toString()}`,
    { method: 'GET' },
  );
  const retryBody = (await retryRes.json()) as { RspCode: string };
  assert(retryBody.RspCode === '00', 'a successful retry is accepted');

  const refundAfter = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;
  assert(
    refundAfter === refundBefore + retryCheckout.grossVnd,
    `a successful retry books the money as owed to the buyer (${retryCheckout.grossVnd})`,
  );

  const retryAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(retryAudit.ok, 'the ledger is still balanced after the successful retry');

  // ------------------------------------- a lost notification (the fallback)
  // The buyer paid, but the notification never arrived - the tunnel was
  // down, the IPN URL was not registered, the gateway could not reach us.
  // The order stays PENDING_PAYMENT and the money is sitting at the
  // gateway with nobody looking for it.
  //
  // The gateway *remembers* the payment, so the app can ask it and
  // recover it. This is the whole point of the `querydr` fallback, and it
  // can only be proven if the mock gateway keeps a registry - which it
  // now does.
  const lostCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-lost-${Date.now()}` },
      body: JSON.stringify({ listingId: listing.id, quantity: 1, buyerId: buyer.id }),
    },
  );

  // The gateway accepts the payment - but the notification is dropped.
  await fetch(`${API}/mock-pay/register?${new URLSearchParams({
    vnp_TxnRef: lostCheckout.gatewayRef,
    vnp_Amount: String(lostCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_TransactionNo: `E2ELOST${Date.now()}`,
    vnp_TransactionStatus: '00',
    vnp_ResponseCode: '00',
  }).toString()}`, { method: 'POST' });

  const lostBefore = await json<{ order: { status: string } }>(
    `/api/orders/${lostCheckout.orderId}`,
  );
  assert(
    lostBefore.order.status === 'PENDING_PAYMENT',
    'the order waits for its notification (the notification was lost)',
  );

  // The buyer presses "check the status again": the app asks the gateway
  // and recovers the payment.
  const recheck = await json<{ status: string }>(
    `/api/orders/${lostCheckout.orderId}/recheck?gateway=1`,
    { method: 'POST' },
  );
  assert(
    recheck.status === 'PAID',
    'the gateway query recovers the payment whose notification was lost',
  );

  const lostAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(lostAudit.ok, 'the ledger is still balanced after the recovered payment');

  // The recovered money is in escrow, not owed back to the buyer - the
  // buyer did get their ticket.
  const lostRefund = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;
  assert(
    lostRefund === refundAfter,
    'the recovered payment is escrowed, not refunded (the buyer has the ticket)',
  );

  // ------------------------- a late payment that arrives before the sweep
  // The same late-payment case, but the lazy sweep has NOT run yet: the
  // reservation window has passed while the order is still PENDING_PAYMENT.
  // The sweep only ever touches PENDING_PAYMENT orders, so once the order
  // becomes REFUND_REQUIRED nobody would ever give the ticket back - the
  // stock would leak away with every late payment.
  //
  // The sweep runs on checkout and on the event/listing reads, so this test
  // must not call any of those between expiring the order and sending the
  // notification.
  const leakCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>('/api/checkout', {
    method: 'POST',
    headers: { 'idempotency-key': `e2e-leak-${Date.now()}` },
    body: JSON.stringify({ listingId: listing.id, quantity: 1, buyerId: buyer.id }),
  });

  const soldBeforeLeak = (
    await sql`
      SELECT quantity_sold FROM listings WHERE id = ${listing.id}
    `
  )[0]!.quantity_sold as unknown as number;

  // Expire the reservation without letting the sweep run.
  await sql`
    UPDATE orders SET expires_at = now() - interval '1 minute'
    WHERE id = ${leakCheckout.orderId}
  `;

  const leakPayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(leakCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: leakCheckout.gatewayRef,
    vnp_OrderInfo: 'late payment without sweep',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2ELEAK${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  leakPayload.vnp_SecureHash = sign(leakPayload);

  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(leakPayload).toString()}`, {
    method: 'GET',
  });

  const leakOrder = await json<{ order: { status: string } }>(
    `/api/orders/${leakCheckout.orderId}`,
  );
  assert(
    leakOrder.order.status === 'REFUND_REQUIRED',
    'a late payment before the sweep becomes REFUND_REQUIRED',
  );

  const soldAfterLeak = (
    await sql`
      SELECT quantity_sold FROM listings WHERE id = ${listing.id}
    `
  )[0]!.quantity_sold as unknown as number;
  assert(
    soldAfterLeak === soldBeforeLeak - 1,
    'a late payment before the sweep returns the reserved ticket to the listing',
  );

  // ----------------------------------------------------- own listing
  // A seller must not be able to buy their own ticket. This runs while the
  // event is still scheduled, so the rejection really is about the listing
  // and not about the event being closed.
  const sellerOwnCheckout = await fetch(`${API}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      listingId: listing.id,
      quantity: 1,
      buyerId: seller.id,
    }),
  });
  assert(
    sellerOwnCheckout.status === 409,
    'a seller cannot buy their own listing (409)',
  );

  // ------------------------------------------------- late payment / refund
  // The buyer paid, but the ticket reservation had already expired and the
  // tickets were sold to somebody else. The seller must not get the money,
  // but the buyer did pay - so the amount becomes a liability towards them.
  //
  // This has to happen while the event is still scheduled: a completed event
  // refuses new checkouts.
  const lateCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>('/api/checkout', {
    method: 'POST',
    headers: { 'idempotency-key': `e2e-late-${Date.now()}` },
    body: JSON.stringify({ listingId: listing.id, quantity: 1, buyerId: buyer.id }),
  });

  // Force the reservation to expire.
  await sql`
    UPDATE orders SET expires_at = now() - interval '1 minute'
    WHERE id = ${lateCheckout.orderId}
  `;

  // The lazy sweep marks the order EXPIRED and gives the tickets back.
  // A payment that arrives *after* that sweep must still be handled - the
  // buyer paid, so the money must not disappear.
  await json<{ expired: number }>('/api/events');
  const swept = await json<{ order: { status: string } }>(
    `/api/orders/${lateCheckout.orderId}`,
  );
  assert(
    swept.order.status === 'EXPIRED',
    'the lazy sweep expires the abandoned reservation',
  );

  // The sweep gave the ticket back, so this is the count the payment must
  // not change: the buyer paid for a ticket that is no longer theirs, and
  // the money is booked as owed to them instead.
  const soldBeforeSweep = (
    await sql`
      SELECT quantity_sold FROM listings WHERE id = ${listing.id}
    `
  )[0]!.quantity_sold as unknown as number;

  const latePayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(lateCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: lateCheckout.gatewayRef,
    vnp_OrderInfo: 'Thanh toan don hang muon',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2ELATE${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  latePayload.vnp_SecureHash = sign(latePayload);

  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(latePayload).toString()}`, {
    method: 'GET',
  });

  const lateOrder = await json<{ order: { status: string } }>(
    `/api/orders/${lateCheckout.orderId}`,
  );
  assert(
    lateOrder.order.status === 'REFUND_REQUIRED',
    'a payment that arrives after the reservation expired becomes REFUND_REQUIRED',
  );

  const { balances: lateBalances } = await json<{
    balances: Array<{ accountCode: string; balanceVnd: number }>;
  }>('/api/ledger/balances');
  const lateByCode = new Map(lateBalances.map((b) => [b.accountCode, b.balanceVnd]));
  assert(
    (lateByCode.get(`liability:user:${buyer.id}:refund`) ?? 0) >= lateCheckout.grossVnd,
    'the late payment is booked as money owed to the buyer (refund payable)',
  );

  const lateAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(lateAudit.ok, 'the ledger is still balanced after the late payment');

  // The late payment must not leak the reserved ticket. The buyer paid but
  // the tickets went back to the market, so the listing must show them as
  // available again. Before the fix the ticket stayed reserved forever: the
  // sweep only touches PENDING_PAYMENT orders, so a REFUND_REQUIRED order
  // never gave its ticket back.
  //
  // The baseline is the count *after* the sweep (the sweep already gave the
  // ticket back) and *before* the notification - so the payment itself
  // must not take it away a second time, and must not leave it reserved.
  const soldAfterLate = (
    await sql`
      SELECT quantity_sold FROM listings WHERE id = ${listing.id}
    `
  )[0]!.quantity_sold as unknown as number;
  assert(
    soldAfterLate === soldBeforeSweep,
    'a late payment returns the reserved ticket to the listing',
  );

  // ------------------------------------------------- escrow release
  // The baseline is read *here*, right before the release: by now the
  // escrow holds two orders - the original one (2 tickets) and the one
  // whose notification was lost, which was recovered through the gateway
  // query (1 ticket).
  const pendingAtRelease = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${seller.id}:pending`)?.balanceVnd ?? 0;
  const availableAtRelease = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${seller.id}:available`)?.balanceVnd ?? 0;

  const released = await json<{ released: number; releasedVnd: number }>(
    `/api/events/${event.id}/complete`,
    { method: 'POST' },
  );
  assert(released.released >= 1, `released ${released.released} order(s) from escrow`);
  const after = await json<{
    balances: Array<{ accountCode: string; balanceVnd: number }>;
  }>('/api/ledger/balances');
  const afterByCode = new Map(after.balances.map((b) => [b.accountCode, b.balanceVnd]));

  const pendingAfter = afterByCode.get(`liability:user:${seller.id}:pending`) ?? 0;
  const availableAfter = afterByCode.get(`liability:user:${seller.id}:available`) ?? 0;

  // Two orders are in escrow by now: the original one (2 tickets), and the
  // one whose notification was lost and that was recovered through the
  // gateway query (1 ticket). Both are released, so the balances move by
  // the sum of the two sellers' shares - not twice the first one.
  const recoveredFees = computeFees(price, 1);
  const releasedTotal = expectedSellerNet + recoveredFees.sellerNetVnd;
  assert(
    pendingAfter === pendingAtRelease - releasedTotal,
    'pending balance dropped after the event completed',
  );
  assert(
    availableAfter === availableAtRelease + releasedTotal,
    `available balance grew by ${releasedTotal} after the release`,
  );

  const orderAfter = await json<{ order: { status: string } }>(`/api/orders/${orderId}`);
  assert(orderAfter.order.status === 'RELEASED', 'order is RELEASED');

  const audit2 = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(audit2.ok, 'ledger is still balanced after the release');

  // ------------------------------------------------ the admin dashboard
  // The ops dashboard must not be a second source of truth: every number it
  // shows has to match the ledger exactly.
  const admin = await json<{
    escrowHeldVnd: number;
    releasedVnd: number;
    gatewayCashVnd: number;
    platformFeeVnd: number;
    pendingOrderCount: number;
    orderCounts: Record<string, number>;
    sellerEscrows: Array<{ userId: string; pendingVnd: number; availableVnd: number }>;
  }>('/api/admin/overview');

  const ledgerPendingTotal = after.balances
    .filter((b) => b.accountCode.endsWith(':pending'))
    .reduce((s, b) => s + b.balanceVnd, 0);
  const ledgerAvailableTotal = after.balances
    .filter((b) => b.accountCode.endsWith(':available'))
    .reduce((s, b) => s + b.balanceVnd, 0);

  assert(
    admin.escrowHeldVnd === ledgerPendingTotal,
    'admin dashboard escrow total matches the ledger',
  );
  assert(
    admin.releasedVnd === ledgerAvailableTotal,
    'admin dashboard released total matches the ledger',
  );
  assert(
    admin.gatewayCashVnd === (afterByCode.get('asset:gateway_cash') ?? 0),
    'admin dashboard gateway cash matches the ledger',
  );
  assert(
    admin.platformFeeVnd === (afterByCode.get('revenue:platform_fee') ?? 0),
    'admin dashboard platform fee matches the ledger',
  );

  const sellerEscrow = admin.sellerEscrows.find((s) => s.userId === seller.id);
  assert(
    sellerEscrow?.pendingVnd === pendingAfter &&
      sellerEscrow?.availableVnd === availableAfter,
    'admin per-seller escrow matches that seller balances',
  );
  assert(
    admin.orderCounts['RELEASED'] !== undefined &&
      admin.orderCounts['RELEASED'] >= 1,
    'admin dashboard counts the released orders',
  );

  // ------------------------------------- the journal cannot be rewritten
  // The ledger is append-only at the database level: an UPDATE or DELETE on
  // a posted entry is rejected by a trigger.
  const integrity = await json<{
    appendOnly: boolean;
    updateRejected?: boolean;
    deleteRejected?: boolean;
  }>('/api/ledger/integrity');
  assert(
    integrity.appendOnly,
    'a posted ledger entry cannot be updated or deleted (DB trigger)',
  );

  // --------------------------------------- a completed event sells no more
  // The event has just been marked completed. Buying a ticket for it now
  // would trap the money in escrow with no way to release it.
  const closedCheckout = await fetch(`${API}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      listingId: listing.id,
      quantity: 1,
      buyerId: buyer.id,
    }),
  });
  assert(
    closedCheckout.status === 409,
    'checkout for a completed event is rejected (409)',
  );

  // ------------------------------ a payment for a cancelled order
  // The buyer checked out, the event was completed (so the order became
  // CANCELLED), and only then the gateway notification arrives. The buyer
  // paid, so the money must be booked - as money owed back to the buyer.
  //
  // Before the fix the notification was accepted but nothing was posted:
  // the money disappeared.
  const cancelEvent = await sql<{ id: string }[]>`
    INSERT INTO events (name, venue, starts_at)
    VALUES ('E2E cancelled event ' || now()::text, 'E2E venue', now() + interval '30 days')
    RETURNING id
  `;
  const cancelListing = await sql<{ id: string }[]>`
    INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
    VALUES (${cancelEvent[0]!.id}, ${seller.id}, 'E2E cancelled listing', 10, 1200000)
    RETURNING id
  `;

  const cancelledCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-cancelled-${Date.now()}` },
      body: JSON.stringify({
        listingId: cancelListing[0]!.id,
        quantity: 1,
        buyerId: buyer.id,
      }),
    },
  );

  // Completing the event cancels the unpaid order.
  await json(`/api/events/${cancelEvent[0]!.id}/complete`, { method: 'POST' });
  const cancelledStatus = await json<{ order: { status: string } }>(
    `/api/orders/${cancelledCheckout.orderId}`,
  );
  assert(
    cancelledStatus.order.status === 'CANCELLED',
    'completing the event cancels the unpaid order',
  );

  const refundBeforeCancelled = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;

  const cancelledPayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(cancelledCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: cancelledCheckout.gatewayRef,
    vnp_OrderInfo: 'payment after the event was completed',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2ECANCELLED${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  cancelledPayload.vnp_SecureHash = sign(cancelledPayload);

  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(cancelledPayload).toString()}`, {
    method: 'GET',
  });

  const refundAfterCancelled = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;
  assert(
    refundAfterCancelled === refundBeforeCancelled + cancelledCheckout.grossVnd,
    'a payment for a cancelled order is booked as money owed to the buyer',
  );

  const cancelledAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(cancelledAudit.ok, 'the ledger is still balanced after the cancelled-order payment');

  // ------------------------------------- a second payment for the same order
  // The buyer pays once, and then pays a *second* time - a retry at the
  // gateway that produced a new transaction number. The second payment is
  // real money that arrived, so it has to be booked: the seller must not
  // get it twice, and the buyer is owed it back.
  //
  // Before the fix the second notification was accepted but nothing was
  // posted - 1.100.000 VND simply disappeared.
  const doublePayEvent = await sql<{ id: string }[]>`
    INSERT INTO events (name, venue, starts_at)
    VALUES ('E2E double pay event ' || now()::text, 'E2E venue', now() + interval '30 days')
    RETURNING id
  `;
  const doublePayListing = await sql<{ id: string }[]>`
    INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
    VALUES (${doublePayEvent[0]!.id}, ${seller.id}, 'E2E double pay listing', 10, 1200000)
    RETURNING id
  `;
  const doublePayCheckout = await json<{ orderId: string; gatewayRef: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': `e2e-double-pay-${Date.now()}` },
      body: JSON.stringify({
        listingId: doublePayListing[0]!.id,
        quantity: 1,
        buyerId: buyer.id,
      }),
    },
  );
  // Pay it once, so the order reaches PAID.
  const doublePayFirst: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMRC',
    vnp_OrderType: 'other',
    vnp_Amount: String(doublePayCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: doublePayCheckout.gatewayRef,
    vnp_OrderInfo: 'the first of two payments',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_TransactionNo: `E2EDOUBLEFIRST${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  doublePayFirst.vnp_SecureHash = sign(doublePayFirst);
  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(doublePayFirst).toString()}`, {
    method: 'GET',
  });

  const cashBeforeDouble = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === 'asset:gateway_cash')?.balanceVnd ?? 0;
  const refundBeforeDouble = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;

  // The second payment, with a different transaction number.
  const doublePaySecond: Record<string, string> = {
    ...doublePayFirst,
    vnp_TransactionNo: `E2EDOUBLESECOND${Date.now()}`,
    vnp_OrderInfo: 'the second of two payments',
  };
  delete doublePaySecond.vnp_SecureHash;
  doublePaySecond.vnp_SecureHash = sign(doublePaySecond);
  await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(doublePaySecond).toString()}`, {
    method: 'GET',
  });

  const cashAfterDouble = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === 'asset:gateway_cash')?.balanceVnd ?? 0;
  const refundAfterDouble = (
    await json<{ balances: Array<{ accountCode: string; balanceVnd: number }> }>(
      '/api/ledger/balances',
    )
  ).balances.find((b) => b.accountCode === `liability:user:${buyer.id}:refund`)?.balanceVnd ?? 0;

  assert(
    cashAfterDouble === cashBeforeDouble + doublePayCheckout.grossVnd,
    'a second payment for the same order reaches the gateway cash',
  );
  assert(
    refundAfterDouble === refundBeforeDouble + doublePayCheckout.grossVnd,
    'a second payment for the same order is booked as money owed to the buyer',
  );

  const doubleAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(doubleAudit.ok, 'the ledger is still balanced after the second payment');

  // --------------------------------------------------- the raw IPN log
  // Every notification is logged, including the ones we rejected, so an
  // operator can reconcile against the gateway's own transaction list.
  const { events: rawEvents } = await json<{
    events: Array<{
      txn_ref: string | null;
      signature_valid: boolean;
      applied: boolean;
      payload: Record<string, string>;
    }>;
  }>('/api/admin/payment-events');

  const loggedForOrder = rawEvents.filter((e) => e.txn_ref === gatewayRef);
  assert(
    loggedForOrder.length >= 1,
    'the raw IPN was written to the reconciliation log',
  );
  assert(
    loggedForOrder.some((e) => e.applied),
    'the reconciliation log records that the IPN was applied',
  );

  const badSignature = await fetch(
    `${API}/api/ipn/vnpay?${new URLSearchParams({
      ...payload,
      vnp_TxnRef: 'does-not-exist',
      vnp_SecureHash: '0'.repeat(128),
    }).toString()}`,
    { method: 'GET' },
  );
  const badBody = (await badSignature.json()) as { RspCode: string };
  assert(badBody.RspCode === '97', 'an IPN with a bad signature is rejected (RspCode 97)');

  const { events: afterBad } = await json<{
    events: Array<{ signature_valid: boolean; applied: boolean }>;
  }>('/api/admin/payment-events');
  assert(
    afterBad.length > rawEvents.length &&
      afterBad.some((e) => !e.signature_valid && !e.applied),
    'the rejected IPN is logged too (signature_valid=false, applied=false)',
  );

  console.log('\nAll E2E assertions passed.');
}

// Run standalone when invoked directly (`tsx scripts/e2e.ts`), but not when
// imported by the runner (`scripts/e2e-run.ts`).
const invokedDirectly =
  process.argv[1]?.includes('e2e.ts') && !process.argv[1]?.includes('e2e-run.ts');
if (invokedDirectly) {
  runAssertions().catch((err) => {
    console.error('\nE2E failed:', err.message);
    process.exit(1);
  });
}
