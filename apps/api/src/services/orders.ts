import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import { computeFees } from '@tce/shared';
import { ensureUserAccounts, getAccountByCode } from '../db/accounts.js';
import { postEscrowRelease, postPaymentCapture } from './ledger.js';

/**
 * Order lifecycle and money movement.
 *
 *   PENDING_PAYMENT --(IPN success)--> PAID  (money captured, seller money escrowed)
 *   PAID            --(event completed)--> RELEASED (escrow -> seller available)
 *   PENDING_PAYMENT --(IPN failure / timeout)--> FAILED | CANCELLED
 */

export interface OrderRow {
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
  gateway: string;
  idempotency_key: string | null;
  created_at: string;
  paid_at: string | null;
  released_at: string | null;
}

export interface ListingRow {
  id: string;
  event_id: string;
  seller_id: string;
  title: string;
  quantity_total: number;
  quantity_sold: number;
  price_vnd: string;
}

export class OrderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/**
 * Creates a PENDING_PAYMENT order and reserves the requested quantity.
 *
 * The reservation happens here (not at payment time) so two buyers cannot
 * buy the same last ticket. The row lock makes concurrent checkouts safe.
 */
export async function createOrder(
  sql: Db,
  args: {
    buyerId: string;
    listingId: string;
    quantity: number;
    /** optional client-supplied key; a repeated key returns the same order */
    idempotencyKey?: string | null;
  },
): Promise<OrderRow> {
  if (!Number.isSafeInteger(args.quantity) || args.quantity <= 0) {
    throw new OrderError('So luong khong hop le', 'INVALID_QUANTITY');
  }

  return await withTx(sql, async (tx) => {
    // Idempotency: a double-tapped "Pay" button sends the same key twice.
    // Return the original order instead of reserving a second batch of
    // tickets and creating a second payment.
    if (args.idempotencyKey) {
      const existing = await tx<OrderRow[]>`
        SELECT * FROM orders
        WHERE buyer_id = ${args.buyerId}
          AND idempotency_key = ${args.idempotencyKey}
        LIMIT 1
      `;
      if (existing[0]) {
        return existing[0];
      }
    }

    const listings = await tx<ListingRow[]>`
      SELECT id, event_id, seller_id, title, quantity_total, quantity_sold, price_vnd
      FROM listings
      WHERE id = ${args.listingId}
      FOR UPDATE
    `;
    const listing = listings[0];
    if (!listing) {
      throw new OrderError('Khong tim thay listing', 'LISTING_NOT_FOUND', 404);
    }

    // A ticket for an event that already happened can never be released from
    // escrow: the money would be trapped with no way out. Refuse the
    // checkout instead.
    const events = await tx<{ status: string }[]>`
      SELECT status FROM events WHERE id = ${listing.event_id}
    `;
    if (events[0]?.status === 'completed') {
      throw new OrderError(
        'Su kien nay da hoan tat, khong ban duoc ve nua',
        'EVENT_COMPLETED',
        409,
      );
    }

    const remaining = listing.quantity_total - listing.quantity_sold;
    if (remaining < args.quantity) {
      throw new OrderError(
        `Chi con ${remaining} ve cho listing nay`,
        'INSUFFICIENT_QUANTITY',
        409,
      );
    }

    const fees = computeFees(Number(listing.price_vnd), args.quantity);

    const rows = await tx<OrderRow[]>`
      INSERT INTO orders (
        buyer_id, listing_id, event_id, seller_id, quantity,
        unit_price_vnd, subtotal_vnd, buyer_fee_vnd, seller_fee_vnd,
        gross_vnd, seller_net_vnd, platform_fee_vnd, status, gateway,
        idempotency_key
      )
      VALUES (
        ${args.buyerId}, ${listing.id}, ${listing.event_id}, ${listing.seller_id}, ${args.quantity},
        ${listing.price_vnd}, ${fees.subtotalVnd}, ${fees.buyerFeeVnd}, ${fees.sellerFeeVnd},
        ${fees.grossVnd}, ${fees.sellerNetVnd}, ${fees.platformFeeVnd},
        'PENDING_PAYMENT', 'vnpay', ${args.idempotencyKey ?? null}
      )
      RETURNING *
    `;
    const order = rows[0]!;

    await tx`
      UPDATE listings
      SET quantity_sold = quantity_sold + ${args.quantity}
      WHERE id = ${listing.id}
    `;

    return order;
  });
}

export interface HandleIpnArgs {
  orderId: string;
  amountVnd: number;
  transactionId: string;
  transactionRef?: string | null;
  ok: boolean;
  code: string;
  raw: Record<string, string>;
}

/**
 * Applies a gateway notification to an order.
 *
 * Idempotency: the (provider, provider_txn_id) unique constraint on payments
 * guarantees a repeated IPN can only insert one payment row. The order row is
 * locked FOR UPDATE so two concurrent IPNs cannot both post to the ledger.
 */
