import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkoutSchema, computeFees } from '@tce/shared';
import { providerFor, type AppDeps } from './helpers.js';
import {
  createOrder,
  expireStaleOrders,
  getOrderStatus,
  handleIpn,
  OrderError,
  releaseEventEscrow,
} from '../services/orders.js';
import {
  auditLedger,
  computeBalances,
  getUserBalances,
  listTransactions,
} from '../services/ledger.js';
import { getAdminOverview, listAllOrders } from '../services/admin.js';
import { registerMockGatewayRoutes } from './mock-gateway.js';
import { withTx } from '../db/types.js';

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
    if (!body.buyerId) {
      return reply.code(400).send({ error: 'BUYER_REQUIRED' });
    }

    // Optional Idempotency-Key. The storefront sends a key per checkout
    // attempt, so a double-tapped "Pay" button returns the original order
    // instead of reserving a second batch of tickets.
    const idempotencyKey =
      typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].slice(0, 100)
        : null;

    try {
      const order = await createOrder(sql, {
        buyerId: body.buyerId,
        listingId,
        quantity,
        idempotencyKey,
      });
      const provider = providerFor(deps);
      const payment = await provider.createPayment({
        orderId: order.id,
        amountVnd: Number(order.gross_vnd),
        orderInfo: `Thanh toán đơn hàng ${order.id.slice(0, 8)}`,
        clientIp: req.ip ?? '127.0.0.1',
        returnUrl: `${config.webBaseUrl}/orders/${order.id}`,
        notifyUrl: `${config.publicBaseUrl}/api/ipn/vnpay`,
      });

      return {
        orderId: order.id,
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
  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req, reply) => {
    const order = await getOrderStatus(sql, req.params.id);
    if (!order) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });

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
   */
  app.post<{ Params: { id: string } }>('/api/orders/:id/recheck', async (req, reply) => {
    const order = await getOrderStatus(sql, req.params.id);
    if (!order) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    return { status: order.status, paidAt: order.paid_at, releasedAt: order.released_at };
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

  const handleIpnRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = readIpnPayload(req);

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

    const order = await getOrderStatus(sql, orderId);
    if (!order) {
      await logEvent(true, false);
      return reply.code(200).send({ RspCode: '01', Message: 'Order not found' });
    }

    if (Number(order.gross_vnd) !== verification.amountVnd) {
      req.log.error(
        { orderId, expected: order.gross_vnd, received: verification.amountVnd },
        'IPN amount mismatch',
      );
      await logEvent(true, false);
      return reply.code(200).send({ RspCode: '04', Message: 'Invalid amount' });
    }

    const result = await handleIpn(sql, {
      orderId,
      amountVnd: verification.amountVnd!,
      transactionId: verification.transactionId ?? `${orderId}-${Date.now()}`,
      transactionRef: verification.transactionRef ?? null,
      ok: verification.ok,
      code: verification.code,
      raw: payload,
    });

    await logEvent(true, result.applied);

    req.log.info(
      { orderId, status: result.status, applied: result.applied },
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
   * this test task", so there is no auth on this endpoint. The *web* layer
   * gates the button on the admin role, but the API itself is open - that is
   * listed in the README under "not production ready".
   */
  app.post<{ Params: { id: string } }>('/api/events/:id/complete', async (req) => {
    return await releaseEventEscrow(sql, { eventId: req.params.id });
  });

  // --------------------------------------------------------------- wallet
  app.get<{ Params: { userId: string } }>('/api/wallet/:userId', async (req) => {
    const balances = await getUserBalances(sql, req.params.userId);
    const transactions = await listTransactions(sql, 50);
    const mine = transactions.filter((t) =>
      t.lines.some((l) => l.accountCode.includes(req.params.userId)),
    );
    return { balances, transactions: mine, allTransactions: transactions };
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
   * The brief says no authentication is needed, so the API does not check a
   * role here - the storefront gates the page on the selected user. The
   * numbers are all derived from the ledger, so the dashboard can never
   * disagree with the books.
   */
  app.get('/api/admin/overview', async () => {
    return await getAdminOverview(sql);
  });

  app.get('/api/admin/orders', async () => {
    return { orders: await listAllOrders(sql, 100) };
  });

  /**
   * The raw gateway notifications, newest first.
   *
   * This is the reconciliation log: every notification the gateway sent is
   * here, including the ones we rejected (bad signature, unknown order,
   * wrong amount). An operator compares it against the gateway's own
   * transaction list to find notifications that never arrived.
   */
  app.get('/api/admin/payment-events', async () => {
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
