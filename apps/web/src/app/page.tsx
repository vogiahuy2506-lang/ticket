import Link from 'next/link';
import { api } from '@/lib/api';
import { completeEvent } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { events } = await api.events();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Su kien dang ban ve</h1>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {events.map((event) => (
        <section key={event.id} className="card space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Link
                href={`/events/${event.id}`}
                className="text-lg font-semibold text-slate-900 underline-offset-4 hover:underline"
              >
                {event.name}
              </Link>
              <p className="text-sm text-slate-500">{event.venue}</p>
              <p className="text-sm text-slate-500">
                {new Date(event.starts_at).toLocaleString('vi-VN')}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${
                event.status === 'completed'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
            >
              {event.status === 'completed' ? 'Da hoan tat' : 'Sap dien ra'}
            </span>
          </div>

          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              {event.listing_count} listing - con {event.tickets_left} ve
            </span>
            {event.status === 'scheduled' ? (
              <form action={completeEvent}>
                <input type="hidden" name="eventId" value={event.id} />
                <button type="submit" className="btn-secondary">
                  Hoan tat su kien (giai ngan escrow)
                </button>
              </form>
            ) : null}
          </div>
        </section>
      ))}

      <p className="pt-4 text-xs text-slate-400">
        Phi nguoi mua 10% - phi nguoi ban 5%. Tien nguoi ban duoc giu trong escrow
        den khi su kien hoan tat moi vao so du khha dung. Xem chi tiet tai trang{' '}
        <Link href="/ledger" className="underline">
          So cai
        </Link>
        .
      </p>
    </div>
  );
}
