import { describe, expect, it } from 'vitest';
import { computeFees, BUYER_FEE_PERCENT, SELLER_FEE_PERCENT } from '../src/fees.js';
import { formatVnd, percentOf } from '../src/money.js';

describe('computeFees', () => {
  it('splits 10% buyer fee and 5% seller fee on the subtotal', () => {
    const fees = computeFees(1_000_000, 2);

    expect(fees.subtotalVnd).toBe(2_000_000);
    expect(fees.buyerFeeVnd).toBe(200_000);
    expect(fees.sellerFeeVnd).toBe(100_000);
    expect(fees.grossVnd).toBe(2_200_000);
    expect(fees.sellerNetVnd).toBe(1_900_000);
    expect(fees.platformFeeVnd).toBe(300_000);
  });

  it('keeps the ledger invariant gross === sellerNet + platformFee for every amount', () => {
    for (const price of [1, 3, 7, 33_333, 99_999, 250_000, 1_234_567]) {
      for (const qty of [1, 2, 3, 5, 7]) {
        const f = computeFees(price, qty);
        expect(f.grossVnd).toBe(f.sellerNetVnd + f.platformFeeVnd);
        expect(f.grossVnd).toBe(f.subtotalVnd + f.buyerFeeVnd);
        expect(f.platformFeeVnd).toBe(
          f.buyerFeeVnd + f.sellerFeeVnd,
        );
      }
    }
  });

  it('rounds each fee to whole VND (half-up)', () => {
    // 333 * 10% = 33.3 -> 33 ; 333 * 5% = 16.65 -> 17
    const f = computeFees(333, 1);
    expect(f.buyerFeeVnd).toBe(33);
    expect(f.sellerFeeVnd).toBe(17);
    expect(f.grossVnd).toBe(366);
    expect(f.sellerNetVnd).toBe(316);
    expect(f.platformFeeVnd).toBe(50);
  });

  it('uses the percentages from the brief', () => {
    expect(BUYER_FEE_PERCENT).toBe(10);
    expect(SELLER_FEE_PERCENT).toBe(5);
  });

  it('rejects invalid inputs', () => {
    expect(() => computeFees(-1, 1)).toThrow();
    expect(() => computeFees(100, 0)).toThrow();
    expect(() => computeFees(100.5, 1)).toThrow();
  });
});

describe('money helpers', () => {
  it('formats VND in Vietnamese style', () => {
    expect(formatVnd(1_200_000)).toBe('1.200.000 ₫');
    expect(formatVnd(0)).toBe('0 ₫');
  });

  it('rounds percentOf half-up', () => {
    expect(percentOf(10, 5)).toBe(1); // 0.5 -> 1
    expect(percentOf(30, 5)).toBe(2); // 1.5 -> 2
  });
});
