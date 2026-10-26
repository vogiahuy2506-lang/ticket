import type { FastifyInstance } from 'fastify';
import { checkoutSchema, computeFees } from '@tce/shared';
import { providerFor, type AppDeps } from './helpers.js';
import {
  createOrder,
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
import { registerMockGatewayRoutes } from './mock-gateway.js';

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

    try {
      const order = await createOrder(sql, { buyerId: body.buyerId, listingId, quantity });
      const provider = providerFor(deps);
      const payment = await provider.createPayment({
        orderId: order.id,
        amountVnd: Number(order.gross_vnd),
        orderInfo: `Thanh toan don hang ${order.id.slice(0, 8)}`,
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
   * Contract with the gateway: always answer with HTTP 200 and a JSON body
   * {"RspCode":"00","RspStatus":"00"} so the gateway stops retrying, but only
   * after the notification has been verified and applied.
   */
  app.post('/api/ipn/vnpay', async (req, reply) => {
    const payload = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).map(([k, v]) => [
        k,
        v === undefined || v === null ? '' : String(v),
      ]),
    );

    const provider = providerFor(deps);
    const verification = await provider.verifyNotification(payload);

    if (!verification.ok) {
      req.log.warn({ code: verification.code }, 'IPN rejected');
      return reply.code(200).send({ RspCode: '02', RspStatus: '02', Message: 'Invalid IPN' });
    }

    const orderId = verification.orderId ?? payload.vnp_TxnRef;
    if (!orderId) {
      return reply.code(200).send({ RspCode: '02', RspStatus: '02', Message: 'Missing order' });
    }

    const order = await getOrderStatus(sql, orderId);
    if (!order) {
      return reply.code(200).send({ RspCode: '02', RspStatus: '02', Message: 'Unknown order' });
    }

    if (Number(order.gross_vnd) !== verification.amountVnd) {
      req.log.error(
        { orderId, expected: order.gross_vnd, received: verification.amountVnd },
        'IPN amount mismatch',
      );
      return reply.code(200).send({ RspCode: '02', RspStatus: '02', Message: 'Amount mismatch' });
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

    req.log.info(
      { orderId, status: result.status, applied: result.applied },
      'IPN applied',
    );

    return reply.code(200).send({ RspCode: '00', RspStatus: '00', Message: 'Success' });
  });

  // --------------------------------------------------------------- escrow
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

  await registerMockGatewayRoutes(app);
}