export async function handleIpn(
  sql: Db,
  args: HandleIpnArgs,
): Promise<{ status: string; applied: boolean; order: OrderRow }> {
  return await withTx(sql, async (tx) => {
    const orders = await tx<OrderRow[]>`
      SELECT * FROM orders WHERE id = ${args.orderId} FOR UPDATE
    `;
    const order = orders[0];
    if (!order) {
      throw new OrderError('Khong tim thay don hang', 'ORDER_NOT_FOUND', 404);
    }

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO payments (
        order_id, provider, provider_txn_id, provider_txn_ref,
        amount_vnd, status, raw_payload
      )
      VALUES (
        ${args.orderId}, 'vnpay', ${args.transactionId}, ${args.transactionRef ?? null},
        ${args.amountVnd}, ${args.ok ? 'SUCCEEDED' : 'FAILED'}, ${tx.json(args.raw as never)}
      )
      ON CONFLICT (provider, provider_txn_id) DO NOTHING
      RETURNING id
    `;

    const isNewNotification = inserted.length > 0;

    if (!args.ok) {
      if (order.status === 'PENDING_PAYMENT') {
        await tx`
          UPDATE orders
          SET status = 'FAILED'
          WHERE id = ${args.orderId}
        `;
        await tx`
          UPDATE listings
          SET quantity_sold = quantity_sold - ${order.quantity}
          WHERE id = ${order.listing_id}
        `;
      }
      const refreshed = await tx<OrderRow[]>`SELECT * FROM orders WHERE id = ${args.orderId}`;
      return { status: refreshed[0]!.status, applied: isNewNotification, order: refreshed[0]! };
    }

    if (order.status === 'PENDING_PAYMENT') {
      if (Number(order.gross_vnd) !== args.amountVnd) {
        throw new OrderError(
          `So tien khong khop: order ${order.gross_vnd} vs IPN ${args.amountVnd}`,
          'AMOUNT_MISMATCH',
          400,
        );
      }

      const sellerId = order.seller_id;
      const sellerName = (
        await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${sellerId}`
      )[0]?.name ?? sellerId;
      await ensureUserAccounts(tx, sellerId, sellerName);

      await postPaymentCapture(tx, {
        orderId: order.id,
        sellerId,
        grossVnd: Number(order.gross_vnd),
        sellerNetVnd: Number(order.seller_net_vnd),
        platformFeeVnd: Number(order.platform_fee_vnd),
        memo: `Thanh toan don hang ${order.id}`,
      });

      await tx`
        UPDATE orders
        SET status = 'PAID', paid_at = now()
        WHERE id = ${args.orderId}
      `;
    }

    const refreshed = await tx<OrderRow[]>`SELECT * FROM orders WHERE id = ${args.orderId}`;
    return {
      status: refreshed[0]!.status,
      applied: isNewNotification,
      order: refreshed[0]!,
    };
  });
}

/**
 * Releases escrowed money for every paid order of an event.
 *
 * Runs in one DB transaction so an event is either fully released or not at
 * all. Each order gets its own ledger transaction so the ledger stays
 * traceable back to the order.
 *
 * Orders that are still PENDING_PAYMENT are cancelled and their reserved
 * tickets are returned to the listing: the event is over, so they can never
 * be paid for, and leaving them pending would keep the quantity reserved
 * forever.
 */
export async function releaseEventEscrow(
  sql: Db,
  args: { eventId: string },
): Promise<{ released: number; releasedVnd: number; cancelled: number; orderIds: string[] }> {
  return await withTx(sql, async (tx) => {
    const orders = await tx<OrderRow[]>`
      SELECT * FROM orders
      WHERE event_id = ${args.eventId} AND status IN ('PAID', 'PENDING_PAYMENT')
      FOR UPDATE
    `;

    let releasedVnd = 0;
    let cancelled = 0;
    const orderIds: string[] = [];

    for (const order of orders) {
      if (order.status === 'PENDING_PAYMENT') {
        // never paid, never escrowed - just give the tickets back
        await tx`
          UPDATE orders SET status = 'CANCELLED' WHERE id = ${order.id}
        `;
        await tx`
          UPDATE listings
          SET quantity_sold = quantity_sold - ${order.quantity}
          WHERE id = ${order.listing_id}
        `;
        cancelled += 1;
        continue;
      }

      const amount = Number(order.seller_net_vnd);
      if (amount <= 0) continue;

      const pending = await getAccountByCode(
        tx,
        `liability:user:${order.seller_id}:pending`,
      );
      if (!pending) {
        throw new Error(`Khong tim thay tai khoan escrow cua ${order.seller_id}`);
      }

      await postEscrowRelease(tx, {
        orderId: order.id,
        sellerId: order.seller_id,
        amountVnd: amount,
        memo: `Giai ngan escrow don hang ${order.id}`,
      });

      await tx`
        UPDATE orders
        SET status = 'RELEASED', released_at = now()
        WHERE id = ${order.id}
      `;

      releasedVnd += amount;
      orderIds.push(order.id);
    }

    await tx`
      UPDATE events SET status = 'completed' WHERE id = ${args.eventId}
    `;

    return { released: orderIds.length, releasedVnd, cancelled, orderIds };
  });
}

export async function getOrderStatus(
  sql: Db,
  orderId: string,
): Promise<OrderRow | undefined> {
  const rows = await sql<OrderRow[]>`SELECT * FROM orders WHERE id = ${orderId} LIMIT 1`;
  return rows[0];
}
