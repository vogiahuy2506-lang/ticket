import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, EmptyState, PageHeader } from '@/components/ui';
import { ListingCheckoutForm } from '@/components/ListingCheckoutForm';

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
            {event.status === 'completed' ? 'Đã hoàn tất' : 'Sắp diễn ra'}
          </Badge>
        }
      />

      {listings.length === 0 ? (
        <EmptyState
          title="Chưa có listing nào"
          hint="Sự kiện này chưa có vé nào được đăng lên bán."
        />
      ) : null}

      {/*
        An event that has already happened can never release its escrow,
        so the API refuses the checkout. The button is disabled here as
        well: sending the buyer to a page that only says "Sự kiện này đã
        hoàn tất" is a worse experience than saying it right where they
        click.
      */}
      {event.status === 'completed' ? (
        <div className="rounded-2xl border border-ink-200 bg-ink-50/70 p-4 text-sm text-ink-600">
          Sự kiện này đã hoàn tất nên không còn vé nào được bán.
        </div>
      ) : null}

      <div className="space-y-3">
        {listings.map((listing) => (
          <ListingCheckoutForm
            key={listing.id}
            listingId={listing.id}
            title={listing.title}
            sellerName={listing.seller_name}
            priceVnd={Number(listing.price_vnd)}
            available={Number(listing.quantity_available)}
            quantitySold={listing.quantity_sold}
            quantityTotal={listing.quantity_total}
            closed={event.status === 'completed'}
          />
        ))}
      </div>

      {listings.length > 0 ? (
        <p className="text-center text-xs text-ink-400">
          Tổng còn {totalLeft} vé trong {listings.length} listing.
        </p>
      ) : null}
    </div>
  );
}
