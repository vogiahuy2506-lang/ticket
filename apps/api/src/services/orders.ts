import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import { computeFees, toGatewayRef } from '@tce/shared';
import { ensurePlatformAccounts, ensureUserAccounts, getAccountByCode } from '../db/accounts.js';
import { postEscrowRelease, postLatePaymentRefund, postPaymentCapture } from './ledger.js';
import {
  VNPAY_AMOUNT_FACTOR,
  VNPAY_AMOUNT_MAX_DIGITS,
} from '../payments/vnpay.js';

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
  gateway_ref: string | null;
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

    // The lock order matters: the event row is locked *before* the listing
    // row, and the escrow release does the same. If the two locked them in
    // opposite orders, the database would deadlock:
    //
    //   checkout                     escrow release
    //   ---------------------------  ---------------------------
    //   holds listing row            holds event row
    //   wants event row  (SHARE)     wants listing row (UPDATE)
    //
    // So the event is locked first, in both places. The listing's event is
    // read without a lock first - it never changes, but the lock has to be
    // taken in the right order.
    const listingRefs = await tx<{ event_id: string }[]>`
      SELECT event_id FROM listings WHERE id = ${args.listingId}
    `;
    if (!listingRefs[0]) {
      throw new OrderError('Không tìm thấy listing', 'LISTING_NOT_FOUND', 404);
    }
    const eventId = listingRefs[0].event_id;

    // A ticket for an event that already happened can never be released from
    // escrow: the money would be trapped with no way out. Refuse the
    // checkout instead.
    //
    // The event row is locked FOR SHARE, which is what closes the race with
    // the escrow release:
    //
    //   checkout                          escrow release
    //   --------------------------------  ---------------------------------
    //   SELECT ... FOR SHARE on events     SELECT ... FOR UPDATE on events
    //   (holds a shared lock)              (waits for the shared lock)
    //   ... inserts the order              ... marks the event completed
    //
    // Without the lock, the checkout could read `scheduled`, the release
    // could commit in between, and the order would be created for an event
    // that is already over - its money would sit in escrow with nobody left
    // to release it. The reverse order is safe: the release waits for the
    // checkout to finish, and the checkout's order is then included in the
    // release.
    const events = await tx<{ status: string }[]>`
      SELECT status FROM events WHERE id = ${eventId} FOR SHARE
    `;
    if (events[0]?.status === 'completed') {
      throw new OrderError(
        'Sự kiện này đã hoàn tất, không bán được vé nữa',
        'EVENT_COMPLETED',
        409,
      );
    }

    // The listing row is locked FOR UPDATE, so two buyers cannot reserve
    // the same last ticket.
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

    // A free ticket cannot be paid for: the ledger rejects a zero-amount
    // posting, so the capture would throw *after* the buyer had been
    // charged - the money would be taken and never booked. The database
    // refuses a zero price too; this is the third line of defence, in
    // the code that is easiest to read.
    if (fees.grossVnd <= 0) {
      throw new OrderError(
        'Vé này có giá 0 nên không thể thanh toán',
        'INVALID_PRICE',
        409,
      );
    }

    // The payment gateway caps `vnp_Amount` at 12 characters, and the
    // wire value is the amount multiplied by 100 - so an order above
    // ~10 billion VND cannot be sent to the gateway at all. The order is
    // refused here, where the buyer gets a clear message, instead of
    // sending them to a payment page that would never work.
    if (String(fees.grossVnd * VNPAY_AMOUNT_FACTOR).length > VNPAY_AMOUNT_MAX_DIGITS) {
      throw new OrderError(
        'Tổng tiền của đơn hàng này vượt quá giới hạn của cổng thanh toán',
        'AMOUNT_TOO_LARGE',
        409,
      );
    }

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

    // The reference the gateway knows this order by.
    //
    // `vnp_TxnRef` is `Alphanumeric[1,100]`, so the UUID cannot be used
    // as-is - it has dashes. The reference is the UUID without them, which
    // keeps it traceable back to the order. The order keeps the UUID as
    // its primary key; the reference is what an incoming notification is
    // matched on.
    const gatewayRef = toGatewayRef(order.id);
    await tx`
      UPDATE orders SET gateway_ref = ${gatewayRef} WHERE id = ${order.id}
    `;
    order.gateway_ref = gatewayRef;

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
 * Whether the gateway should be asked about this order.
 *
 * The gateway is the second source of truth: an IPN can be lost (the tunnel
 * was closed, the URL was not registered, the gateway could not reach us)
 * while the buyer *did* pay. The re-check asks the gateway, so a lost
 * notification can still be recovered.
 *
 * Two statuses qualify, and the second one is the important one:
 *
 *  - `PENDING_PAYMENT` - the obvious case: the order is waiting for the
 *    gateway.
 *  - `EXPIRED` - the lazy sweep released the *ticket*, but it says
 *    nothing about the money. If the buyer paid and the notification was
 *    lost, the money is sitting at the gateway while the order says
 *    "expired" - and without this the order would never find it again.
 *    The money would be stranded until somebody noticed it in the
 *    gateway's own report.
 *
 * The settled orders must *not* be asked about: their money is already
 * booked (as a capture, as a refund, or as a released escrow), so a
 * second answer would only duplicate it.
 */
