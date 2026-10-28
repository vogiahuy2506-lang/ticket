const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3001';

/**
 * Server-side data access to the Node backend.
 * Every page that needs data is server-rendered (no client fetching).
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { revalidate?: number },
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: init?.revalidate === 0 ? 'no-store' : undefined,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${path} failed with ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  users: () =>
    apiFetch<{
      users: Array<{ id: string; name: string; role: string }>;
    }>('/api/users'),

  events: () =>
    apiFetch<{
      events: Array<{
        id: string;
        name: string;
        venue: string;
        starts_at: string;
        status: string;
        listing_count: number;
        tickets_left: number;
      }>;
    }>('/api/events'),

  event: (id: string) =>
    apiFetch<{
      event: {
        id: string;
        name: string;
        venue: string;
        starts_at: string;
        status: string;
      };
      listings: Array<{
        id: string;
        title: string;
        quantity_total: number;
        quantity_sold: number;
        quantity_available: number;
        price_vnd: string;
        seller_id: string;
        seller_name: string;
      }>;
    }>(`/api/events/${id}`),

  orders: (userId: string) =>
    apiFetch<{
      orders: Array<{
        id: string;
        status: string;
        quantity: number;
        grossVnd: number;
        sellerNetVnd: number;
        platformFeeVnd: number;
        createdAt: string;
        paidAt: string | null;
        releasedAt: string | null;
        expiresAt: string;
        eventId: string;
        eventName: string;
        eventStartsAt: string;
        eventStatus: string;
        listingTitle: string;
        buyerId: string;
        buyerName: string;
        sellerId: string;
        sellerName: string;
      }>;
    }>(`/api/orders?userId=${encodeURIComponent(userId)}`),

  order: (id: string) =>
    apiFetch<{
      order: {
        id: string;
        buyer_id: string;
        listing_id: string;
        event_id: string;
        seller_id: string;
        quantity: number;
        unit_price_vnd: string;
        subtotal_vnd: string;
        buyer_fee_vnd: string;
        seller_fee_vnd: string;
        gross_vnd: string;
        seller_net_vnd: string;
        platform_fee_vnd: string;
        status: string;
        created_at: string;
        paid_at: string | null;
        released_at: string | null;
      };
      fees: {
        subtotalVnd: number;
        buyerFeeVnd: number;
        sellerFeeVnd: number;
        grossVnd: number;
        sellerNetVnd: number;
        platformFeeVnd: number;
      };
      payments: Array<{
        provider: string;
        provider_txn_id: string;
        amount_vnd: string;
        status: string;
        created_at: string;
      }>;
    }>(`/api/orders/${id}`),

  wallet: (userId: string) =>
    apiFetch<{
      balances: {
        userId: string;
        pendingVnd: number;
        availableVnd: number;
        refundOwedVnd: number;
        totalVnd: number;
        platformFeeVnd: number;
        gatewayCashVnd: number;
      };
      transactions: Array<{
        txnId: string;
        refType: string;
        refId: string | null;
        memo: string;
        createdAt: string;
        lines: Array<{
          accountCode: string;
          accountName: string;
          direction: 'debit' | 'credit';
          amountVnd: number;
        }>;
      }>;
    }>(`/api/wallet/${userId}`),

  adminOverview: () =>
    apiFetch<{
      escrowHeldVnd: number;
      releasedVnd: number;
      gatewayCashVnd: number;
      platformFeeVnd: number;
      refundPayableVnd: number;
      grossVolumeVnd: number;
      orderCounts: Record<string, number>;
      pendingOrderCount: number;
      stuckOrders: Array<{
        orderId: string;
        eventName: string;
        buyerName: string;
        grossVnd: number;
        ageMinutes: number;
      }>;
      eventsAwaitingRelease: Array<{
        eventId: string;
        eventName: string;
        startsAt: string;
        paidOrders: number;
        escrowVnd: number;
      }>;
      sellerEscrows: Array<{
        userId: string;
        name: string;
        pendingVnd: number;
        availableVnd: number;
      }>;
      refundOrders: Array<{
        orderId: string;
        buyerName: string;
        eventName: string;
        grossVnd: number;
        createdAt: string;
      }>;
    }>('/api/admin/overview'),

  adminOrders: () =>
    apiFetch<{
      orders: Array<{
        id: string;
        status: string;
        eventName: string;
        buyerName: string;
        sellerName: string;
        quantity: number;
        grossVnd: number;
        sellerNetVnd: number;
        platformFeeVnd: number;
        createdAt: string;
        paidAt: string | null;
        releasedAt: string | null;
      }>;
    }>('/api/admin/orders'),

  adminPaymentEvents: () =>
    apiFetch<{
      events: Array<{
        txn_ref: string | null;
        provider_txn_id: string | null;
        signature_valid: boolean;
        applied: boolean;
        payload: Record<string, string>;
        received_at: string;
      }>;
    }>('/api/admin/payment-events'),
};

export const API_BASE = API_BASE_URL;
