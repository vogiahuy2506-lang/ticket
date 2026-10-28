import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  createIsolatedDb,
  isDatabaseReachable,
  useIsolatedDb,
  type IsolatedDb,
} from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';
import { asUser } from './helpers/acting-user.js';

/**
 * Creating a new event.
 *
 * Decision (brief was silent): the brief has no event-creation flow, but
 * the seeded catalogue is finite. These tests pin the behaviour that makes
 * the feature safe to use: the local time is converted with the fixed
 * +07:00 offset, a listing always belongs to a real seller, and no money
 * moves.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('POST /api/admin/events', () => {
  let db: IsolatedDb;
  let data: TestData;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let base: string;

  beforeAll(async () => {
    db = await createIsolatedDb('create-event');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);

    operatorId = (await data.user('Operator create-event', 'admin')).id;

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  /**
   * Creating an event is an operator action, so the request has to say
   * which operator it is. The API looks the role up in the database, so
   * the test only supplies the id.
   */
  let operatorId: string;

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asUser(operatorId) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as never };
  }

  it('creates an event with its listings', async () => {
    const seller = await data.user('Seller create-event-ok', 'seller');
    const res = await post('/api/admin/events', {
      name: 'Đại nhạc Sơn Trà - Đêm Mưa',
      venue: 'Sân Văn Hoá TP.HCM',
      startsAtLocal: '2026-11-27T20:00',
      listings: [
        {
          sellerId: seller.id,
          title: 'Vé Standard',
          quantityTotal: 10,
          priceVnd: 500_000,
        },
      ],
    });

    expect(res.status).toBe(200);

    const event = (res.body as { event: { eventId: string; listings: unknown[] } })
      .event;
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.listings).toHaveLength(1);

    // The event is immediately buyable: it shows up with its tickets left.
    const listRes = await fetch(`${base}/api/events`);
    const list = (await listRes.json()) as {
      events: Array<{ id: string; tickets_left: number; listing_count: number }>;
    };
    const created = list.events.find((e) => e.id === event.eventId);
    expect(created).toBeDefined();
    expect(Number(created!.listing_count)).toBe(1);
    expect(Number(created!.tickets_left)).toBe(10);
  });

  it('refuses a free ticket', async () => {
    // The ledger rejects a zero-amount posting, so a free ticket could
    // never be captured: the buyer would be charged for a ticket that was
    // never booked. The price has to be at least one dong.
    const seller = await data.user('Seller create-event-free', 'seller');
    const res = await post('/api/admin/events', {
      name: 'Sự kiện miễn phí',
      venue: 'Chỗ nào đó',
      startsAtLocal: '2026-11-27T20:00',
      listings: [
        {
          sellerId: seller.id,
          title: 'Vé miễn phí',
          quantityTotal: 10,
          priceVnd: 0,
        },
      ],
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_INPUT');
  });

  it('stores the local start time with the fixed +07:00 offset', async () => {
    const seller = await data.user('Seller create-event-tz', 'seller');
    const res = await post('/api/admin/events', {
      name: 'Hội thảo Kỷ nam 2026',
      venue: 'Nhà thi đấu Mỹ Đình',
      startsAtLocal: '2026-11-27T20:00',
      listings: [
        {
          sellerId: seller.id,
          title: 'Vé phim',
          quantityTotal: 4,
          priceVnd: 750_000,
        },
      ],
    });
    expect(res.status).toBe(200);

    const event = (res.body as { event: { eventId: string; startsAt: string } })
      .event;
    // 20:00 in Vietnam is 13:00 UTC.
    expect(new Date(event.startsAt).toISOString()).toBe(
      '2026-11-27T13:00:00.000Z',
    );
  });

  it('rejects an event without any listing', async () => {
    const res = await post('/api/admin/events', {
      name: 'Không có vé',
      venue: 'Chỗ nào đó',
      startsAtLocal: '2026-11-27T20:00',
      listings: [],
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_INPUT');
  });

  it('rejects a listing whose seller does not exist', async () => {
    const res = await post('/api/admin/events', {
      name: 'Vé của người bán ma',
      venue: 'Chỗ nào đó',
      startsAtLocal: '2026-11-27T20:00',
      listings: [
        {
          sellerId: '00000000-0000-0000-0000-000000000000',
          title: 'Vé',
          quantityTotal: 1,
          priceVnd: 100_000,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('SELLER_NOT_FOUND');
  });

  it('rejects a malformed start time', async () => {
    const seller = await data.user('Seller create-event-bad-time', 'seller');
    const res = await post('/api/admin/events', {
      name: 'Sự kiện lỗi',
      venue: 'Chỗ nào đó',
      startsAtLocal: '27/11/2026',
      listings: [
        {
          sellerId: seller.id,
          title: 'Vé',
          quantityTotal: 1,
          priceVnd: 100_000,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('INVALID_INPUT');
  });

  it('does not touch the ledger - creating an event moves no money', async () => {
    const seller = await data.user('Seller create-event-ledger', 'seller');
    const before = await data.balance('asset:gateway_cash');

    const res = await post('/api/admin/events', {
      name: 'Sự kiện không tiền',
      venue: 'Chỗ nào đó',
      startsAtLocal: '2026-11-27T20:00',
      listings: [
        {
          sellerId: seller.id,
          title: 'Vé',
          quantityTotal: 1,
          priceVnd: 100_000,
        },
      ],
    });
    expect(res.status).toBe(200);

    // An event is a catalogue entry, not a financial event.
    expect(await data.balance('asset:gateway_cash')).toBe(before);

    const txns = await db.sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM ledger_transactions
    `;
    expect(Number(txns[0]!.n)).toBe(0);
  });
});
