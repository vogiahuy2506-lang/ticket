'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { vietnamLocalNow } from '@tce/shared';
import { createEvent } from '@/app/actions';

/**
 * The "put new tickets on sale" form of the operations dashboard.
 *
 * Decision (brief was silent): the brief has no event-creation flow, but
 * the demo catalogue is finite. Once every ticket of every seeded event is
 * sold out, a reviewer has nothing left to try. This form lets the
 * operator create a fresh event with fresh listings.
 *
 * The start time is entered as a *local* Vietnamese wall-clock time: the
 * form sends `2026-11-27T20:00` and the server converts it to UTC with
 * the fixed +07:00 offset. Doing the conversion on the server keeps the
 * browser and the server from disagreeing about what the time means.
 */
export interface SellerOption {
  id: string;
  name: string;
}

export function CreateEventForm({ sellers }: { sellers: SellerOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Three rows is enough for a demo and keeps the form short on a phone.
  const [rows, setRows] = useState([
    { title: 'Vé Standard', quantity: '10', price: '500000' },
  ]);

  async function handleSubmit(formData: FormData) {
    setError(null);
    setPending(true);
    const result = await createEvent(formData);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // The client router, not a full page load: the event page is a server
    // component, and `router.refresh` after the push makes sure it re-reads
    // the new event instead of a cached one.
    router.push(`/events/${result.eventId}`);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Tạo sự kiện mới
      </button>
    );
  }

  return (
    <form
      action={handleSubmit}
      className="card space-y-4"
      aria-label="Tạo sự kiện mới"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">Tạo sự kiện mới</h3>
          <p className="mt-0.5 text-xs text-ink-500">
            Thêm vé mới để bán. Không có giao dịch tiền nào được tạo.
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0"
          onClick={() => setOpen(false)}
        >
          Đóng
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-600">Tên sự kiện</span>
          <input
            name="name"
            required
            maxLength={200}
            placeholder="Đại nhạc Sơn Trà - Đêm Mưa"
            className="input w-full"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-600">Địa điểm</span>
          <input
            name="venue"
            required
            maxLength={200}
            placeholder="Sân Văn Hoá TP.HCM"
            className="input w-full"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-600">
          Bắt đầu lúc (giờ Việt Nam)
        </span>
        <input
          name="startsAtLocal"
          type="datetime-local"
          required
          defaultValue={vietnamLocalNow()}
          className="input w-full"
        />
      </label>

      <fieldset className="space-y-3">
        <legend className="text-xs font-medium text-ink-600">Các nhóm vé</legend>

        {rows.map((row, i) => (
          <div
            key={i}
            className="grid gap-2 rounded-xl border border-ink-200 bg-ink-50/60 p-3 sm:grid-cols-12"
          >
            <input type="hidden" name="listingTitle" value={row.title} />
            <input type="hidden" name="listingQuantity" value={row.quantity} />
            <input type="hidden" name="listingPrice" value={row.price} />

            <label className="block space-y-1 sm:col-span-4">
              <span className="text-[11px] text-ink-500">Tên nhóm vé</span>
              <input
                value={row.title}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)),
                  )
                }
                className="input w-full"
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-[11px] text-ink-500">Số lượng</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={row.quantity}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((r, j) =>
                      j === i ? { ...r, quantity: e.target.value } : r,
                    ),
                  )
                }
                className="input w-full"
              />
            </label>
            <label className="block space-y-1 sm:col-span-3">
              <span className="text-[11px] text-ink-500">Giá (VND)</span>
              <input
                type="number"
                min={0}
                step={1000}
                value={row.price}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)),
                  )
                }
                className="input w-full"
              />
            </label>
            <label className="block space-y-1 sm:col-span-3">
              <span className="text-[11px] text-ink-500">Người bán</span>
              <select
                name={`listingSeller-${i}`}
                className="input w-full"
                defaultValue={sellers[0]?.id}
              >
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { title: 'Vé Standard', quantity: '10', price: '500000' },
              ])
            }
          >
            Thêm nhóm vé
          </button>
          {rows.length > 1 ? (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setRows((rs) => rs.slice(0, -1))}
            >
              Bỏ nhóm vé cuối
            </button>
          ) : null}
        </div>
      </fieldset>

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Đang tạo...' : 'Tạo sự kiện'}
      </button>
    </form>
  );
}
