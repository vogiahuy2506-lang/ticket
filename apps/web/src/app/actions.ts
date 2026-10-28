'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { API_BASE, api } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
import { getCurrentUser } from '@/lib/session';
import { checkoutSchema } from '@tce/shared';

/**
 * The header that tells the API who is acting.
 *
 * The API enforces the role of every mutating endpoint and the ownership of
 * every wallet and receipt. The identity comes from the session cookie and
 * the role is looked up in the database by the API itself, so the client
 * never states a role - it only states which user it is acting as.
 */
async function actingUserHeader(): Promise<Record<string, string>> {
  const user = await getCurrentUser();
  return user ? { 'x-tce-user-id': user.id } : {};
}

/** Switches the active user (no real auth in this test task). */
export async function switchUser(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');
  if (userId) {
    const store = await cookies();
    store.set(SESSION_COOKIE, userId, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    });
  }
  revalidatePath('/', 'layout');
  redirect('/');
}

/**
 * Creates the order and redirects the buyer to the gateway.
 *
 * The order is created server-side (PENDING_PAYMENT) and the browser is
 * redirected to the gateway URL returned by the backend. Money is only moved
 * when the gateway's IPN arrives - the redirect itself changes nothing.
 *
 * An Idempotency-Key is sent so a double-tapped "Pay" button (or a retry
 * after a slow network) cannot create two orders and reserve the tickets
 * twice. The key is rendered into the form, so two submits of the *same*
 * form carry the same key, while a deliberate second purchase (after a
 * page reload) gets a fresh one.
 */
export async function startCheckout(formData: FormData): Promise<void> {
  const parsed = checkoutSchema.safeParse({
    listingId: formData.get('listingId'),
    quantity: formData.get('quantity'),
  });

  const user = await getBuyer();
  if (!parsed.success || !user) {
    redirect('/');
    return;
  }

  const formKey = String(formData.get('idempotencyKey') ?? '');
  const idempotencyKey =
    formKey || `auto-${user.id}-${parsed.data.listingId}-${Date.now()}`;

  const res = await fetch(`${API_BASE}/api/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      // The API is behind the storefront, so it would otherwise see the
      // storefront's address and not the buyer's. The payment gateway wants
      // the buyer's address (`vnp_IpAddr`), so it is forwarded here.
      'x-forwarded-for': await clientIp(),
      ...(await actingUserHeader()),
    },
    body: JSON.stringify({
      listingId: parsed.data.listingId,
      quantity: parsed.data.quantity,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    redirect(`/?error=${encodeURIComponent(body.message ?? 'Không tạo được đơn hàng')}`);
    return;
  }

  const { redirectUrl } = (await res.json()) as { redirectUrl: string };
  redirect(redirectUrl);
}

/**
 * The buyer's IP address, as seen by the storefront.
 *
 * The payment gateway wants the *buyer's* address (`vnp_IpAddr`), and the
 * API is behind the storefront - so without this header the API would send
 * the storefront's own address to the gateway.
 *
 * `x-forwarded-for` is set by the proxy in front of the app in
 * production; on a local run there is no proxy, so the request's own
 * address is used.
 */
async function clientIp(): Promise<string> {
  const store = await headers();
  const forwarded = store.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;
  return store.get('x-real-ip')?.trim() || '127.0.0.1';
}

/**
 * The user performing the checkout.
 *
 * Decision (brief was silent): any user may buy, not only the ones with the
 * `buyer` role. In a real marketplace a seller is very often a buyer too
 * (buying a friend's ticket while selling their own), and forcing a strict
 * role would need a many-to-many role table. The role stays for the
 * operator-only actions (releasing escrow).
 */
async function getBuyer() {
  const store = await cookies();
  const uid = store.get(SESSION_COOKIE)?.value;
  const { users } = await api.users();
  if (uid) {
    const found = users.find((u) => u.id === uid);
    if (found) return found;
  }
  return users.find((u) => u.role === 'buyer') ?? users[0] ?? null;
}

/**
 * Marks an event as completed: releases every escrowed seller balance to
 * its "available" account.
 *
 * Only an operator (admin) may do this. The check lives here, on the server,
 * not just in the UI - a Next.js server action is an HTTP endpoint, so
 * hiding the button is not enough on its own.
 */
export async function completeEvent(formData: FormData): Promise<void> {
  const eventId = String(formData.get('eventId') ?? '');
  if (!eventId) return;

  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    redirect('/?error=' + encodeURIComponent('Chỉ quản trị viên mới giải ngân được'));
    return;
  }

  const res = await fetch(`${API_BASE}/api/events/${eventId}/complete`, {
    method: 'POST',
    headers: await actingUserHeader(),
  });
  if (res.ok) {
    revalidatePath('/', 'layout');
  }
}

/**
 * Cancels an order that is still waiting for its payment.
 *
 * The buyer gives the tickets back right away instead of waiting for the
 * 15-minute reservation to expire, so somebody else can buy them.
 *
 * The buyer is taken from the session, not from the form: a server action
 * is an HTTP endpoint, and the check has to live on the server.
 */
export async function cancelOrder(formData: FormData): Promise<void> {
  const orderId = String(formData.get('orderId') ?? '');
  if (!orderId) return;

  const user = await getCurrentUser();
  if (!user) {
    redirect('/?error=' + encodeURIComponent('Chọn một người dùng trước'));
    return;
  }

  const res = await fetch(`${API_BASE}/api/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await actingUserHeader()),
    },
  });

  if (res.ok) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/orders');
  } else {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    redirect(
      `/orders/${orderId}?error=${encodeURIComponent(
        body.message ?? 'Không hủy được đơn hàng',
      )}`,
    );
  }
}

