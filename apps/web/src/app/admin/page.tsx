import Link from 'next/link';
import { api } from '@/lib/api';
import { requireRole } from '@/lib/session';
import { formatVnd } from '@tce/shared';
import { completeEvent } from '@/app/actions';
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
  PENDING_PAYMENT: 'Cho thanh toan',
  PAID: 'Trong escrow',
  RELEASED: 'Da giai ngan',
  FAILED: 'That bai',
  CANCELLED: 'Da huy',
  EXPIRED: 'Het han giu ve',
  REFUND_REQUIRED: 'Can hoan tien',
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
        title="Chi quan tri vien moi vao duoc trang nay"
        hint="Doi nguoi dung o thanh tren sang 'Ops Admin' de xem bang dieu khien."
      />
    );
  }

  const [overview, { orders }, { events: rawEvents }] = await Promise.all([
    api.adminOverview(),
    api.adminOrders(),
    api.adminPaymentEvents(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bang dieu khien"
        subtitle={
          <span>
            Dang xem voi quyen <span className="font-semibold">{operator.name}</span>
            {' · '}
            so du duoc tinh truc tiep tu so ke doi entry.
          </span>
        }
        action={<Badge tone="brand">admin</Badge>}
      />

      {/* ------------------------------------------------------- money */}
      <section className="space-y-3">
        <SectionTitle
          title="Tien cua san"
          hint="Tat ca deu doc ra tu ledger, khong co so du nao duoc luu rieng."
        />
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Dang giu trong escrow"
            value={formatVnd(overview.escrowHeldVnd)}
            hint="Tien con no nguoi ban, chua duoc rut."
            tone="warning"
          />
          <StatCard
            label="Da giai ngan"
            value={formatVnd(overview.releasedVnd)}
            hint="Tien da chuyen sang so du kha dung."
            tone="success"
          />
          <StatCard
            label="Tien tai cong thanh toan"
            value={formatVnd(overview.gatewayCashVnd)}
            hint="Tien san trong gateway."
            tone="muted"
          />
          <StatCard
            label="Doanh thu phi"
            value={formatVnd(overview.platformFeeVnd)}
            hint="San giu 15% tren moi don hang."
            tone="brand"
          />
          <StatCard
            label="Tien phai hoan lai"
            value={formatVnd(overview.refundPayableVnd)}
            hint="Thanh toan den muon - san no nguoi mua."
            tone="danger"
          />
        </div>
        <div className="card space-y-1">
          <MoneyRow
            label="Tong gia tri da qua cong (gross)"
            value={formatVnd(overview.grossVolumeVnd)}
            strong
          />
          <div className="border-t border-ink-100 pt-1">
            <MoneyRow
              label={`Don hang dang cho gateway (${overview.pendingOrderCount})`}
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
          title="Don hang treo"
          hint="Da tao order nhung chua co IPN nao xac nhan. Tien chua vao escrow."
        />
        {overview.stuckOrders.length === 0 ? (
          <EmptyState
            title="Khong co don hang nao treo"
            hint="Moi don hang da duoc xac nhan hoac chuyen trang thai."
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
          title="Su kien cho giai ngan"
          hint="Su kien da co don hang tra tien nhung chua duoc giai ngan cho nguoi ban."
        />
        {overview.eventsAwaitingRelease.length === 0 ? (
          <EmptyState
            title="Khong co su kien nao cho giai ngan"
            hint="Moi su kien da duoc giai ngan xong hoac chua co ai mua ve."
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
                      {new Date(e.startsAt).toLocaleString('vi-VN', {
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
                      {e.paidOrders} don hang da tra
                    </p>
                  </div>
                </div>
                <form action={completeEvent}>
                  <input type="hidden" name="eventId" value={e.eventId} />
                  <button type="submit" className="btn-secondary">
                    Giai ngan escrow cho su kien nay
                  </button>
                </form>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------ per-seller escrow */}
      <section className="space-y-3">
        <SectionTitle
          title="Escrow theo nguoi ban"
          hint="Ai dang giu bao nhieu, va bao nhieu da giai ngan."
        />
        {overview.sellerEscrows.length === 0 ? (
          <EmptyState title="Khong co nguoi ban nao" />
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
                      Giu: {formatVnd(s.pendingVnd)}
                    </span>
                    <span className="table-num text-emerald-700">
                      Da giai ngan: {formatVnd(s.availableVnd)}
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
          title="Tat ca don hang"
          hint={`${orders.length} don hang, moi nhat truoc`}
        />
        {orders.length === 0 ? (
          <EmptyState title="Chua co don hang nao" />
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
          title="Nhat ky IPN thô"
          hint="Moi thong bao tu cong thanh toan, ke ca cai bi tu choi. Dung de doi soat voi danh sach giao dich cua cong."
        />
        {rawEvents.length === 0 ? (
          <EmptyState title="Chua co thong bao IPN nao" />
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
                      {e.txn_ref ?? '(khong co txn_ref)'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-400">
                      {e.provider_txn_id ?? '-'} ·{' '}
                      {new Date(e.received_at).toLocaleString('vi-VN', {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={e.signature_valid ? 'success' : 'danger'}>
                      {e.signature_valid ? 'Chu ky hop le' : 'Chu ky sai'}
                    </Badge>
                    <Badge tone={e.applied ? 'info' : 'neutral'}>
                      {e.applied ? 'Da ap dung' : 'Da bo qua'}
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
