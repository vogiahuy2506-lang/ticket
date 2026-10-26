import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { formatVnd } from '@tce/shared';
import { startCheckout } from '@/app/actions';

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">{event.name}</h1>
        <p className="text-sm text-slate-500">{event.venue}</p>
        <p className="text-sm text-slate-500">
          {new Date(event.starts_at).toLocaleString('vi-VN')}
        </p>
      </div>

      {listings.length === 0 ? (
        <p className="card text-sm text-slate-500">Chua co listing nao.</p>
      ) : null}

      {listings.map((listing) => {
        const available = Number(listing.quantity_available);
        const price = Number(listing.price_vnd);
        const buyerFee = Math.round((price * 10) / 100);
        const sellerFee = Math.round((price * 5) / 100);

        return (
          <form key={listing.id} action={startCheckout} className="card space-y-3">
            <input type="hidden" name="listingId" value={listing.id} />

            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{listing.title}</p>
                <p className="text-sm text-slate-500">Nguoi ban: {listing.seller_name}</p>
              </div>
              <div className="text-right">
                <p className="font-bold text-brand-700">{formatVnd(price)}</p>
                <p className="text-xs text-slate-500">/ ve</p>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">
                Con {available} ve ({listing.quantity_total - listing.quantity_sold}/
                {listing.quantity_total})
              </span>
              <span className="text-slate-500">
                +{formatVnd(buyerFee)} phi dich vu
              </span>
            </div>

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
                className="input w-24"
              />
              <button
                type="submit"
                disabled={available <= 0}
                className="btn-primary flex-1"
              >
                {available > 0 ? 'Thanh toan' : 'Het ve'}
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Nguoi ban nhan {formatVnd(price - sellerFee)}/ve (tru 5% phi). Ban giu
              phan chenh lech {formatVnd(buyerFee + sellerFee)}/ve.
            </p>
          </form>
        );
      })}
    </div>
  );
}
