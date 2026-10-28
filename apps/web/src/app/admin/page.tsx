import Link from 'next/link';
import { api } from '@/lib/api';
import { requireRole } from '@/lib/session';
import { formatDateTimeVi, formatVnd } from '@tce/shared';
import { completeEvent } from '@/app/actions';
import { CreateEventForm } from '@/components/CreateEventForm';
import {
  Badge,
  EmptyState,
  MoneyRow,
  PageHeader,
  SectionTitle,
  StatCard,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const ORDER_TONE: Record<string, 'warning' | 'success' | 'danger' | 'neutral' | 'info'> = {
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

/**
 * Operations dashboard.
 *
 * Gated on the `admin` role. The check is server-side (this page only
 * renders for an operator), not just a hidden button, so a non-admin
 * cannot read the platform-wide numbers by guessing the URL.
 *
 * Every figure comes from the ledger, so this page and the books can never
 * disagree.
 */
export default async function AdminPage() {
  const operator = await requireRole('admin');
  if (!operator) {
    return (
      <EmptyState
        title="Chỉ quản trị viên mới vào được trang này"
        hint="Đổi người dùng ở thanh trên sang 'Ops Admin' để xem bảng điều khiển."
      />
    );
  }

  const [overview, { orders }, { events: rawEvents }, { users }] = await Promise.all([
    api.adminOverview(),
    api.adminOrders(),
    api.adminPaymentEvents(),
    api.users(),
  ]);

  // A listing is always sold by an existing seller, because the seller's
  // escrow accounts have to exist before any money can be parked in them.
  const sellers = users.filter((u) => u.role === 'seller');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bảng điều khiển"
        subtitle={
          <span>
            Đang xem với quyền <span className="font-semibold">{operator.name}</span>
            {' · '}
            số dư được tính trực tiếp từ lịch sử giao dịch.
          </span>
        }
        action={<Badge tone="brand">admin</Badge>}
      />

      {/* ------------------------------------------------------- money */}
      <section className="space-y-3">
        <SectionTitle
          title="Tiền của sàn"
          hint="Tất cả đều đọc ra từ ledger, không có số dư nào được lưu riêng."
        />
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Đang giữ trong escrow"
            value={formatVnd(overview.escrowHeldVnd)}
            hint="Tiền còn nợ người bán, chưa được rút."
            tone="warning"
          />
          <StatCard
            label="Đã giải ngân"
            value={formatVnd(overview.releasedVnd)}
            hint="Tiền đã chuyển sang số dư khả dụng."
            tone="success"
          />
          <StatCard
            label="Tiền tại cổng thanh toán"
            value={formatVnd(overview.gatewayCashVnd)}
            hint="Tiền sẵn trong gateway."
            tone="muted"
          />
          <StatCard
            label="Doanh thu phí"
            value={formatVnd(overview.platformFeeVnd)}
            hint="Sàn giữ 15% trên mỗi đơn hàng."
            tone="brand"
          />
          <StatCard
            label="Tiền phải hoàn lại"
            value={formatVnd(overview.refundPayableVnd)}
            hint="Thanh toán đến muộn - sàn nợ người mua."
            tone="danger"
          />
        </div>
        <div className="card space-y-1">
          <MoneyRow
            label="Tổng giá trị đã qua cổng (gross)"
            value={formatVnd(overview.grossVolumeVnd)}
            strong
          />
          <div className="border-t border-ink-100 pt-1">
            <MoneyRow
              label={`Đơn hàng đang chờ gateway (${overview.pendingOrderCount})`}
              value={formatVnd(
                overview.stuckOrders.reduce((s, o) => s + o.grossVnd, 0),
              )}
              tone="muted"
            />
          </div>
        </div>
      </section>

      {/* --------------------------------------------- stuck orders */}
      <section className="space-y-3">
        <SectionTitle
          title="Đơn hàng treo"
          hint="Đã tạo order nhưng chưa có IPN nào xác nhận. Tiền chưa vào escrow."
        />
        {overview.stuckOrders.length === 0 ? (
          <EmptyState
            title="Không có đơn hàng nào treo"
            hint="Mỗi đơn hàng đã được xác nhận hoặc chuyển trạng thái."
          />
        ) : (
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">
              {overview.stuckOrders.map((o) => (
                <li
                  key={o.orderId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/orders/${o.orderId}`}
                      className="font-mono text-xs font-semibold text-brand-700 underline-offset-4 hover:underline"
                    >
                      {o.orderId.slice(0, 8)}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-ink-500">
                      {o.eventName} · {o.buyerName}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="table-num text-sm font-semibold text-ink-900">
                      {formatVnd(o.grossVnd)}
                    </span>
                    <Badge tone={o.ageMinutes > 30 ? 'danger' : 'warning'}>
                      {o.ageMinutes} phut
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------ events awaiting release */}
      <section className="space-y-3">
        <SectionTitle
          title="Sự kiện chờ giải ngân"
          hint="Sự kiện đã có đơn hàng trả tiền nhưng chưa được giải ngân cho người bán."
        />
        {overview.eventsAwaitingRelease.length === 0 ? (
          <EmptyState
            title="Không có sự kiện nào chờ giải ngân"
            hint="Mọi sự kiện đã được giải ngân xong hoặc chưa có ai mua vé."
          />
        ) : (
          <div className="space-y-2.5">
            {overview.eventsAwaitingRelease.map((e) => (
              <article key={e.eventId} className="card space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/events/${e.eventId}`}
                      className="font-semibold leading-snug text-ink-900 underline-offset-4 hover:text-brand-700 hover:underline"
                    >
                      {e.eventName}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDateTimeVi(e.startsAt, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="table-num text-base font-bold text-amber-700">
                      {formatVnd(e.escrowVnd)}
                    </p>
                    <p className="text-xs text-ink-400">
                      {e.paidOrders} đơn hàng đã trả
                    </p>
                  </div>
                </div>
                <form action={completeEvent}>
                  <input type="hidden" name="eventId" value={e.eventId} />
                  <button type="submit" className="btn-secondary">
                    Giải ngân escrow cho sự kiện này
                  </button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ----------------------------------------------- new event */}
      {/*
        The seeded catalogue is finite. Once every ticket is sold out there
        is nothing left to test, so the operator can put fresh tickets on
        sale here. No money moves: an event is a catalogue entry, not a
        financial event.
      */}
      <section className="space-y-3">
        <SectionTitle
          title="Thêm vé mới"
          hint="Tạo sự kiện mới kèm các nhóm vé để bán tiếp."
        />
        {sellers.length === 0 ? (
          <EmptyState
            title="Chưa có người bán nào"
            hint="Cần ít nhất một người bán để tạo nhóm vé."
          />
        ) : (
          <CreateEventForm sellers={sellers} />
        )}
      </section>

      {/* ------------------------------------------ orders to refund */}
      <section className="space-y-3">
        <SectionTitle
          title="Đơn hàng cần hoàn tiền"
          hint="Từng đơn ở đây là một lần gọi hoàn tiền tới cổng thanh toán. Tổng tiền ở trên là số dư nợ của sàn."
        />
        {overview.refundOrders.length === 0 ? (
          <EmptyState
            title="Không có đơn hàng nào cần hoàn tiền"
            hint="Mọi khoản đã thu đều được quyết toán với người mua."
          />
        ) : (
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">
              {overview.refundOrders.map((o) => (
                <li
                  key={o.orderId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/orders/${o.orderId}`}
                      className="font-mono text-xs font-semibold text-brand-700 underline-offset-4 hover:underline"
                    >
                      {o.orderId.slice(0, 8)}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-ink-500">
                      {o.eventName} · {o.buyerName}
                    </p>
                  </div>
                  <span className="table-num text-sm font-semibold text-rose-700">
                    {formatVnd(o.grossVnd)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------------ per-seller escrow */}
      <section className="space-y-3">
        <SectionTitle
          title="Escrow theo người bán"
          hint="Ai đang giữ bao nhiêu, và bao nhiêu đã giải ngân."
        />
        {overview.sellerEscrows.length === 0 ? (
          <EmptyState title="Không có người bán nào" />
        ) : (
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">
              {overview.sellerEscrows.map((s) => (
                <li
                  key={s.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <span className="text-sm font-medium text-ink-900">
                    {s.name}
                  </span>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="table-num text-amber-700">
                      Giữ: {formatVnd(s.pendingVnd)}
                    </span>
                    <span className="table-num text-emerald-700">
                      Đã giải ngân: {formatVnd(s.availableVnd)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------------------ all orders */}
      <section className="space-y-3">
        <SectionTitle
          title="Tất cả đơn hàng"
          hint={`${orders.length} đơn hàng, mới nhất trước`}
        />
        {orders.length === 0 ? (
          <EmptyState title="Chưa có đơn hàng nào" />
        ) : (
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">
              {orders.map((o) => (
                <li
                  key={o.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/orders/${o.id}`}
                      className="font-mono text-xs font-semibold text-brand-700 underline-offset-4 hover:underline"
                    >
                      {o.id.slice(0, 8)}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-ink-500">
                      {o.eventName} · {o.buyerName} → {o.sellerName}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="table-num text-sm font-semibold text-ink-900">
                      {formatVnd(o.grossVnd)}
                    </span>
                    <Badge tone={ORDER_TONE[o.status] ?? 'neutral'}>
                      {ORDER_LABEL[o.status] ?? o.status}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------------ raw gateway log */}
      <section className="space-y-3">
        <SectionTitle
          title="Nhật ký IPN thô"
          hint="Mọi thông báo từ cổng thanh toán, kể cả cái bị từ chối. Dùng để đối soát với danh sách giao dịch của cổng."
        />
        {rawEvents.length === 0 ? (
          <EmptyState title="Chưa có thông báo IPN nào" />
        ) : (
          <div className="card overflow-hidden p-0">
            <ul className="divide-line">
              {rawEvents.slice(0, 25).map((e, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-ink-700">
                      {e.txn_ref ?? '(không có txn_ref)'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-400">
                      {e.provider_txn_id ?? '-'} ·{' '}
                      {formatDateTimeVi(e.received_at, {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={e.signature_valid ? 'success' : 'danger'}>
                      {e.signature_valid ? 'Chữ ký hợp lệ' : 'Chữ ký sai'}
                    </Badge>
                    <Badge tone={e.applied ? 'info' : 'neutral'}>
                      {e.applied ? 'Đã áp dụng' : 'Đã bỏ qua'}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
