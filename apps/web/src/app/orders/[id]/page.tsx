import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { formatVnd } from '@tce/shared';
import OrderStatusPoller from './OrderStatusPoller';

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
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Ket qua thanh toan</h1>

      <section className="card space-y-3">
        <OrderStatusPoller orderId={order.id} initialStatus={order.status} />
        <p className="text-xs text-slate-400">Ma don: {order.id}</p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Chi tiet tien</h2>
        <Row label={`Gia ve x ${order.quantity}`} value={formatVnd(fees.subtotalVnd)} />
        <Row label="Phi dich vu nguoi mua (10%)" value={formatVnd(fees.buyerFeeVnd)} />
        <Row label="Tong nguoi mua tra" value={formatVnd(fees.grossVnd)} strong />
        <hr className="border-slate-200" />
        <Row label="Nguoi ban nhan (tru 5% phi)" value={formatVnd(fees.sellerNetVnd)} />
        <Row label="San giu phi (15%)" value={formatVnd(fees.platformFeeVnd)} />
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Thong bao tu cong thanh toan</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-slate-500">Chua co thong bao IPN nao.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-600">
            {payments.map((p) => (
              <li key={p.provider_txn_id} className="flex justify-between gap-2">
                <span className="truncate">{p.provider_txn_id}</span>
                <span className="shrink-0 font-medium">{p.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={strong ? 'font-bold' : 'font-medium'}>{value}</span>
    </div>
  );
}
