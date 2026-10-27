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
  const checkout = await json<{ orderId: string; redirectUrl: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': idemKey },
      body: JSON.stringify({ listingId: listing.id, quantity, buyerId: buyer.id }),
    },
  );
  const orderId = checkout.orderId;
  console.log(`order ${orderId} created, redirect -> ${checkout.redirectUrl.slice(0, 90)}...`);

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
    vnp_TmnCode: 'MOCKMERCHANT',
    vnp_OrderType: 'other',
    vnp_Amount: String(expectedGross * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: orderId,
    vnp_OrderInfo: `Thanh toan don hang ${orderId.slice(0, 8)}`,
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_NotifyUrl: `${API}/api/ipn/vnpay`,
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
  for (let i = 0; i < 3; i++) {
    await fetch(`${API}/api/ipn/vnpay?${new URLSearchParams(payload).toString()}`, {
      method: 'GET',
    });
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

  const declineCheckout = await json<{ orderId: string; grossVnd: number }>(
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
    vnp_TmnCode: 'MOCKMERCHANT',
    vnp_OrderType: 'other',
    vnp_Amount: String(declineCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: declineOrderId,
    vnp_OrderInfo: `Thanh toan don hang ${declineOrderId.slice(0, 8)}`,
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_NotifyUrl: `${API}/api/ipn/vnpay`,
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
  const lateCheckout = await json<{ orderId: string; grossVnd: number }>('/api/checkout', {
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

  const latePayload: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'MOCKMERCHANT',
    vnp_OrderType: 'other',
    vnp_Amount: String(lateCheckout.grossVnd * WIRE_AMOUNT_FACTOR),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: lateCheckout.orderId,
    vnp_OrderInfo: 'Thanh toan don hang muon',
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_NotifyUrl: `${API}/api/ipn/vnpay`,
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
    (lateByCode.get('liability:refund_payable') ?? 0) >= lateCheckout.grossVnd,
    'the late payment is booked as money owed to the buyer (refund payable)',
  );

  const lateAudit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(lateAudit.ok, 'the ledger is still balanced after the late payment');

  // ------------------------------------------------- escrow release
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

  assert(
    pendingAfter === pending - expectedSellerNet,
    'pending balance dropped after the event completed',
  );
  assert(
    availableAfter === available + expectedSellerNet,
    `available balance grew by ${expectedSellerNet} after the release`,
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

  // ------------------------------------------------- the raw IPN log
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

  const loggedForOrder = rawEvents.filter((e) => e.txn_ref === orderId);
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
