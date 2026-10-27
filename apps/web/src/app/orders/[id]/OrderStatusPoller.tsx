'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Props {
  orderId: string;
  initialStatus: string;
}

const STATUS_META: Record<
  string,
  { label: string; cls: string; dot: string; hint: string }
> = {
  PENDING_PAYMENT: {
    label: 'Dang cho thanh toan',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200',
    dot: 'bg-amber-500',
    hint: 'Da chuyen toi cong thanh toan.',
  },
  PAID: {
    label: 'Da thanh toan - tien giu trong escrow',
    cls: 'bg-sky-50 text-sky-800 ring-sky-200',
    dot: 'bg-sky-500',
    hint: 'Tien da vao cong thanh toan, nguoi ban chua nhan duoc.',
  },
  RELEASED: {
    label: 'Da giai ngan',
    cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    dot: 'bg-emerald-500',
    hint: 'Su kien da dien ra, tien da chuyen sang so du kha dung cua nguoi ban.',
  },
  FAILED: {
    label: 'Thanh toan that bai',
    cls: 'bg-red-50 text-red-800 ring-red-200',
    dot: 'bg-red-500',
    hint: 'Thanh toan khong thanh cong, so ve da duoc tra lai.',
  },
  CANCELLED: {
    label: 'Da huy',
    cls: 'bg-ink-100 text-ink-700 ring-ink-200',
    dot: 'bg-ink-400',
    hint: 'Don hang da bi huy.',
  },
};

/**
 * Polls the API for the *real* order status.
 *
 * The buyer may come back from the gateway before the IPN has been processed,
 * so the page shows the persisted status and re-checks it. We never infer a
 * status from the browser redirect.
 */
export default function OrderStatusPoller({ orderId, initialStatus }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (status !== 'PENDING_PAYMENT') return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/recheck`, {
          method: 'POST',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { status: string };
        if (!cancelled && data.status !== status) {
          setStatus(data.status);
          router.refresh();
        }
      } catch {
        /* ignore network hiccups while polling */
      }
    };

    const timer = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId, status, router]);

  const recheck = async () => {
    setChecking(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/recheck`, { method: 'POST' });
      const data = (await res.json()) as { status: string };
      setStatus(data.status);
      router.refresh();
    } finally {
      setChecking(false);
    }
  };

  const meta = STATUS_META[status] ?? {
    label: status,
    cls: 'bg-ink-100 text-ink-700 ring-ink-200',
    dot: 'bg-ink-400',
    hint: '',
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink-700">Trang thai don hang</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${meta.cls}`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${
              status === 'PENDING_PAYMENT' ? 'animate-pulse-soft' : ''
            }`}
          />
          {meta.label}
        </span>
      </div>

      {meta.hint ? (
        <p className="text-xs leading-relaxed text-ink-500">{meta.hint}</p>
      ) : null}

      {status === 'PENDING_PAYMENT' ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-sm text-amber-900">
          <p>
            Neu vua moi thanh toan xong, thong bao (IPN) tu cong may den trong vai
            giay - trang nay se tu cap nhat.
          </p>
          <button
            type="button"
            onClick={recheck}
            disabled={checking}
            className="btn-secondary mt-2.5 bg-white"
          >
            {checking ? 'Dang kiem tra...' : 'Kiem tra lai trang thai'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
