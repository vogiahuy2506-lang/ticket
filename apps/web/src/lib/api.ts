import { listUsers, resolveActingUser } from './users';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3001';

/**
 * Server-side data access to the Node backend.
 * Every page that needs data is server-rendered (no client fetching).
 */
/**
 * An error from the backend, with the HTTP status attached.
 *
 * The distinction matters: a `404` means "this order does not exist" and
 * the page should say so, while a `500` means the API is broken and the
 * page should say *that* instead of pretending the order is missing. A
 * bare `catch` cannot tell the two apart - it turned every outage into a
 * "page not found".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, body: string) {
    super(`API ${path} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Whether the error means "the thing does not exist".
 *
 * Only a 404 counts. Everything else - a 500, a refused connection, a
 * timeout, a malformed response - is a fault of the system, not of the
 * visitor, and must not be reported as a missing page.
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & {
    revalidate?: number;
    /**
     * Skips the "who is acting" header.
     *
     * Only the user list uses it: the helper that resolves the acting user
     * has to read that list, so including the header there would ask for
     * the user list in order to build the header for the user list.
     */
    withoutActingUser?: boolean;
  },
): Promise<T> {
  const { withoutActingUser, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(withoutActingUser ? {} : await actingUserHeader()),
      ...(rest?.headers ?? {}),
    },
    cache: rest?.revalidate === 0 ? 'no-store' : undefined,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, path, body);
  }
  return (await res.json()) as T;
}

export const api = {
  /**
   * The user list.
   *
   * It is the one call that cannot carry the acting user: resolving the
   * acting user means reading this list. The list itself is public - it
   * only holds a name, a role and an id, and the brief has no login at all.
   */
  users: async () => ({ users: await listUsers() }),

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

/**
 * The acting user, for the API.
 *
 * The API checks the role of every mutating endpoint and the ownership of
 * every wallet and receipt, so it has to know who is calling. The identity
 * comes from the session cookie, and the API looks the role up in the
 * database itself - the client never states a role, it only states which
 * user it is acting as.
 */
async function actingUserHeader(): Promise<Record<string, string>> {
  // The *resolved* user, not the raw cookie: when no cookie is set the
  // session falls back to the first buyer, and the API has to see the same
  // user the pages are rendering - otherwise the storefront would render
  // one user's page while the API answered for another.
  const { actingUserId } = await import('./session-cookie');
  const user = await resolveActingUser(await actingUserId());
  return user ? { 'x-tce-user-id': user.id } : {};
}

export const API_BASE = API_BASE_URL;
