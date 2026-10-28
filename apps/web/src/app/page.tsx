import Link from 'next/link';
import { api } from '@/lib/api';
import { getCurrentUser } from '@/lib/session';
import { completeEvent } from '@/app/actions';
import { formatVnd } from '@tce/shared';
import { Badge, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'warning' | 'success'> = {
  scheduled: 'warning',
  completed: 'success',
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const [{ events }, current] = await Promise.all([api.events(), getCurrentUser()]);
  const isOperator = current?.role === 'admin';

  const scheduled = events.filter((e) => e.status === 'scheduled').length;
  const completed = events.filter((e) => e.status === 'completed').length;
  const totalTickets = events.reduce((s, e) => s + Number(e.tickets_left), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sự kiện đang bán vé"
        subtitle={
          events.length > 0 ? (
            <span>
              {scheduled} sự kiện sắp diễn ra - {completed} đã hoàn tất - {totalTickets}{' '}
              vé còn lại
            </span>
          ) : undefined
        }
      />

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800"
        >
          <span aria-hidden className="mt-0.5 font-bold">
            !
          </span>
          <span>{error}</span>
        </div>
      ) : null}

      {events.length === 0 ? (
        <EmptyState
          title="Chưa có sự kiện nào"
          hint="Chạy `npm run db:init` để nạp dữ liệu mẫu (người mua, người bán, hai sự kiện)."
        />
      ) : null}

      <div className="grid gap-3">
        {events.map((event) => {
          const ticketsLeft = Number(event.tickets_left);
          const listingCount = Number(event.listing_count);
          const soldOut = listingCount > 0 && ticketsLeft === 0;

          return (
            <section
              key={event.id}
              className="card card-interactive relative overflow-hidden p-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/events/${event.id}`}
                    className="text-lg font-semibold leading-snug tracking-tight text-ink-900 underline-offset-4 after:absolute after:inset-0 after:content-[''] hover:text-brand-700 hover:underline"
                  >
                    {event.name}
                  </Link>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-500">
                    <span className="inline-flex items-center gap-1.5">
                      <svg
                        aria-hidden
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4 text-ink-400"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 4a1 1 0 11-2 0 1 1 0 012 0zm-3 3a1 1 0 011-1h1a1 1 0 011 1v5a1 1 0 11-2 0v-2H8v2a1 1 0 11-2 0v-5z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {event.venue}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <svg
                        aria-hidden
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4 text-ink-400"
                      >
                        <path
                          fillRule="evenodd"
                          d="M5.75 4a1.75 1.75 0 11-.5 3.5A1.75 1.75 0 015.75 4zM1.5 9a1 1 0 011-1h13a1 1 0 110 2h-13a1 1 0 01-1-1zm4.25 3.75a1.75 1.75 0 11-.5 3.5 1.75 1.75 0 01.5-3.5zM19 9a1 1 0 100 2 1 1 0 000-2zm-3.25 1.25a1.75 1.75 0 11-.5 3.5 1.75 1.75 0 01.5-3.5z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {new Date(event.starts_at).toLocaleString('vi-VN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>
                </div>

                <Badge tone={STATUS_TONE[event.status] ?? 'neutral'}>
                  {event.status === 'completed' ? 'Đã hoàn tất' : 'Sắp diễn ra'}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 bg-ink-50/60 px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-ink-600">
                  <span>
                    <span className="font-semibold text-ink-900">
                      {listingCount}
                    </span>{' '}
                    listing
                  </span>
                  <span aria-hidden className="text-ink-300">
                    |
                  </span>
                  <span>
                    con{' '}
                    <span
                      className={`font-semibold ${
                        soldOut ? 'text-red-600' : 'text-brand-700'
                      }`}
                    >
                      {ticketsLeft}
                    </span>{' '}
                    vé
                  </span>
                </div>

                {event.status === 'scheduled' ? (
                  isOperator ? (
                    <form action={completeEvent} className="relative z-10">
                      <input type="hidden" name="eventId" value={event.id} />
                      <button type="submit" className="btn-secondary">
                        Hoàn tất sự kiện
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs text-ink-400">
                      Chỉ quản trị viên mới giải ngân được
                    </span>
                  )
                ) : (
                  <span className="text-xs text-ink-400">
                    Escrow đã được giải ngân
                  </span>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="rounded-2xl border border-brand-100 bg-brand-50/70 p-4">
        <p className="text-sm font-semibold text-brand-900">Cách tính tiền</p>
        <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-brand-900/80">
          <li>
            <span className="font-semibold">Phí người mua 10%</span> - cộng thêm
            vào tổng tiền bạn trả.
          </li>
          <li>
            <span className="font-semibold">Phí người bán 5%</span> - trừ khỏi
            tiền bạn nhận.
          </li>
          <li>
            Tiền người bán được giữ trong <span className="font-semibold">escrow</span>{' '}
            đến khi sự kiện hoàn tất mới vào số dư khả dụng.
          </li>
        </ul>
        <p className="mt-3 text-sm text-brand-900/80">
          Xem chi tiết tại trang{' '}
          <Link href="/ledger" className="font-semibold underline underline-offset-4">
            Sổ cái
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
