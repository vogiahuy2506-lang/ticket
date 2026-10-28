'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { API_BASE, api } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
import { getCurrentUser } from '@/lib/session';
import { checkoutSchema } from '@tce/shared';

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
    },
    body: JSON.stringify({
      listingId: parsed.data.listingId,
      quantity: parsed.data.quantity,
      buyerId: user.id,
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
  });
  if (res.ok) {
    revalidatePath('/', 'layout');
  }
}
