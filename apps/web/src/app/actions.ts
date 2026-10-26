'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { API_BASE, api } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/session';
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

  const res = await fetch(`${API_BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      listingId: parsed.data.listingId,
      quantity: parsed.data.quantity,
      buyerId: user.id,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    redirect(`/?error=${encodeURIComponent(body.message ?? 'Checkout failed')}`);
    return;
  }

  const { redirectUrl } = (await res.json()) as { redirectUrl: string };
  redirect(redirectUrl);
}

async function getBuyer() {
  const store = await cookies();
  const uid = store.get(SESSION_COOKIE)?.value;
  const { users } = await api.users();
  if (uid) {
    const found = users.find((u) => u.id === uid);
    if (found) return found;
  }
  return users.find((u) => u.role === 'buyer') ?? null;
}

/**
 * Marks an event as completed: releases every escrowed seller balance to
 * its "available" account.
 */
export async function completeEvent(formData: FormData): Promise<void> {
  const eventId = String(formData.get('eventId') ?? '');
  if (!eventId) return;

  const res = await fetch(`${API_BASE}/api/events/${eventId}/complete`, {
    method: 'POST',
  });
  if (res.ok) {
    revalidatePath('/', 'layout');
  }
}
