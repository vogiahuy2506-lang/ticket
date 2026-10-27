import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import { computeBalances } from './ledger.js';

/**
 * Admin / operations dashboard.
 *
 * Decision (brief was silent): the brief says no authentication is needed,
 * so "admin" here is a *presentation* role - the storefront gates the page
 * on the selected user's role. But an escrow marketplace has real operational
 * questions an operator has to answer:
 *
 *   - how much money is currently locked in escrow across the platform?
 *   - which orders are stuck waiting for a gateway callback?
 *   - which events have happened and still hold escrowed money?
 *   - how much fee has the platform earned so far?
 *
 * Every number below is derived from the ledger (or from the order table),
 * never from a stored balance, so the dashboard can never disagree with the
 * books.
 */

export interface AdminOverview {
  /** total money currently locked in seller escrow accounts */
  escrowHeldVnd: number;
  /** money already released to sellers */
  releasedVnd: number;
  /** cash sitting at the payment gateway */
  gatewayCashVnd: number;
  /** fees the platform has earned */
  platformFeeVnd: number;
  /** money we owe to buyers whose payment arrived too late */
  refundPayableVnd: number;
  /** gross volume processed through the gateway */
  grossVolumeVnd: number;
  orderCounts: Record<string, number>;
  pendingOrderCount: number;
  /** orders that have been waiting for the gateway the longest */
  stuckOrders: Array<{
    orderId: string;
    eventName: string;
    buyerName: string;
    grossVnd: number;
    ageMinutes: number;
  }>;
  /** scheduled events that still hold escrowed money */
  eventsAwaitingRelease: Array<{
    eventId: string;
    eventName: string;
    startsAt: string;
    paidOrders: number;
    escrowVnd: number;
  }>;
  /** money per seller currently held in escrow */
  sellerEscrows: Array<{
    userId: string;
    name: string;
    pendingVnd: number;
    availableVnd: number;
  }>;
}

/**
 * Aggregates the operational view.
 *
 * All money figures come from `computeBalances`, i.e. from summing the
 * journal - the dashboard and the ledger can never drift apart.
 */
