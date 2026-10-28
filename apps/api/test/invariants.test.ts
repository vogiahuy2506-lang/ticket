import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeFees } from '@tce/shared';
import { createOrder, handleIpn, releaseEventEscrow } from '../src/services/orders.js';
import { auditLedger } from '../src/services/ledger.js';
import { createIsolatedDb, isDatabaseReachable, useIsolatedDb, type IsolatedDb } from './helpers/db.js';
import { TestData } from './helpers/fixtures.js';

/**
 * The money invariants, checked over a wide grid of amounts.
 *
 * These are the properties the whole escrow rests on. A single amount can
 * hide a rounding bug, so the grid is deliberately wide and includes the
 * awkward prices (a price that is not a multiple of 1.000, a price that
 * makes the fees land exactly on a half-dong).
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('money invariants', () => {
  let db: IsolatedDb;
  let data: TestData;

  beforeAll(async () => {
    db = await createIsolatedDb('invariants');
    useIsolatedDb(db.sql);
    data = new TestData(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps gross == sellerNet + platformFee for every price and quantity', () => {
    for (let price = 1; price <= 500; price += 3) {
      for (const qty of [1, 2, 3, 7, 11, 50]) {
        const f = computeFees(price, qty);
        expect(f.grossVnd).toBe(f.sellerNetVnd + f.platformFeeVnd);
        expect(f.grossVnd).toBe(f.subtotalVnd + f.buyerFeeVnd);
        expect(f.platformFeeVnd).toBe(f.buyerFeeVnd + f.sellerFeeVnd);
        // Every amount has to be a whole dong - the ledger stores BIGINT.
        expect(Number.isSafeInteger(f.grossVnd)).toBe(true);
        expect(Number.isSafeInteger(f.sellerNetVnd)).toBe(true);
        expect(Number.isSafeInteger(f.platformFeeVnd)).toBe(true);
        // The seller never receives more than the subtotal.
        expect(f.sellerNetVnd).toBeLessThanOrEqual(f.subtotalVnd);
      }
    }
  });

  it('keeps the buyer fee at exactly 10% and the seller fee at exactly 5%', () => {
    for (let price = 1; price <= 200; price += 2) {
      for (const qty of [1, 2, 3, 5]) {
        const f = computeFees(price, qty);
        // Half-up rounding means the fee is within half a dong of the
        // exact percentage (0.5 is the worst case, and it is correct).
        expect(Math.abs(f.buyerFeeVnd - (f.subtotalVnd * 10) / 100)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(f.sellerFeeVnd - (f.subtotalVnd * 5) / 100)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('never lets a fee exceed the money it is charged on', () => {
    for (let price = 1; price <= 100; price += 1) {
      const f = computeFees(price, 1);
      expect(f.sellerNetVnd).toBeGreaterThanOrEqual(0);
      expect(f.buyerFeeVnd).toBeGreaterThanOrEqual(0);
    }
  });

  it('books every successful payment and keeps the journal balanced', async () => {
    // A grid of real orders, each paid, with the ledger audited after
    // every single one. The invariant is the same for all of them: the
    // gateway holds the gross, the seller is owed the net, the platform
    // kept the fee, and the journal balances.
    const fx = await data.fixture('invariants-grid');
    const prices = [1, 7, 99, 333, 333_333, 750_000, 1_234_567];
    const quantities = [1, 2, 3, 7];

    let expectedCash = 0;
    let expectedSeller = 0;
    let expectedFee = 0;

    // The gateway cash and the platform fee are shared accounts, so the
    // assertion is on the *change*, not on the absolute value.
    const cashBefore = await data.balance('asset:gateway_cash');
    const feeBefore = await data.balance('revenue:platform_fee');
    const pendingBefore = await data.balance(`liability:user:${fx.seller.id}:pending`);

    for (const price of prices) {
      for (const quantity of quantities) {
        const listing = await data.listing(fx.eventId, fx.seller.id, {
          title: `Grid ${price} x ${quantity}`,
          quantityTotal: quantity + 1,
          priceVnd: price,
        });
        const order = await createOrder(db.sql, {
          buyerId: fx.buyer.id,
          listingId: listing.id,
          quantity,
        });
        const fees = computeFees(price, quantity);

        const result = await handleIpn(db.sql, {
          orderId: order.id,
          amountVnd: fees.grossVnd,
          transactionId: `GRID-${price}-${quantity}-${listing.id.slice(0, 6)}`,
          ok: true,
          code: '00',
          raw: {},
        });

        expect(result.status).toBe('PAID');

        expectedCash += fees.grossVnd;
        expectedSeller += fees.sellerNetVnd;
        expectedFee += fees.platformFeeVnd;

        // The journal is balanced after every single posting.
        const audit = await auditLedger(db.sql);
        expect(audit.ok).toBe(true);

        // Each account is exactly the sum of its own postings.
        expect(await data.balance('asset:gateway_cash')).toBe(cashBefore + expectedCash);
        expect(await data.balance(`liability:user:${fx.seller.id}:pending`)).toBe(
          pendingBefore + expectedSeller,
        );
        expect(await data.balance('revenue:platform_fee')).toBe(feeBefore + expectedFee);
      }
    }
  });

  it('keeps the whole platform solvent across a long run of orders', async () => {
    // Buy, pay, complete, buy again - over and over. At the end the
    // gateway cash must equal the money the platform owes the sellers plus
    // the fee it earned. Nothing may drift.
    const fx = await data.fixture('invariants-solvency');
    let expectedCash = 0;
    let expectedSellerTotal = 0;
    let expectedFee = 0;

    // The gateway cash and the platform fee are shared accounts, so the
    // assertion is on the *change*, not on the absolute value.
    const cashBefore = await data.balance('asset:gateway_cash');
    const feeBefore = await data.balance('revenue:platform_fee');

    for (let round = 0; round < 5; round++) {
      const eventId = await data.event(`Solvent event ${round}`);
      const listing = await data.listing(eventId, fx.seller.id, {
        title: `Solvent listing ${round}`,
        quantityTotal: 3,
        priceVnd: 500_000 + round,
      });

      for (const quantity of [1, 2]) {
        const order = await createOrder(db.sql, {
          buyerId: fx.buyer.id,
          listingId: listing.id,
          quantity,
        });
        const fees = computeFees(500_000 + round, quantity);
        await handleIpn(db.sql, {
          orderId: order.id,
          amountVnd: fees.grossVnd,
          transactionId: `SOLVENT-${round}-${quantity}-${order.id.slice(0, 6)}`,
          ok: true,
          code: '00',
          raw: {},
        });

        expectedCash += fees.grossVnd;
        expectedSellerTotal += fees.sellerNetVnd;
        expectedFee += fees.platformFeeVnd;
      }

      // Completing the event releases the escrow to the seller.
      await releaseEventEscrow(db.sql, { eventId });
    }

    const audit = await auditLedger(db.sql);
    expect(audit.ok).toBe(true);

    expect(await data.balance('asset:gateway_cash')).toBe(cashBefore + expectedCash);
    expect(await data.balance(`liability:user:${fx.seller.id}:available`)).toBe(
      expectedSellerTotal,
    );
    expect(await data.balance('revenue:platform_fee')).toBe(feeBefore + expectedFee);
    // Every dong the buyers paid is accounted for.
    expect(expectedCash).toBe(expectedSellerTotal + expectedFee);
  });

  it('refuses an unbalanced ledger transaction at the database level', async () => {
    // The application checks that debits equal credits before it posts.
    // This test is about the layer *below* that: somebody with SQL access
    // must not be able to write a one-sided entry either.
    //
    // The check is a deferrable constraint trigger, so it fires at COMMIT
    // - the entries of a transaction are inserted one row at a time, and
    // the totals are only known once the last row is in.
    const cash = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = 'asset:gateway_cash' LIMIT 1
    `;

    await expect(
      db.sql.begin(async (tx) => {
        const txn = await tx<{ id: string }[]>`
          INSERT INTO ledger_transactions (ref_type, memo)
          VALUES ('MANUAL_UNBALANCED', 'invariant test: debit without credit')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
          VALUES (${txn[0]!.id}, ${cash[0]!.id}, 'debit', 999999)
        `;
        // COMMIT is where the deferred trigger runs - the transaction is
        // rejected here and nothing is written.
      }),
    ).rejects.toThrow(/unbalanced ledger transaction/);

    // The rejected transaction left nothing behind.
    const leftovers = await db.sql`
      SELECT count(*)::int AS n FROM ledger_transactions WHERE memo = 'invariant test: debit without credit'
    `;
    expect(leftovers[0]!.n).toBe(0);
  });

  it('accepts a balanced ledger transaction written by hand', async () => {
    // The other half of the rule: the trigger must not reject a correct
    // posting, or the escrow would stop working.
    const cash = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = 'asset:gateway_cash' LIMIT 1
    `;
    const fee = await db.sql<{ id: string }[]>`
      SELECT id FROM ledger_accounts WHERE code = 'revenue:platform_fee' LIMIT 1
    `;

    await db.sql.begin(async (tx) => {
      const txn = await tx<{ id: string }[]>`
        INSERT INTO ledger_transactions (ref_type, memo)
        VALUES ('MANUAL_BALANCED', 'invariant test: a balanced manual posting')
        RETURNING id
      `;
      await tx`
        INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
        VALUES
          (${txn[0]!.id}, ${cash[0]!.id}, 'debit', 500000),
          (${txn[0]!.id}, ${fee[0]!.id}, 'credit', 500000)
      `;
    });

    const audit = await auditLedger(db.sql);
    expect(audit.ok).toBe(true);
  });
});
