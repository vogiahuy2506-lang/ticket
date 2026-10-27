import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { formatVnd } from '@tce/shared';
import OrderStatusPoller from './OrderStatusPoller';
import { Badge, MoneyRow, PageHeader, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data;
  try {
    data = await api.order(id);
  } catch {
    notFound();
  }

  const { order, fees, payments } = data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Ket qua thanh toan"
        subtitle={`Ma don: ${order.id}`}
      />

      <section className="card">
        <OrderStatusPoller orderId={order.id} initialStatus={order.status} />
      </section>

      <section className="card space-y-1">
        <SectionTitle title="Chi tiet tien" />
        <MoneyRow
          label={`Gia ve x ${order.quantity}`}
          value={formatVnd(fees.subtotalVnd)}
        />
        <MoneyRow
          label="Phi dich vu nguoi mua (10%)"
          value={formatVnd(fees.buyerFeeVnd)}
        />
        <div className="border-t border-ink-100 pt-1">
          <MoneyRow
            label="Tong nguoi mua tra"
            value={formatVnd(fees.grossVnd)}
            strong
            tone="brand"
          />
        </div>
        <div className="border-t border-ink-100 pt-1">
          <MoneyRow
            label="Nguoi ban nhan (tru 5% phi)"
            value={formatVnd(fees.sellerNetVnd)}
            tone="success"
          />
          <MoneyRow
            label="San giu phi (15%)"
            value={formatVnd(fees.platformFeeVnd)}
            tone="muted"
          />
        </div>
      </section>

      <section className="card space-y-3">
        <SectionTitle
          title="Thong bao tu cong thanh toan"
          hint="IPN la nguon su that duy nhat, khong phai redirect tren trinh duyet."
        />
        {payments.length === 0 ? (
          <p className="text-sm text-ink-500">Chua co thong bao IPN nao.</p>
        ) : (
          <ul className="divide-line">
            {payments.map((p) => (
              <li
                key={p.provider_txn_id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-ink-700">
                    {p.provider_txn_id}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {p.provider} - {formatVnd(Number(p.amount_vnd))}
                  </p>
                </div>
                <Badge
                  tone={
                    p.status === 'SUCCEEDED'
                      ? 'success'
                      : p.status === 'FAILED'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {p.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
