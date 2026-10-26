export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'RELEASED',
  'FAILED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const EVENT_STATUSES = ['scheduled', 'completed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export const ACCOUNT_KINDS = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Where a listing/order stands in the funnel. */
export const ORDER_STATUS_LABELS_VI: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'Đang chờ thanh toán',
  PAID: 'Đã thanh toán (tiền giữ trong escrow)',
  RELEASED: 'Đã giải ngân',
  FAILED: 'Thanh toán thất bại',
  CANCELLED: 'Đã huỷ',
};

export const EVENT_STATUS_LABELS_VI: Record<EventStatus, string> = {
  scheduled: 'Sắp diễn ra',
  completed: 'Đã hoàn tất',
};
