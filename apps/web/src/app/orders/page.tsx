import Link from 'next/link';
import { api } from '@/lib/api';
import { getCurrentUser } from '@/lib/session';
import { formatDateTimeVi, formatVnd } from '@tce/shared';
import { Badge, EmptyState, PageHeader, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The orders of the current user.
 *
 * The order page is reached by URL, and the URL comes from the gateway's
 * redirect. Without this list a buyer who closes the tab - or who buys on
 * a phone and reads the receipt on a laptop - has no way back to the
 * order, and cannot see that their payment is sitting in escrow.
 */
const ORDER_TONE: Record<
  string,
  'warning' | 'success' | 'danger' | 'neutral' | 'info'
> = {
  PENDING_PAYMENT: 'warning',
  PAID: 'info',
  RELEASED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REFUND_REQUIRED: 'warning',
};

const ORDER_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Chờ thanh toán',
  PAID: 'Trong escrow',
  RELEASED: 'Đã giải ngân',
  FAILED: 'Thất bại',
  CANCELLED: 'Đã hủy',
  EXPIRED: 'Hết hạn giữ vé',
  REFUND_REQUIRED: 'Cần hoàn tiền',
};

export default async function OrdersPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <EmptyState
        title="Chưa có người dùng"
        hint="Chọn một người dùng ở thanh trên để xem đơn hàng."
      />
    );
  }

  const { orders } = await api.orders(user.id);
  const isSeller = user.role === 'seller';

  // A seller sees both the orders they sold and the ones they bought, so
  // each row says which side of the order the user is on.
  const side = (o: (typeof orders)[number]) =>
    o.sellerId === user.id ? 'sold' : 'bought';

  // The list is grouped by what the order means for the reader, not by
  // the raw status: the orders that still need attention come first.
  const needsAttention = orders.filter((o) =>
    ['PENDING_PAYMENT', 'REFUND_REQUIRED', 'FAILED'].includes(o.status),
  );
  const settled = orders.filter(
    (o) => !['PENDING_PAYMENT', 'REFUND_REQUIRED', 'FAILED'].includes(o.status),
  );

  const renderOrder = (o: (typeof orders)[number]) => (
    <li key={o.id}>
      <Link
        href={`/orders/${o.id}`}
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition hover:bg-ink-50/60"
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-900">{o.eventName}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">
            {o.listingTitle} · {o.quantity} vé ·{' '}
            {side(o) === 'sold'
              ? `người mua: ${o.buyerName}`
              : `người bán: ${o.sellerName}`}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-400">
            {o.id.slice(0, 8)} ·{' '}
            {formatDateTimeVi(o.createdAt, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="table-num text-sm font-semibold text-ink-900">
            {formatVnd(side(o) === 'sold' ? o.sellerNetVnd : o.grossVnd)}
          </span>
          <Badge tone={ORDER_TONE[o.status] ?? 'neutral'}>
            {ORDER_LABEL[o.status] ?? o.status}
          </Badge>
        </div>
      </Link>
    </li>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Đơn hàng của tôi"
        subtitle={
          isSeller
            ? 'Những đơn hàng bạn bán và những đơn hàng bạn mua. Tiền bán vào số dư khả dụng khi sự kiện hoàn tất.'
            : 'Những đơn hàng bạn đã mua. Tiền được giữ trong escrow cho tới khi sự kiện diễn ra.'
        }
      />

      {orders.length === 0 ? (
        <EmptyState
          title="Chưa có đơn hàng nào"
          hint={
            isSeller
              ? 'Khi có người mua vé của bạn, đơn hàng sẽ xuất hiện ở đây.'
              : 'Mua một vé ở trang Sự kiện để xem đơn hàng của bạn ở đây.'
          }
        />
      ) : null}

      {needsAttention.length > 0 ? (
        <section className="space-y-3">
          <SectionTitle
            title="Cần chú ý"
            hint="Đơn hàng đang chờ thanh toán, thất bại, hoặc cần hoàn tiền."
          />
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">{needsAttention.map(renderOrder)}</ul>
          </div>
        </section>
      ) : null}

      {settled.length > 0 ? (
        <section className="space-y-3">
          <SectionTitle title="Đã xử lý" hint={`${settled.length} đơn hàng`} />
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">{settled.map(renderOrder)}</ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}