/**
 * Creates a new event with its listings.
 *
 * Decision (brief was silent): the brief has no event-creation flow, but
 * the seeded catalogue is finite - once every ticket is sold out there is
 * nothing left to test. The operator gets a way to put fresh tickets on
 * sale.
 *
 * Only an operator (admin) may do this, and the check is on the server: a
 * Next.js server action is an HTTP endpoint, so hiding the button is not
 * enough on its own.
 *
 * The form sends parallel arrays (`listingTitle`, `listingQuantity`, ...),
 * so the rows are zipped back together here. A mismatch - a title without a
 * quantity - is rejected rather than silently dropped.
 */
export async function createEvent(
  formData: FormData,
): Promise<{ ok: true; eventId: string } | { ok: false; message: string }> {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    return { ok: false, message: 'Chỉ quản trị viên mới tạo được sự kiện' };
  }

  const titles = formData.getAll('listingTitle').map(String);
  const quantities = formData.getAll('listingQuantity').map(String);
  const prices = formData.getAll('listingPrice').map(String);

  // The seller is per row, so the field names carry the row index. They
  // arrive in the order the form rendered them, but the index is read back
  // from the name to be safe.
  const sellersByIndex = new Map<number, string>();
  for (const key of formData.keys()) {
    const m = /^listingSeller-(\d+)$/.exec(key);
    if (m) sellersByIndex.set(Number(m[1]), String(formData.get(key)));
  }

  if (titles.length === 0) {
    return { ok: false, message: 'Cần ít nhất một nhóm vé' };
  }
  if (titles.length !== quantities.length || titles.length !== prices.length) {
    return { ok: false, message: 'Dữ liệu nhóm vé không hợp lệ' };
  }

  const listings = titles.map((title, i) => ({
    sellerId: sellersByIndex.get(i) ?? '',
    title,
    quantityTotal: Number(quantities[i]),
    priceVnd: Number(prices[i]),
  }));

  const res = await fetch(`${API_BASE}/api/admin/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await actingUserHeader()),
    },
    body: JSON.stringify({
      name: String(formData.get('name') ?? ''),
      venue: String(formData.get('venue') ?? ''),
      startsAtLocal: String(formData.get('startsAtLocal') ?? ''),
      listings,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    return {
      ok: false,
      message:
        body.message ??
        (body.error === 'SELLER_NOT_FOUND'
          ? 'Người bán không tồn tại trong hệ thống'
          : 'Không tạo được sự kiện'),
    };
  }

  const { event } = (await res.json()) as { event: { eventId: string } };
  revalidatePath('/', 'layout');
  return { ok: true, eventId: event.eventId };
}
