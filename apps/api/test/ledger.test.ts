import { describe, expect, it } from 'vitest';
import { buildSignMessage, verifySignature } from '../src/payments/vnpay.js';
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
    expect(a).toHaveLength(64);
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
