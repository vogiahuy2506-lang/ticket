import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  buildSignMessage,
  formatVnTime,
  verifySignature,
  VNPAY_AMOUNT_FACTOR,
} from '../src/payments/vnpay.js';
import { postTransaction } from '../src/services/ledger.js';

/**
 * Unit tests that do not need a database:
 *  - the VNPay signature algorithm (a wrong signature must be rejected)
 *  - the guardrails of the double-entry posting function
 */

describe('VNPay signature', () => {
  const secret = 'test-secret';

  it('is stable and independent of the parameter order', () => {
    const a = buildSignMessage(
      { vnp_Amount: '100000', vnp_TxnRef: 'abc' },
      secret,
    );
    const b = buildSignMessage(
      { vnp_TxnRef: 'abc', vnp_Amount: '100000' },
      secret,
    );
    expect(a).toBe(b);
    // HMAC-SHA512 -> 64 bytes -> 128 hex characters.
    expect(a).toHaveLength(128);
  });

  it('matches the official VNPay algorithm (HMAC-SHA512 over sorted, urlencoded params)', () => {
    // The VNPay samples build the hash data as
    //   ksort(params) -> "urlencode(key)=urlencode(value)&..."
    // and then hash it with HMAC-SHA512 and the secret key.
    const params = {
      vnp_Amount: '1000000',
      vnp_TxnRef: '166117',
      vnp_OrderInfo: 'Thanh toan don hang thoi gian: 2023-12-07 17:00:44',
    };
    const hashData =
      'vnp_Amount=1000000&vnp_OrderInfo=Thanh+toan+don+hang+thoi+gian%3A+2023-12-07+17%3A00%3A44&vnp_TxnRef=166117';

    const expected = crypto
      .createHmac('sha512', secret)
      .update(hashData, 'utf8')
      .digest('hex');

    expect(buildSignMessage(params, secret)).toBe(expected);
  });

  it('ignores empty parameters', () => {
    const withEmpty = buildSignMessage(
      { vnp_Amount: '100000', vnp_BankCode: '', vnp_TxnRef: 'abc' },
      secret,
    );
    const without = buildSignMessage(
      { vnp_Amount: '100000', vnp_TxnRef: 'abc' },
      secret,
    );
    expect(withEmpty).toBe(without);
  });

  it('accepts a valid signature and rejects a tampered one', () => {
    const params = { vnp_Amount: '100000', vnp_TxnRef: 'abc' };
    const hash = buildSignMessage(params, secret);
    expect(verifySignature({ ...params, vnp_SecureHash: hash }, secret)).toBe(true);

    // the amount was changed after signing
    expect(
      verifySignature(
        { ...params, vnp_Amount: '999999', vnp_SecureHash: hash },
        secret,
      ),
    ).toBe(false);

    // wrong secret
    expect(verifySignature({ ...params, vnp_SecureHash: hash }, 'other')).toBe(
      false,
    );

    // missing signature
    expect(verifySignature(params, secret)).toBe(false);
  });
});

describe('VNPay wire format', () => {
  it('multiplies the amount by 100', () => {
    // The gateway treats vnp_Amount as a two-decimal currency: 10,000 VND is
    // sent as 1000000.
    expect(10000 * VNPAY_AMOUNT_FACTOR).toBe(1000000);
  });

  it('formats the timestamps as yyyyMMddHHmmss in GMT+7', () => {
    // 2023-12-07T10:00:44Z is 17:00:44 in Vietnam.
    const formatted = formatVnTime(new Date('2023-12-07T10:00:44Z'));
    expect(formatted).toBe('20231207170044');
    expect(formatted).toHaveLength(14);
  });
});

describe('postTransaction guards', () => {
  const fakeSql = {} as never;

  it('rejects an unbalanced transaction', async () => {
    await expect(
      postTransaction(fakeSql, {
        refType: 'TEST',
        memo: 'unbalanced',
        lines: [
          { accountCode: 'a', direction: 'debit', amountVnd: 100 },
          { accountCode: 'b', direction: 'credit', amountVnd: 90 },
        ],
      }),
    ).rejects.toThrow(/Unbalanced/);
  });

  it('rejects a transaction with a single line', async () => {
    await expect(
      postTransaction(fakeSql, {
        refType: 'TEST',
        memo: 'single line',
        lines: [{ accountCode: 'a', direction: 'debit', amountVnd: 100 }],
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it('rejects non-positive or fractional amounts', async () => {
    await expect(
      postTransaction(fakeSql, {
        refType: 'TEST',
        memo: 'bad amount',
        lines: [
          { accountCode: 'a', direction: 'debit', amountVnd: 0 },
          { accountCode: 'b', direction: 'credit', amountVnd: 0 },
        ],
      }),
    ).rejects.toThrow(/Invalid line amount|positive/);

    await expect(
      postTransaction(fakeSql, {
        refType: 'TEST',
        memo: 'fractional',
        lines: [
          { accountCode: 'a', direction: 'debit', amountVnd: 10.5 },
          { accountCode: 'b', direction: 'credit', amountVnd: 10.5 },
        ],
      }),
    ).rejects.toThrow(/Invalid line amount/);
  });
});
