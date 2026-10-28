import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import { computeFees } from '@tce/shared';
import { ensurePlatformAccounts, ensureUserAccounts, getAccountByCode } from '../db/accounts.js';
import { postEscrowRelease, postLatePaymentRefund, postPaymentCapture } from './ledger.js';

/**
 * Order lifecycle and money movement.
 *
 *   PENDING_PAYMENT --(IPN success)--> PAID  (money captured, seller money escrowed)
 *   PAID            --(event completed)--> RELEASED (escrow -> seller available)
 *   PENDING_PAYMENT --(IPN failure)--> FAILED (tickets go back to the listing)
 *   PENDING_PAYMENT --(reservation expires)--> EXPIRED (tickets go back)
 *   PENDING_PAYMENT --(IPN success, but the reservation had expired)-->
 *     REFUND_REQUIRED (the buyer paid but the seller no longer gets the money;
 *     the amount is booked as owed to the buyer, not as seller escrow)
 */

export const ORDER_RESERVATION_MINUTES = 15;

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
  expires_at: string;
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
    throw new OrderError('Số lượng không hợp lệ', 'INVALID_QUANTITY');
  }

  // Lazy sweep: free the tickets of abandoned checkouts before we take the
  // row lock, so a buyer does not see "sold out" because of a dead order.
  await expireStaleOrders(sql);

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
      throw new OrderError('Không tìm thấy listing', 'LISTING_NOT_FOUND', 404);
    }

    // A ticket for an event that already happened can never be released from
    // escrow: the money would be trapped with no way out. Refuse the
    // checkout instead.
    const events = await tx<{ status: string }[]>`
      SELECT status FROM events WHERE id = ${listing.event_id}
    `;
    if (events[0]?.status === 'completed') {
      throw new OrderError(
        'Sự kiện này đã hoàn tất, không bán được vé nữa',
        'EVENT_COMPLETED',
        409,
      );
    }

    // A seller cannot buy their own listing: the money would move from the
    // seller to the seller, the platform fee would be invented, and the
    // escrow would be nonsense.
    if (listing.seller_id === args.buyerId) {
      throw new OrderError(
        'Bạn không thể mua vé của chính mình',
        'OWN_LISTING',
        409,
      );
    }

    const remaining = listing.quantity_total - listing.quantity_sold;
    if (remaining < args.quantity) {
      throw new OrderError(
        `Chỉ còn ${remaining} vé cho listing này`,
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
        idempotency_key, expires_at
      )
      VALUES (
        ${args.buyerId}, ${listing.id}, ${listing.event_id}, ${listing.seller_id}, ${args.quantity},
        ${listing.price_vnd}, ${fees.subtotalVnd}, ${fees.buyerFeeVnd}, ${fees.sellerFeeVnd},
        ${fees.grossVnd}, ${fees.sellerNetVnd}, ${fees.platformFeeVnd},
        'PENDING_PAYMENT', 'vnpay', ${args.idempotencyKey ?? null},
        now() + (${ORDER_RESERVATION_MINUTES} * interval '1 minute')
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

/**
 * Releases the ticket reservations of orders that were never paid for.
 *
 * Decision (brief was silent): the reservation is held for 15 minutes. When
 * that passes, the buyer has abandoned the checkout and the tickets must go
 * back to the listing - otherwise one abandoned checkout permanently removes
 * tickets from the market.
 *
 * The expiry is processed *lazily*: there is no cron, the sweep runs when
 * the app touches the orders (listing page, checkout, new order, event
 * completion). A lazy sweep is enough for a marketplace of this size and it
 * removes a whole class of "the background job silently died" bugs. A cron
 * is listed in the README under "not production ready".
 *
 * The sweep is idempotent: only PENDING_PAYMENT orders that are past their
 * expiry are touched, and the ticket count is returned exactly once.
 */
export async function expireStaleOrders(sql: Db): Promise<{ expired: number }> {
  return await withTx(sql, async (tx) => {
    const expired = await tx<{ id: string; listing_id: string; quantity: number }[]>`
      UPDATE orders
         SET status = 'EXPIRED'
       WHERE status = 'PENDING_PAYMENT'
         AND expires_at < now()
      RETURNING id, listing_id, quantity
    `;

    for (const order of expired) {
      await tx`
        UPDATE listings
           SET quantity_sold = quantity_sold - ${order.quantity}
         WHERE id = ${order.listing_id}
      `;
    }

    return { expired: expired.length };
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
      throw new OrderError('Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND', 404);
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

    // The amount on the notification must match the order we reserved, in
    // every case. It is checked before anything is written, so a wrong
    // amount can never move money.
    if (Number(order.gross_vnd) !== args.amountVnd) {
      throw new OrderError(
        `Số tiền không khớp: order ${order.gross_vnd} vs IPN ${args.amountVnd}`,
        'AMOUNT_MISMATCH',
        400,
      );
    }

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

    // The money arrived. From here on the order must end up in a state that
    // accounts for the money - never in a state where the buyer paid and
    // nothing was booked.
    //
    // Which state depends on whether the order can still be fulfilled:
    //   PENDING_PAYMENT + reservation valid -> a normal capture
    //   PENDING_PAYMENT + reservation gone  -> a late payment (refund owed)
    //   EXPIRED                           -> a late payment (refund owed)
    //   anything else (FAILED, CANCELLED,
    //   RELEASED, PAID, REFUND_REQUIRED)  -> the order can no longer be
    //     fulfilled, so the money is booked as owed to the buyer
    if (order.status === 'PENDING_PAYMENT' || order.status === 'EXPIRED') {
      // The reservation had already expired - the tickets were sold to
      // somebody else in the meantime. The seller must not get this money
      // (the buyer no longer has a ticket), but the buyer did pay, so the
      // amount is booked as a liability towards them and refunded out of
      // band. This is the "late payment" case.
      const isLate =
        order.status === 'EXPIRED' ||
        new Date(order.expires_at).getTime() < Date.now();
      if (isLate) {
        await ensurePlatformAccounts(tx);

        // The sweep only ever touches PENDING_PAYMENT orders, so a ticket
        // that was still reserved here would never be given back - the
        // stock would leak away with every late payment. If the order was
        // still PENDING_PAYMENT the sweep has not run yet and the tickets
        // are still ours to return; if it was already EXPIRED the sweep has
        // returned them and we must not subtract them twice.
        if (order.status === 'PENDING_PAYMENT') {
          await tx`
            UPDATE listings
            SET quantity_sold = quantity_sold - ${order.quantity}
            WHERE id = ${order.listing_id}
          `;
        }

        await postLatePaymentRefund(tx, {
          orderId: order.id,
          amountVnd: Number(order.gross_vnd),
          memo: `Thanh toán đến muộn đơn hàng ${order.id}`,
        });
        await tx`
          UPDATE orders
          SET status = 'REFUND_REQUIRED', paid_at = now()
          WHERE id = ${args.orderId}
        `;
        const late = await tx<OrderRow[]>`SELECT * FROM orders WHERE id = ${args.orderId}`;
        return {
          status: late[0]!.status,
          applied: isNewNotification,
          order: late[0]!,
        };
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
        memo: `Thanh toán đơn hàng ${order.id}`,
      });

      await tx`
        UPDATE orders
        SET status = 'PAID', paid_at = now()
        WHERE id = ${args.orderId}
      `;
    } else if (isNewNotification) {
      // The order can no longer be fulfilled, but the buyer paid. Booking
      // nothing would make the money disappear: the gateway cash would not
      // grow and no liability towards the buyer would exist. The payment is
      // therefore booked as a refund payable, exactly like a late payment.
      //
      // This covers every remaining status:
      //   FAILED            - the buyer declined and then retried successfully
      //   CANCELLED         - the event was completed before the notification
      //   PAID              - the buyer paid twice (a second, real payment)
      //   RELEASED          - a second payment after the seller was paid out
      //   REFUND_REQUIRED   - a second payment after a late payment
      //
      // In every one of these cases the buyer handed over money that the
      // order does not account for, so the platform owes it back. The
      // original payment is untouched: the ledger keeps the first capture
      // and the second one becomes a liability towards the buyer.
      await ensurePlatformAccounts(tx);
      await postLatePaymentRefund(tx, {
        orderId: order.id,
        amountVnd: Number(order.gross_vnd),
        memo: `Thanh toán cho đơn hàng không thể thực hiện ${order.id}`,
      });
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
  // Free the tickets of abandoned checkouts first, so they are not
  // double-returned below.
  await expireStaleOrders(sql);

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
        throw new Error(`Không tìm thấy tài khoản escrow của ${order.seller_id}`);
      }

      await postEscrowRelease(tx, {
        orderId: order.id,
        sellerId: order.seller_id,
        amountVnd: amount,
        memo: `Giải ngân escrow đơn hàng ${order.id}`,
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