export function canQueryGateway(status: string): boolean {
  return status === 'PENDING_PAYMENT' || status === 'EXPIRED';
}

/**
 * What to do with the answer the gateway gave to a `querydr` call.
 *
 * The rule is deliberately narrow, because the query is a *second* source
 * of truth and it can be wrong in ways an IPN cannot:
 *
 *  - the query answers about a transaction the gateway may not even know
 *    yet. A brand new payment is reported as "not found" (code 91), which
 *    is **not** the same thing as "the buyer declined". Applying that
 *    would cancel the order and give the tickets back *while the buyer is
 *    paying* - the money would arrive afterwards for an order that is no
 *    longer pending, and it would be booked as a late payment instead of
 *    a purchase.
 *  - a success without a transaction number cannot be applied safely: the
 *    number is what identifies the payment. Applying it under an invented
 *    number would book the money twice - the real IPN that arrives later
 *    would look like a *second* payment and be refunded, inventing a
 *    liability out of nothing.
 *
 * So the query is only ever used to *recover* a success that was lost on
 * the way here. Only the IPN - the gateway's own, signed, server-to-server
 * statement about what happened - can say that a payment failed.
 */
export type QueryOutcome =
  | { action: 'apply'; transactionId: string }
  | { action: 'skip'; reason: string };

export function decideQueryOutcome(
  answered: {
    signatureValid: boolean;
    ok: boolean;
    transactionId?: string;
    amountVnd?: number;
  },
  expectedAmountVnd: number,
): QueryOutcome {
  if (!answered.signatureValid) {
    return { action: 'skip', reason: 'the answer is not correctly signed' };
  }
  if (answered.amountVnd !== expectedAmountVnd) {
    return { action: 'skip', reason: 'the amount does not match the order' };
  }
  if (!answered.ok) {
    return {
      action: 'skip',
      reason: 'the gateway reports no successful payment for this order yet',
    };
  }
  if (!answered.transactionId) {
    return { action: 'skip', reason: 'the answer carries no transaction number' };
  }
  return { action: 'apply', transactionId: answered.transactionId };
}

/**
 * Applies a gateway notification to an order.
 *
 * Idempotency: the unique constraints on `payments` guarantee a repeated
 * IPN can only insert one payment row. The order row is locked FOR UPDATE
 * so two concurrent IPNs cannot both post to the ledger.
 *
 * The conflict target is deliberately left off the INSERT: a replay of the
 * same notification hits `UNIQUE (provider, order_id, provider_txn_id)`,
 * while a *second real payment* for a different order that happens to carry
 * the same transaction number hits the partial index on the successful
 * rows. `ON CONFLICT DO NOTHING` without a target covers both.
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
      ON CONFLICT DO NOTHING
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
          buyerId: order.buyer_id,
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
        buyerId: order.buyer_id,
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
    // The event row is locked FOR UPDATE, which is the other half of the
    // race with the checkout: the checkout takes a *shared* lock on the
    // same row (`FOR SHARE`), so the two transactions serialise.
    //
    //   checkout                          escrow release
    //   --------------------------------  ---------------------------------
    //   SELECT ... FOR SHARE on events     SELECT ... FOR UPDATE on events
    //   (holds a shared lock)              (waits for the shared lock)
    //   ... inserts the order              ... releases every paid order
    //
    // Without the lock, the release could finish first and the checkout
    // would then create an order for an event that is already over - its
    // money would sit in escrow with nobody left to release it.
    //
    // The lock is taken *before* the orders are read, so the release
    // always sees the orders that exist at that moment - including a
    // checkout that was waiting for the lock.
    const eventRows = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM events WHERE id = ${args.eventId} FOR UPDATE
    `;
    if (!eventRows[0]) {
      throw new OrderError('Không tìm thấy sự kiện', 'EVENT_NOT_FOUND', 404);
    }

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

/**
 * Cancels an order that is still waiting for its payment.
 *
 * A buyer who changed their mind should not have to wait 15 minutes for the
 * reservation to expire - the tickets are theirs to release right now, so
 * somebody else can buy them.
 *
 * Only a `PENDING_PAYMENT` order can be cancelled. Once the money has
 * arrived the order is settled: cancelling it would mean taking the
 * tickets back from a buyer who already paid, which is a *refund*, not a
 * cancellation. The refund API is out of scope for this task, so the
 * order is refused with a clear error instead of being silently mishandled.
 */