export async function getAdminOverview(sql: Db): Promise<AdminOverview> {
  const balances = await computeBalances(sql);

  let escrowHeldVnd = 0;
  let releasedVnd = 0;
  const sellerEscrows: AdminOverview['sellerEscrows'] = [];

  for (const b of balances) {
    if (b.kind !== 'liability') continue;
    if (b.accountCode.endsWith(':pending')) {
      escrowHeldVnd += b.balanceVnd;
    } else if (b.accountCode.endsWith(':available')) {
      releasedVnd += b.balanceVnd;
    }
  }

  const gatewayCashVnd =
    balances.find((b) => b.accountCode === 'asset:gateway_cash')?.balanceVnd ?? 0;
  const platformFeeVnd =
    balances.find((b) => b.accountCode === 'revenue:platform_fee')?.balanceVnd ?? 0;
  const refundPayableVnd =
    balances.find((b) => b.accountCode === 'liability:refund_payable')?.balanceVnd ?? 0;

  // Per-seller escrow split, so an operator can see who the money belongs to.
  const sellers = await sql<
    Array<{
      id: string;
      name: string;
      pending_vnd: string;
      available_vnd: string;
    }>
  >`
    SELECT
      u.id,
      u.name,
      COALESCE(SUM(CASE WHEN a.code LIKE 'liability:user:%:pending'   THEN e.credit_total - e.debit_total END), 0) AS pending_vnd,
      COALESCE(SUM(CASE WHEN a.code LIKE 'liability:user:%:available' THEN e.credit_total - e.debit_total END), 0) AS available_vnd
    FROM users u
    LEFT JOIN ledger_accounts a ON a.owner_user_id = u.id
    LEFT JOIN (
      SELECT
        le.account_id,
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount_vnd END), 0) AS credit_total,
        COALESCE(SUM(CASE WHEN le.direction = 'debit'  THEN le.amount_vnd END), 0) AS debit_total
      FROM ledger_entries le
      GROUP BY le.account_id
    ) e ON e.account_id = a.id
    WHERE u.role = 'seller'
    GROUP BY u.id, u.name
    ORDER BY u.name
  `;

  for (const s of sellers) {
    sellerEscrows.push({
      userId: s.id,
      name: s.name,
      pendingVnd: Number(s.pending_vnd),
      availableVnd: Number(s.available_vnd),
    });
  }

  const orderCounts: Record<string, number> = {};
  const countRows = await sql<Array<{ status: string; n: string }>>`
    SELECT status, COUNT(*)::text AS n FROM orders GROUP BY status
  `;
  for (const r of countRows) {
    orderCounts[r.status] = Number(r.n);
  }

  const pendingRows = await sql<
    Array<{
      order_id: string;
      event_name: string;
      buyer_name: string;
      gross_vnd: string;
      created_at: string;
    }>
  >`
    SELECT
      o.id AS order_id,
      e.name AS event_name,
      b.name AS buyer_name,
      o.gross_vnd,
      o.created_at
    FROM orders o
    JOIN events e ON e.id = o.event_id
    JOIN users  b ON b.id = o.buyer_id
    WHERE o.status = 'PENDING_PAYMENT'
    ORDER BY o.created_at ASC
    LIMIT 20
  `;

  const now = Date.now();
  const stuckOrders = pendingRows.map((r) => ({
    orderId: r.order_id,
    eventName: r.event_name,
    buyerName: r.buyer_name,
    grossVnd: Number(r.gross_vnd),
    ageMinutes: Math.max(
      0,
      Math.round((now - new Date(r.created_at).getTime()) / 60_000),
    ),
  }));

  // Scheduled events that already have paid orders waiting for a release.
  const awaiting = await sql<
    Array<{
      event_id: string;
      event_name: string;
      starts_at: string;
      paid_orders: string;
      escrow_vnd: string;
    }>
  >`
    SELECT
      e.id AS event_id,
      e.name AS event_name,
      e.starts_at,
      COUNT(o.id)::text AS paid_orders,
      COALESCE(SUM(o.seller_net_vnd), 0)::text AS escrow_vnd
    FROM events e
    JOIN orders o ON o.event_id = e.id AND o.status = 'PAID'
    WHERE e.status = 'scheduled'
    GROUP BY e.id, e.name, e.starts_at
    ORDER BY e.starts_at ASC
  `;

  const grossVolumeRows = await sql<{ v: string }[]>`
    SELECT COALESCE(SUM(gross_vnd), 0)::text AS v FROM orders WHERE status IN ('PAID', 'RELEASED')
  `;

  return {
    escrowHeldVnd,
    releasedVnd,
    gatewayCashVnd,
    platformFeeVnd,
    refundPayableVnd,
    grossVolumeVnd: Number(grossVolumeRows[0]?.v ?? 0),
    orderCounts,
    pendingOrderCount: orderCounts['PENDING_PAYMENT'] ?? 0,
    stuckOrders,
    eventsAwaitingRelease: awaiting.map((a) => ({
      eventId: a.event_id,
      eventName: a.event_name,
      startsAt: a.starts_at,
      paidOrders: Number(a.paid_orders),
      escrowVnd: Number(a.escrow_vnd),
    })),
    sellerEscrows,
  };
}

/**
 * Every order of the platform, newest first - the operator needs the full
 * list, not just the stuck ones.
 */
export async function listAllOrders(
  sql: Db,
  limit = 100,
): Promise<
  Array<{
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
  }>
> {
  return await withTx(sql, async (tx) => {
    const rows = await tx<
      Array<{
        id: string;
        status: string;
        event_name: string;
        buyer_name: string;
        seller_name: string;
        quantity: number;
        gross_vnd: string;
        seller_net_vnd: string;
        platform_fee_vnd: string;
        created_at: string;
        paid_at: string | null;
        released_at: string | null;
      }>
    >`
      SELECT
        o.id, o.status, o.quantity, o.gross_vnd, o.seller_net_vnd, o.platform_fee_vnd,
        o.created_at, o.paid_at, o.released_at,
        e.name AS event_name,
        b.name AS buyer_name,
        s.name AS seller_name
      FROM orders o
      JOIN events e ON e.id = o.event_id
      JOIN users  b ON b.id = o.buyer_id
      JOIN users  s ON s.id = o.seller_id
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      eventName: r.event_name,
      buyerName: r.buyer_name,
      sellerName: r.seller_name,
      quantity: r.quantity,
      grossVnd: Number(r.gross_vnd),
      sellerNetVnd: Number(r.seller_net_vnd),
      platformFeeVnd: Number(r.platform_fee_vnd),
      createdAt: r.created_at,
      paidAt: r.paid_at,
      releasedAt: r.released_at,
    }));
  });
}
