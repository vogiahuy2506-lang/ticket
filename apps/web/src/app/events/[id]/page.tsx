import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { formatVnd } from '@tce/shared';
import { startCheckout } from '@/app/actions';
import { Badge, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data;
  try {
    data = await api.event(id);
  } catch {
    notFound();
  }

  const { event, listings } = data;
  const totalLeft = listings.reduce(
    (s, l) => s + Number(l.quantity_available),
    0,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={event.name}
        subtitle={
          <span className="flex flex-col gap-0.5">
            <span>{event.venue}</span>
            <span>
              {new Date(event.starts_at).toLocaleString('vi-VN', {
                dateStyle: 'full',
                timeStyle: 'short',
              })}
            </span>
          </span>
        }
        action={
          <Badge tone={event.status === 'completed' ? 'success' : 'warning'}>
            {event.status === 'completed' ? 'Da hoan tat' : 'Sap dien ra'}
          </Badge>
        }
      />

      {listings.length === 0 ? (
        <EmptyState
          title="Chua co listing nao"
          hint="Su kien nay chua co ticket nao duoc dang len ban."
        />
      ) : null}

      <div className="space-y-3">
        {listings.map((listing) => {
          const available = Number(listing.quantity_available);
          const price = Number(listing.price_vnd);
          const buyerFee = Math.round((price * 10) / 100);
          const sellerFee = Math.round((price * 5) / 100);
          const soldOut = available <= 0;
          const lowStock = !soldOut && available <= 3;

          return (
            <form
              key={listing.id}
              action={startCheckout}
              className="card card-interactive space-y-3.5"
            >
              <input type="hidden" name="listingId" value={listing.id} />
              {/* Stable per-render key: two submits of this form carry the
                  same Idempotency-Key, so a double-tap cannot reserve the
                  tickets twice. */}
              <input
                type="hidden"
                name="idempotencyKey"
                value={`${listing.id}-${listing.quantity_sold}-${crypto.randomUUID()}`}
              />

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold leading-snug text-ink-900">
                    {listing.title}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-500">
                    Nguoi ban: {listing.seller_name}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="table-num text-lg font-bold leading-tight text-brand-700">
                    {formatVnd(price)}
                  </p>
                  <p className="text-xs text-ink-400">/ ve</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {soldOut ? (
                  <Badge tone="danger">Het ve</Badge>
                ) : lowStock ? (
                  <Badge tone="warning">Chi con {available} ve</Badge>
                ) : (
                  <Badge tone="success">Con {available} ve</Badge>
                )}
                <span className="text-xs text-ink-400">
                  da ban {listing.quantity_sold}/{listing.quantity_total}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 rounded-xl bg-ink-50/80 p-3 text-xs">
                <div>
                  <dt className="text-ink-400">Phi dich vu ban tra</dt>
                  <dd className="mt-0.5 table-num font-semibold text-ink-800">
                    +{formatVnd(buyerFee)}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-400">Nguoi ban nhan</dt>
                  <dd className="mt-0.5 table-num font-semibold text-ink-800">
                    {formatVnd(price - sellerFee)}
                  </dd>
                </div>
              </dl>

              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`qty-${listing.id}`}>
                  So luong
                </label>
                <input
                  id={`qty-${listing.id}`}
                  type="number"
                  name="quantity"
                  min={1}
                  max={Math.max(1, available)}
                  defaultValue={1}
                  inputMode="numeric"
                  disabled={soldOut}
                  className="input w-24 shrink-0"
                />
                <button
                  type="submit"
                  disabled={soldOut}
                  className="btn-primary flex-1"
                >
                  {soldOut ? 'Het ve' : 'Thanh toan'}
                </button>
              </div>

              <p className="text-[11px] leading-relaxed text-ink-400">
                Ban giu phan chenh lech {formatVnd(buyerFee + sellerFee)}/ve trong
                escrow den khi su kien dien ra.
              </p>
            </form>
          );
        })}
      </div>

      {listings.length > 0 ? (
        <p className="text-center text-xs text-ink-400">
          Tong con {totalLeft} ve trong {listings.length} listing.
        </p>
      ) : null}
    </div>
  );
}