export async function cancelOrder(
  sql: Db,
  args: { orderId: string; buyerId: string },
): Promise<{ cancelled: boolean; order: OrderRow }> {
  return await withTx(sql, async (tx) => {
    const orders = await tx<OrderRow[]>`
      SELECT * FROM orders WHERE id = ${args.orderId} FOR UPDATE
    `;
    const order = orders[0];
    if (!order) {
      throw new OrderError('Không tìm thấy đơn hàng', 'ORDER_NOT_FOUND', 404);
    }

    // Only the buyer may cancel their own order.
    if (order.buyer_id !== args.buyerId) {
      throw new OrderError(
        'Bạn không thể hủy đơn hàng của người khác',
        'FORBIDDEN',
        403,
      );
    }

    if (order.status !== 'PENDING_PAYMENT') {
      throw new OrderError(
        `Đơn hàng đang ở trạng thái ${order.status} nên không thể hủy`,
        'ORDER_NOT_CANCELLABLE',
        409,
      );
    }

    await tx`
      UPDATE orders SET status = 'CANCELLED' WHERE id = ${args.orderId}
    `;
    await tx`
      UPDATE listings
      SET quantity_sold = quantity_sold - ${order.quantity}
      WHERE id = ${order.listing_id}
    `;

    const refreshed = await tx<OrderRow[]>`SELECT * FROM orders WHERE id = ${args.orderId}`;
    return { cancelled: true, order: refreshed[0]! };
  });
}

export interface OrderSummary {
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
}

/**
 * The orders of one user, newest first.
 *
 * Without this the buyer has no way back to an order: the order page is
 * reached by URL, and the URL comes from the gateway's redirect. A buyer
 * who closes the tab, or who buys on a phone and reads the receipt on a
 * laptop, has nothing to click on - and a buyer who *paid* cannot see
 * that the payment is in escrow.
 *
 * The same list serves the buyer and the seller: a seller wants to see
 * what they sold too, so the role decides which side of the order is the
 * user's.
 */
export async function listOrdersForUser(
  sql: Db,
  userId: string,
  role: 'buyer' | 'seller' | 'admin' = 'buyer',
  limit = 50,
): Promise<OrderSummary[]> {
  // An operator sees every order, a buyer the ones they bought, and a
  // seller *both* the ones they sold and the ones they bought - any user
  // may buy (a seller is very often a buyer too), so hiding the purchases
  // from a seller would make money disappear from their own list.
  const where =
    role === 'admin'
      ? sql`TRUE`
      : role === 'seller'
        ? sql`(o.seller_id = ${userId} OR o.buyer_id = ${userId})`
        : sql`o.buyer_id = ${userId}`;

  const rows = await sql<
    Array<{
      id: string;
      status: string;
      quantity: number;
      gross_vnd: string;
      seller_net_vnd: string;
      platform_fee_vnd: string;
      created_at: string;
      paid_at: string | null;
      released_at: string | null;
      expires_at: string;
      event_id: string;
      event_name: string;
      event_starts_at: string;
      event_status: string;
      listing_title: string;
      buyer_id: string;
      buyer_name: string;
      seller_id: string;
      seller_name: string;
    }>
  >`
    SELECT
      o.id, o.status, o.quantity, o.gross_vnd, o.seller_net_vnd, o.platform_fee_vnd,
      o.created_at, o.paid_at, o.released_at, o.expires_at,
      o.event_id, o.buyer_id, o.seller_id,
      e.name AS event_name, e.starts_at AS event_starts_at, e.status AS event_status,
      l.title AS listing_title,
      b.name AS buyer_name,
      s.name AS seller_name
    FROM orders o
    JOIN events  e ON e.id = o.event_id
    JOIN listings l ON l.id = o.listing_id
    JOIN users   b ON b.id = o.buyer_id
    JOIN users   s ON s.id = o.seller_id
    WHERE ${where}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    quantity: r.quantity,
    grossVnd: Number(r.gross_vnd),
    sellerNetVnd: Number(r.seller_net_vnd),
    platformFeeVnd: Number(r.platform_fee_vnd),
    createdAt: r.created_at,
    paidAt: r.paid_at,
    releasedAt: r.released_at,
    expiresAt: r.expires_at,
    eventId: r.event_id,
    eventName: r.event_name,
    eventStartsAt: r.event_starts_at,
    eventStatus: r.event_status,
    listingTitle: r.listing_title,
    buyerId: r.buyer_id,
    buyerName: r.buyer_name,
    sellerId: r.seller_id,
    sellerName: r.seller_name,
  }));
}

/**
 * Finds an order by the reference the payment gateway knows it by.
 *
 * The reference is what `vnp_TxnRef` carries, and it is alphanumeric, so
 * it is *not* the order's UUID. The order's UUID is accepted as a fallback
 * so an operator can look an order up by either.
 */
export async function findOrderByReference(
  sql: Db,
  reference: string,
): Promise<OrderRow | undefined> {
  const rows = await sql<OrderRow[]>`
    SELECT * FROM orders
    WHERE gateway_ref = ${reference}
       OR id::text = ${reference}
    LIMIT 1
  `;
  return rows[0];
}
