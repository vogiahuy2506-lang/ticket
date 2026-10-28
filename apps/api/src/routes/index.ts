import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkoutSchema, computeFees, createEventSchema, uuidSchema } from '@tce/shared';
import { providerFor, type AppDeps } from './helpers.js';
import {
  cancelOrder,
  canQueryGateway,
  createOrder,
  decideQueryOutcome,
  expireStaleOrders,
  findOrderByReference,
  getOrderStatus,
  handleIpn,
  listOrdersForUser,
  OrderError,
  releaseEventEscrow,
} from '../services/orders.js';
import {
  auditLedger,
  computeBalances,
  getUserBalances,
  listTransactions,
  listTransactionsForUser,
} from '../services/ledger.js';
import { getAdminOverview, listAllOrders } from '../services/admin.js';
import { createEvent, CreateEventError } from '../services/events.js';
import { registerMockGatewayRoutes } from './mock-gateway.js';
import { actorFrom, requireRole } from '../auth.js';
import { RateLimiter } from '../rate-limit.js';
import { withTx } from '../db/types.js';

/**
 * The buyer's IP address, in the shape the payment gateway accepts.
 *
 * The gateway's `vnp_IpAddr` parameter is `Alphanumeric[7,45]`, so it has
 * to be a plain IPv4 address - an IPv6 address is too long for 45
 * characters, and `::1` is too short for 7.
 *
 * The API is behind the storefront, so `req.ip` is the *storefront's*
 * address, not the buyer's. The storefront forwards the real address in
 * `x-forwarded-for`, so the first entry of that header is the one that
 * belongs to the buyer.
 */
function clientIpFrom(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = (first?.split(',')[0] ?? req.ip ?? '').trim();
  return candidate || '127.0.0.1';
}

/**
 * Checks that a path parameter is a UUID.
 *
 * Every id in this system is a UUID, and a path parameter that is not one
 * names a row that cannot exist. Answering "404 not found" straight away
 * keeps a typo or a truncated id out of the database, where PostgreSQL
 * would reject it and turn a bad URL into a 500.
 */
