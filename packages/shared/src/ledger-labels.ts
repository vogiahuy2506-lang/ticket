import type { LedgerRefType } from './types.js';

/**
 * Vietnamese labels for the kinds of journal entry the platform posts.
 *
 * The label is derived from the *type* of the entry, not from the memo that
 * was stored with it. A memo is free text that was written by an older
 * version of the app and can carry whatever copy it had at the time; the
 * journal itself is append-only, so a memo can never be rewritten. The type
 * is a stable enum, so the label built from it stays correct forever.
 */
export const LEDGER_REF_LABELS_VI: Record<LedgerRefType, string> = {
  PAYMENT_CAPTURE: 'Thanh toán đơn hàng',
  ESCROW_RELEASE: 'Giải ngân escrow đơn hàng',
  LATE_PAYMENT_REFUND: 'Hoàn tiền đơn hàng',
  REFUND_REASSIGN: 'Chuyển nợ hoàn tiền sang tài khoản người mua',
};

/**
 * Builds the headline of a journal entry.
 *
 * When the entry points at an order, the order id is appended so the entry
 * can still be traced back to the order it belongs to.
 */
export function ledgerEntryTitle(refType: string, refId?: string | null): string {
  const label =
    LEDGER_REF_LABELS_VI[refType as LedgerRefType] ?? `Giao dịch ${refType}`;
  return refId ? `${label} ${refId}` : label;
}
