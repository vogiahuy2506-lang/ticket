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
 *   API_BASE_URL=http://localhost:3011 npm run e2e -w @tce/api
 */

import crypto from 'node:crypto';

const API = process.env.API_BASE_URL ?? 'http://localhost:3001';
const SECRET = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';

function sign(params: Record<string, string>): string {
  const filtered = Object.keys(params)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      const v = params[key];
      if (v !== undefined && v !== null && v !== '') acc[key] = String(v);
      return acc;
    }, {});
  const query = Object.entries(filtered)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return crypto
    .createHash('sha256')
    .update(`${SECRET}${query}${SECRET}`, 'utf8')
    .digest('hex');
}

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

async function main() {
  console.log(`E2E against ${API}\n`);

  // ---------------------------------------------------------------- setup
  const { users } = await json<{ users: Array<{ id: string; name: string; role: string }> }>(
    '/api/users',
  );
  const buyer = users.find((u) => u.role === 'buyer')!;
  const seller = users.find((u) => u.role === 'seller')!;
  console.log(`buyer=${buyer.name} seller=${seller.name}`);

  const { events } = await json<{ events: Array<{ id: string; name: string; status: string }> }>(
    '/api/events',
  );
  const event = events.find((e) => e.status === 'scheduled')!;

  const { listings } = await json<{
    listings: Array<{
      id: string;
      title: string;
      price_vnd: string;
      quantity_available: number;
      seller_id: string;
    }>;
  }>(`/api/events/${event.id}`);
  const listing = listings.find((l) => l.seller_id === seller.id)!;
  const price = Number(listing.price_vnd);
  const quantity = 2;
  console.log(`event=${event.name} listing=${listing.title} price=${price} x${quantity}\n`);

  // ------------------------------------------------------------- checkout
  const checkout = await json<{ orderId: string; redirectUrl: string; grossVnd: number }>(
    '/api/checkout',
    {
      method: 'POST',
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

  // ------------------------------------------------------------------ IPN
  const payload: Record<string, string> = {
    vnp_Version: '2.1',
    vnp_Command: 'pay',
    vnp_OrderType: 'other',
    vnp_Amount: String(expectedGross),
    vnp_Currency: 'VND',
    vnp_TxnRef: orderId,
    vnp_OrderInfo: `Thanh toan don hang ${orderId.slice(0, 8)}`,
    vnp_ReturnUrl: 'http://localhost:3010/orders/x',
    vnp_NotifyUrl: `${API}/api/ipn/vnpay`,
    vnp_TransactionId: `E2E${Date.now()}`,
    vnp_BankCode: 'NCB',
    vnp_ResponseCode: '00',
    vnp_ResponseMessage: 'Giao dich thanh cong',
  };
  payload.vnp_SecureHash = sign(payload);

  const ipnRes = await fetch(`${API}/api/ipn/vnpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  });
  const ipnBody = (await ipnRes.json()) as { RspCode: string };
  assert(ipnBody.RspCode === '00', 'IPN accepted (RspCode 00)');

  const paid = await json<{ order: { status: string } }>(`/api/orders/${orderId}`);
  assert(paid.order.status === 'PAID', 'order is PAID after the IPN');

  // ------------------------------------------------- idempotent replay x3
  for (let i = 0; i < 3; i++) {
    await fetch(`${API}/api/ipn/vnpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString(),
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
    pending === expectedSellerNet,
    `seller pending balance = ${expectedSellerNet} (money is escrowed, not available)`,
  );
  assert(available === 0, 'seller has nothing available before the event ends');
  assert(
    fee === expectedBuyerFee + expectedSellerFee,
    `platform kept ${expectedBuyerFee + expectedSellerFee} (10% + 5%)`,
  );
  assert(cash === expectedGross, `gateway holds ${expectedGross}`);

  const audit = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(audit.ok, 'every ledger transaction is balanced (debit == credit)');

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
    availableAfter === expectedSellerNet,
    `available balance = ${expectedSellerNet} after the release`,
  );

  const orderAfter = await json<{ order: { status: string } }>(`/api/orders/${orderId}`);
  assert(orderAfter.order.status === 'RELEASED', 'order is RELEASED');

  const audit2 = await json<{ ok: boolean }>('/api/ledger/audit');
  assert(audit2.ok, 'ledger is still balanced after the release');

  console.log('\nAll E2E assertions passed.');
}

main().catch((err) => {
  console.error('\nE2E failed:', err.message);
  process.exit(1);
});