function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const deps = app as unknown as AppDeps;
  const { sql, config } = deps;

  // ---------------------------------------------------------------- users
  app.get('/api/users', async () => {
    const users = await sql`
      SELECT id, name, role FROM users ORDER BY role, name
    `;
    return { users };
  });

  // --------------------------------------------------------------- events
  app.get('/api/events', async () => {
    // Lazy sweep: release the reservations of abandoned checkouts before
    // the ticket counts are shown, so a buyer never sees a ticket that is
    // actually free.
    await expireStaleOrders(sql);
    const events = await sql`
      SELECT e.id, e.name, e.venue, e.starts_at, e.status,
             COUNT(l.id)::int AS listing_count,
             COALESCE(SUM(l.quantity_total - l.quantity_sold), 0)::int AS tickets_left
      FROM events e
      LEFT JOIN listings l ON l.event_id = e.id
      GROUP BY e.id
      ORDER BY e.starts_at
    `;
    return { events };
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) {
      return reply.code(404).send({ error: 'EVENT_NOT_FOUND' });
    }
    await expireStaleOrders(sql);
    const events = await sql`
      SELECT id, name, venue, starts_at, status FROM events WHERE id = ${req.params.id}
    `;
    const event = events[0];
    if (!event) return reply.code(404).send({ error: 'EVENT_NOT_FOUND' });

    const listings = await sql`
      SELECT l.id, l.title, l.quantity_total, l.quantity_sold,
             (l.quantity_total - l.quantity_sold) AS quantity_available,
             l.price_vnd, u.id AS seller_id, u.name AS seller_name
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.event_id = ${req.params.id}
      ORDER BY l.price_vnd
    `;
    return { event, listings };
  });

  // -------------------------------------------------------------- checkout
  app.post('/api/checkout', async (req, reply) => {
    const body = req.body as { buyerId?: string; listingId?: string; quantity?: number };
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.flatten() });
    }
    const { listingId, quantity } = parsed.data;

    // The buyer is the acting user, not whatever the body claims. The
    // storefront sends the session's user id in the header, and the role
    // is looked up in the database, so a caller cannot buy as somebody
    // else by editing a request body.
    const actor = await actorFrom(sql, req);
    if (!actor) {
      return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
    }
    const buyerId = actor.id;

    // Optional Idempotency-Key. The storefront sends a key per checkout
    // attempt, so a double-tapped "Pay" button returns the original order
    // instead of reserving a second batch of tickets.
    const idempotencyKey =
      typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].slice(0, 100)
        : null;

    try {
      const order = await createOrder(sql, {
        buyerId,
        listingId,
        quantity,
        idempotencyKey,
      });
      const provider = providerFor(deps);
      const payment = await provider.createPayment({
        orderId: order.id,
        gatewayRef: order.gateway_ref!,
        amountVnd: Number(order.gross_vnd),
        // The gateway wants an unaccented description without special
        // characters, so the text is normalised before it is sent.
        orderInfo: `Thanh toan don hang ${order.id.slice(0, 8)}`,
        // The buyer's address, not the address of the process that
        // happens to receive the request: the API is behind the
        // storefront, so `req.ip` is the storefront's address. The
        // storefront forwards the real one in `x-forwarded-for`.
        clientIp: clientIpFrom(req),
        // `querydr` has to send this date back later, so it is the order's.
        createdAt: new Date(order.created_at),
        returnUrl: `${config.webBaseUrl}/orders/${order.id}`,
        notifyUrl: `${config.publicBaseUrl}/api/ipn/vnpay`,
      });

      return {
        orderId: order.id,
        // The reference the gateway knows the order by. It is alphanumeric,
        // so it is not the order's UUID.
        gatewayRef: order.gateway_ref,
        redirectUrl: payment.redirectUrl,
        grossVnd: Number(order.gross_vnd),
      };
    } catch (err) {
      if (err instanceof OrderError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------- orders
  /**
   * The orders of one user.
   *
   * The order page is reached by URL, and the URL comes from the gateway's
   * redirect. Without this list a buyer who closes the tab - or who buys
   * on a phone and reads the receipt on a laptop - has no way back to the
   * order, and cannot see that their payment is sitting in escrow.
   *
   * `role` decides which side of the order is the user's: a buyer sees
   * what they bought, a seller what they sold, an operator everything.
   */
  app.get<{ Querystring: { userId?: string; role?: string } }>(
    '/api/orders',
    async (req, reply) => {
      const userId = req.query.userId;
      if (!userId) {
        return reply.code(400).send({ error: 'USER_ID_REQUIRED' });
      }

      const users = await sql<{ id: string; role: string }[]>`
        SELECT id, role FROM users WHERE id = ${userId} LIMIT 1
      `;
      const user = users[0];
      if (!user) {
        return reply.code(404).send({ error: 'USER_NOT_FOUND' });
      }

      // The role comes from the database, never from the query string:
      // a caller must not be able to ask for somebody else's orders.
      //
      // And the acting user has to be that user (or the operator). Without
      // this check, knowing somebody else's id is enough to read their
      // receipts.
      const actor = await actorFrom(sql, req);
      if (!actor) {
        return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
      }
      if (actor.id !== user.id && actor.role !== 'admin') {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: 'Bạn không thể xem đơn hàng của người khác',
        });
      }

      const orders = await listOrdersForUser(sql, user.id, user.role as 'buyer');
      return { orders };
    },
  );

  /**
   * Cancels an order that is still waiting for its payment.
   *
   * The buyer gives the tickets back right away instead of waiting for the
   * 15-minute reservation to expire, so somebody else can buy them. The
   * buyer is taken from the body - the brief has no authentication, and
   * the storefront always sends the current user.
   */
  app.post<{ Params: { id: string }; Body: { buyerId?: string } }>(
    '/api/orders/:id/cancel',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
      }
      // The buyer is the acting user. The body is not consulted, so a
      // caller cannot cancel somebody else's order by naming them.
      const actor = await actorFrom(sql, req);
      if (!actor) {
        return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
      }
      const buyerId = actor.id;

      try {
        const result = await cancelOrder(sql, { orderId: req.params.id, buyerId });
        return { cancelled: result.cancelled, status: result.order.status };
      } catch (err) {
        if (err instanceof OrderError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) {
      return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    }
    const order = await getOrderStatus(sql, req.params.id);
    if (!order) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });

    // A receipt shows what the buyer paid and what the seller earned, so
    // it belongs to the buyer, the seller and the operator - and to nobody
    // else. The order id comes from the gateway's redirect, so it is not
    // a secret.
    const actor = await actorFrom(sql, req);
    if (!actor) {
      return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
    }
    const involved =
      actor.id === order.buyer_id ||
      actor.id === order.seller_id ||
      actor.role === 'admin';
    if (!involved) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: 'Bạn không thể xem đơn hàng của người khác',
      });
    }

    const fees = computeFees(Number(order.unit_price_vnd), order.quantity);
    const payments = await sql`
      SELECT provider, provider_txn_id, provider_txn_ref, amount_vnd, status, created_at
      FROM payments WHERE order_id = ${req.params.id} ORDER BY created_at
    `;
    return { order, fees, payments };
  });

  /**
   * Called when the buyer returns from the gateway. It only *reads* the real
   * persisted status - the browser redirect never changes state. If the IPN
   * has not arrived yet the order is still PENDING_PAYMENT and the UI shows
   * "waiting for gateway confirmation" with a re-check button.
   *
   * The re-check also asks the gateway directly (`querydr`). An IPN can be
   * lost - the tunnel was closed, the IPN URL was not registered, the
   * gateway could not reach us - and the buyer's browser comes back all
   * the same. Without a second source, the order would sit in
   * `PENDING_PAYMENT` until the reservation expired, even though the buyer
   * had paid.
   *
   * The gateway's answer is only applied if it is correctly signed and the
   * amount matches the order. If the gateway cannot be reached, the re-check
   * simply reports the persisted status and nothing else happens.
   *
   * The gateway is only asked when the caller says so (`?gateway=1`): the
   * order page polls this endpoint every few seconds, and a poll that
   * called `querydr` each time would hit the gateway for as long as the
   * page stays open. The page asks once when it opens and when the buyer
   * presses the button; the polls only read the database.
   */
  type RecheckRoute = { Params: { id: string }; Querystring: { gateway?: string } };
  app.post<RecheckRoute>('/api/orders/:id/recheck', async (req, reply) => {
    if (!isUuid(req.params.id)) {
      return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    }
    const order = await getOrderStatus(sql, req.params.id);
    if (!order) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });

    // Same rule as the receipt itself: only the buyer, the seller and the
    // operator may ask about an order. The re-check can *move money* (it
    // applies a gateway answer), so it must not be callable by a stranger.
    const actor = await actorFrom(sql, req);
    if (!actor) {
      return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
    }
    const involved =
      actor.id === order.buyer_id ||
      actor.id === order.seller_id ||
      actor.role === 'admin';
    if (!involved) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: 'Bạn không thể kiểm tra đơn hàng của người khác',
      });
    }
    const askGateway = req.query.gateway === '1';

    // A payment that is still pending can be confirmed late - but so can
    // one that has already been marked EXPIRED by the lazy sweep. The
    // sweep only releases the *ticket*; it says nothing about the money.
    // If the buyer paid and the notification was lost, the money is
    // sitting at the gateway while the order says "expired" - and without
    // this the order would never find it again, so the money would be
    // stranded until somebody noticed it in the gateway's own report.
    //
    // The orders that must *not* be re-checked are the settled ones
    // (PAID, RELEASED, FAILED, CANCELLED, REFUND_REQUIRED): their money is
    // already booked, and a gateway answer would only duplicate it.
    if (askGateway && canQueryGateway(order.status) && order.gateway_ref) {
      const provider = providerFor(deps);
      const queried = await provider.queryTransaction?.({
        gatewayRef: order.gateway_ref,
        createdAt: new Date(order.created_at),
      });
      if (queried) {
        // The decision is made by a pure function, so the rule can be
        // tested without a gateway. Only a *success* that the gateway
        // itself reported is applied - a query can answer "not found"
        // for a payment that is still in flight, and applying that would
        // cancel the order while the buyer is paying.
        const outcome = decideQueryOutcome(queried, Number(order.gross_vnd));
        if (outcome.action === 'skip') {
          req.log.info(
            {
              orderId: order.id,
              code: queried.code,
              message: queried.message,
              reason: outcome.reason,
            },
            'the re-check did not apply the gateway answer',
          );
        } else {
          // The gateway answer is applied through the same handler the
          // IPN uses, so a late payment is booked exactly like a
          // notification. The handler can still refuse it (a race with
          // another notification, for instance) - and that refusal must
          // not turn the re-check into a 500 for the buyer.
          try {
            const result = await handleIpn(sql, {
              orderId: order.id,
              amountVnd: queried.amountVnd!,
              // The gateway's own transaction number, so a later IPN for
              // the same payment is recognised as a replay instead of a
              // second payment.
              transactionId: outcome.transactionId,
              transactionRef: queried.transactionRef ?? order.gateway_ref,
              ok: queried.ok,
              code: queried.code,
              raw: { ...queried.raw, vnp_Source: 'querydr' },
            });
            req.log.info(
              { orderId: order.id, status: result.status, applied: result.applied },
              're-check applied the gateway answer',
            );
          } catch (err) {
            if (err instanceof OrderError) {
              req.log.warn(
                { orderId: order.id, code: err.code, message: err.message },
                'the re-check could not apply the gateway answer',
              );
            } else {
              throw err;
            }
          }
        }
      }
    }

    const refreshed = await getOrderStatus(sql, req.params.id);
    return {
      status: refreshed?.status,
      paidAt: refreshed?.paid_at,
      releasedAt: refreshed?.released_at,
    };
  });

  // ------------------------------------------------------------------- IPN
  /**
   * Gateway notification endpoint (IPN / webhook).
   *
   * Contract with the gateway:
   *  - VNPay notifies with a **GET** request; a POST is accepted too so the
   *    local mock can post the same payload.
   *  - the answer is always HTTP 200 with a JSON body
   *    {"RspCode":"00","Message":"..."} so the gateway stops retrying.
   *  - RspCode follows the official list: 00 success, 01 order not found,
   *    02 already confirmed, 04 invalid amount, 97 invalid signature,
   *    99 invalid request.
   */
  const readIpnPayload = (req: FastifyRequest): Record<string, string> => {
    const source =
      req.method === 'GET'
        ? (req.query as Record<string, unknown>)
        : ((req.body ?? {}) as Record<string, unknown>);

    return Object.fromEntries(
      Object.entries(source).map(([k, v]) => [
        k,
        v === undefined || v === null ? '' : String(v),
      ]),
    );
  };

  /**
   * The webhook is the only endpoint exposed to the internet, and it is
   * the one where a flood of requests costs real work: every notification
   * is verified with an HMAC, written to the reconciliation log and - if
   * it applies - posted to the ledger inside a database transaction.
   *
   * The limit is deliberately generous. VNPay retries a refused
   * notification up to 10 times, five minutes apart, so a *legitimate*
   * order can see a burst of notifications over roughly fifty minutes.
   * The limit has to leave room for that: a limit that is too tight would
   * reject a real payment, and a rejected payment is a buyer who paid and
   * got nothing. Two hundred notifications a minute is far above what a
   * genuine order produces and far below what an attack costs the API.
   */
  const ipnLimiter = new RateLimiter({ limit: 200, windowMs: 60_000 });

  const handleIpnRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = readIpnPayload(req);

    // The limiter is keyed on the caller's address. A rejected request
    // still counts against the budget - otherwise a flood would be free.
    const limit = ipnLimiter.check(clientIpFrom(req));
    if (!limit.allowed) {
      req.log.warn({ ip: clientIpFrom(req) }, 'IPN rate limit exceeded');
      // The gateway's official code for "invalid request" makes it retry
      // later. That is the right behaviour here: a throttled notification
      // must not be lost, and the request will be accepted once the window
      // has passed.
      return reply.code(200).send({ RspCode: '99', Message: 'Too many requests' });
    }

    // Always log the raw notification - even the ones we reject. This is
    // the reconciliation log an operator compares against the gateway's
    // own transaction list to find lost notifications.
    const logEvent = async (signatureValid: boolean, applied: boolean) => {
      try {
        await sql`
          INSERT INTO payment_events (
            txn_ref, provider_txn_id, signature_valid, applied, payload
          )
          VALUES (
            ${payload.vnp_TxnRef ?? null},
            ${payload.vnp_TransactionNo ?? payload.vnp_TransactionId ?? null},
            ${signatureValid},
            ${applied},
            ${sql.json(payload as never)}
          )
        `;
      } catch (err) {
        req.log.error({ err }, 'could not write the payment_events log');
      }
    };

    const provider = providerFor(deps);
    const verification = await provider.verifyNotification(payload);

    // Only an untrustworthy notification is dropped. A *valid* notification
    // that reports a declined payment (response code != 00) must still be
    // applied: the order becomes FAILED and the reserved tickets go back to
    // the listing. Rejecting it here would strand those tickets forever.
    if (!verification.signatureValid) {
      req.log.warn({ code: verification.code }, 'IPN rejected');
      await logEvent(false, false);
      return reply.code(200).send({ RspCode: '97', Message: 'Invalid signature' });
    }

    const orderId = verification.orderId ?? payload.vnp_TxnRef;
    if (!orderId) {
      await logEvent(true, false);
      return reply.code(200).send({ RspCode: '99', Message: 'Invalid request' });
    }

    // The gateway reference is not the order's UUID: `vnp_TxnRef` is
    // alphanumeric, so it cannot contain the dashes of a UUID. The order
    // therefore stores the reference it was given, and the notification is
    // matched on it. The UUID is still accepted as a fallback, so an
    // operator can look an order up by either.
    const order = await findOrderByReference(sql, orderId);
    if (!order) {
      await logEvent(true, false);
      return reply.code(200).send({ RspCode: '01', Message: 'Order not found' });
    }

    if (Number(order.gross_vnd) !== verification.amountVnd) {
      req.log.error(
        { orderId: order.id, expected: order.gross_vnd, received: verification.amountVnd },
        'IPN amount mismatch',
      );
      await logEvent(true, false);
      return reply.code(200).send({ RspCode: '04', Message: 'Invalid amount' });
    }

    // The handler can refuse the notification - a race with another
    // notification, for instance. The gateway is told with the official
    // code (`99`, "invalid request"), which makes it retry (up to 10 times,
    // 5 minutes apart), so a refusal caused by a transient race gets
    // another chance. The order is *not* silently changed.
    let result;
    try {
      result = await handleIpn(sql, {
        orderId: order.id,
        amountVnd: verification.amountVnd!,
        transactionId: verification.transactionId ?? `${order.id}-${Date.now()}`,
        transactionRef: verification.transactionRef ?? null,
        ok: verification.ok,
        code: verification.code,
        raw: payload,
      });
    } catch (err) {
      if (err instanceof OrderError) {
        req.log.error(
          { orderId: order.id, code: err.code, message: err.message },
          'the IPN could not be applied',
        );
        await logEvent(true, false);
        return reply.code(200).send({ RspCode: '99', Message: 'Invalid request' });
      }
      throw err;
    }

    await logEvent(true, result.applied);

    req.log.info(
      { orderId: order.id, status: result.status, applied: result.applied },
      'IPN applied',
    );

    // `02` means "this transaction was already confirmed". The handler is
    // idempotent - the ledger booked the money exactly once - but the
    // gateway still deserves the honest answer, because it uses it to
    // decide whether to keep retrying the notification.
    if (!result.applied) {
      return reply.code(200).send({ RspCode: '02', Message: 'Already confirmed' });
    }

    return reply.code(200).send({ RspCode: '00', Message: 'Confirm Success' });
  };

  app.get('/api/ipn/vnpay', handleIpnRequest);
  app.post('/api/ipn/vnpay', handleIpnRequest);

  // --------------------------------------------------------------- escrow
  /**
   * Marks an event as completed: releases every escrowed seller balance and
   * cancels the orders that were never paid for.
   *
   * Note (brief was silent): the brief says "No authentication needed for
   * this test task", so there is no password and no login - the dropdown
   * picks the acting user. But releasing the escrow moves real money out
   * of the platform's accounts, so the *role* is enforced here, in the
   * API, and not only by hiding the button in the storefront.
   *
   * The role is read from the database, so the caller cannot claim to be
   * the operator by putting a name in a header.
   */
  app.post<{ Params: { id: string } }>('/api/events/:id/complete', async (req, reply) => {
    if (!isUuid(req.params.id)) {
      return reply.code(404).send({ error: 'EVENT_NOT_FOUND' });
    }
    const actor = await requireRole(sql, req, reply, 'admin');
    if (!actor) return reply;
    try {
      return await releaseEventEscrow(sql, { eventId: req.params.id });
    } catch (err) {
      // An unknown event is a 404, not a 500: the service reports it as
      // an `OrderError`, and the route has to translate it.
      if (err instanceof OrderError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // --------------------------------------------------------------- wallet
  app.get<{ Params: { userId: string } }>('/api/wallet/:userId', async (req, reply) => {
    if (!isUuid(req.params.userId)) {
      return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    }
    // A wallet is the user's own money. The operator may look at it (the
    // dashboard needs the escrow totals); nobody else may.
    const actor = await actorFrom(sql, req);
    if (!actor) {
      return reply.code(401).send({ error: 'UNKNOWN_CALLER' });
    }
    if (actor.id !== req.params.userId && actor.role !== 'admin') {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: 'Bạn không thể xem ví của người khác',
      });
    }
    const balances = await getUserBalances(sql, req.params.userId);
    // The transactions are filtered by the *user* in the database, so a
    // busy platform cannot push the user's own entries out of the window.
    const transactions = await listTransactionsForUser(sql, req.params.userId, 50);
    return { balances, transactions };
  });

  // --------------------------------------------------------------- ledger
  app.get('/api/ledger/balances', async () => {
    return { balances: await computeBalances(sql) };
  });

  app.get('/api/ledger/transactions', async () => {
    return { transactions: await listTransactions(sql, 100) };
  });

  app.get('/api/ledger/audit', async () => {
    return await auditLedger(sql);
  });

  /**
   * Proves the journal is append-only at the *database* level.
   *
   * It tries to UPDATE and DELETE one posted entry inside a transaction and
   * rolls back, so nothing is actually modified. If the trigger is in place
   * the database refuses both statements.
   *
   * This backs the claim in the README that a posted ledger entry cannot be
   * edited or deleted - not just "we never call UPDATE on it".
   */
  app.get('/api/ledger/integrity', async () => {
    const entry = await sql<{ id: string }[]>`
      SELECT id FROM ledger_entries ORDER BY created_at DESC, id DESC LIMIT 1
    `;
    if (!entry[0]) {
      return { appendOnly: true, checked: false, reason: 'journal is empty' };
    }

    const ROLLBACK_PROBE = 'integrity-probe-rollback';

    /**
     * Runs the statement and then forces a rollback by throwing. If the
     * trigger rejected the statement, the error we see is the trigger's;
     * if the statement went through, we see our own probe marker.
     */
    const attempt = async (statement: 'update' | 'delete') => {
      try {
        await withTx(sql, async (tx) => {
          if (statement === 'update') {
            await tx`UPDATE ledger_entries SET amount_vnd = amount_vnd + 1 WHERE id = ${entry[0]!.id}`;
          } else {
            await tx`DELETE FROM ledger_entries WHERE id = ${entry[0]!.id}`;
          }
          throw new Error(ROLLBACK_PROBE);
        });
        return { rejected: false, error: null };
      } catch (err) {
        const message = (err as Error).message ?? '';
        if (message === ROLLBACK_PROBE) {
          // the statement was allowed - it was rolled back by the probe
          return { rejected: false, error: 'statement was allowed (rolled back)' };
        }
        return { rejected: true, error: message };
      }
    };

    const upd = await attempt('update');
    const del = await attempt('delete');

    return {
      appendOnly: upd.rejected && del.rejected,
      checked: true,
      updateRejected: upd.rejected,
      deleteRejected: del.rejected,
      detail: upd.error ?? del.error,
    };
  });

  // ---------------------------------------------------------------- admin
  /**
   * Operations dashboard data.
   *
   * The numbers are all derived from the ledger, so the dashboard can never
   * disagree with the books.
   *
   * Note (brief was silent): the brief says no authentication is needed, so
   * there is no password - the dropdown picks the acting user. The *role*
   * is still checked here: the dashboard shows every buyer's and seller's
   * money, so it is the operator's data and not the storefront's.
   */
  app.get('/api/admin/overview', async (req, reply) => {
    const actor = await requireRole(sql, req, reply, 'admin');
    if (!actor) return reply;
    return await getAdminOverview(sql);
  });

  app.get('/api/admin/orders', async (req, reply) => {
    const actor = await requireRole(sql, req, reply, 'admin');
    if (!actor) return reply;
    return { orders: await listAllOrders(sql, 100) };
  });

  /**
   * Creates a new event with its listings.
   *
   * Decision (brief was silent): the demo catalogue is finite, so once every
   * ticket is sold out there is nothing left to test. The operator needs a
   * way to put fresh tickets on sale, and this is that way.
   *
   * Note (brief was silent): like the other admin endpoints, the role is
   * checked here in the API. No money moves here; the ledger is not touched.
   */
  app.post('/api/admin/events', async (req, reply) => {
    const actor = await requireRole(sql, req, reply, 'admin');
    if (!actor) return reply;
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        detail: parsed.error.flatten(),
      });
    }

    try {
      const created = await createEvent(sql, parsed.data);
      return { event: created };
    } catch (err) {
      if (err instanceof CreateEventError) {
        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.message,
        });
      }
      throw err;
    }
  });

  /**
   * The raw gateway notifications, newest first.
   *
   * This is the reconciliation log: every notification the gateway sent is
   * here, including the ones we rejected (bad signature, unknown order,
   * wrong amount). An operator compares it against the gateway's own
   * transaction list to find notifications that never arrived.
   */
  app.get('/api/admin/payment-events', async (req, reply) => {
    const actor = await requireRole(sql, req, reply, 'admin');
    if (!actor) return reply;
    const events = await sql`
      SELECT txn_ref, provider_txn_id, signature_valid, applied, payload, received_at
      FROM payment_events
      ORDER BY received_at DESC, id DESC
      LIMIT 100
    `;
    return { events };
  });

  await registerMockGatewayRoutes(app);
}
