import { describe, expect, it } from 'vitest';
import { LEDGER_REF_LABELS_VI, ledgerEntryTitle } from '../src/ledger-labels.js';

describe('ledger entry labels', () => {
  it('labels every known entry type in Vietnamese', () => {
    for (const label of Object.values(LEDGER_REF_LABELS_VI)) {
      // Every label must carry a Vietnamese diacritic, otherwise it looks
      // like a broken encoding on the ledger page.
      expect(label).toMatch(/[àáảãạăằắẳẵặâầấẩẫậêềếểễệèéẻẽẹìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụỳýỷỹỵđ]/i);
    }
  });

  it('builds a title from the entry type, not from the stored memo', () => {
    expect(ledgerEntryTitle('PAYMENT_CAPTURE', 'abc-123')).toBe(
      'Thanh toán đơn hàng abc-123',
    );
    expect(ledgerEntryTitle('ESCROW_RELEASE', 'abc-123')).toBe(
      'Giải ngân escrow đơn hàng abc-123',
    );
    expect(ledgerEntryTitle('LATE_PAYMENT_REFUND', null)).toBe(
      'Hoàn tiền đơn hàng',
    );
  });

  it('falls back to the raw type for an unknown entry', () => {
    expect(ledgerEntryTitle('MANUAL_ADJUSTMENT', null)).toBe(
      'Giao dịch MANUAL_ADJUSTMENT',
    );
  });
});
