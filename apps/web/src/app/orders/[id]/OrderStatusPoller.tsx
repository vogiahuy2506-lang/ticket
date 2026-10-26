'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Props {
  orderId: string;
  initialStatus: string;
}

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Trang thai don hang</span>
        <StatusBadge status={status} />
      </div>

      {status === 'PENDING_PAYMENT' ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p>
            Da chuyen toi cong thanh toan. Neu vua moi thanh toan xong, thong bao
            (IPN) tu cong may den trong vai giay - trang nay se tu cap nhat.
          </p>
          <button
            type="button"
            onClick={recheck}
            disabled={checking}
            className="btn-secondary mt-2"
          >
            {checking ? 'Dang kiem tra...' : 'Kiem tra lai trang thai'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    PENDING_PAYMENT: {
      label: 'Dang cho thanh toan',
      cls: 'bg-amber-100 text-amber-700',
    },
    PAID: { label: 'Da thanh toan (escrow)', cls: 'bg-blue-100 text-blue-700' },
    RELEASED: { label: 'Da giai ngan', cls: 'bg-emerald-100 text-emerald-700' },
    FAILED: { label: 'Thanh toan that bai', cls: 'bg-red-100 text-red-700' },
    CANCELLED: { label: 'Da huy', cls: 'bg-slate-200 text-slate-700' },
  };
  const item = map[status] ?? { label: status, cls: 'bg-slate-200 text-slate-700' };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.cls}`}>
      {item.label}
    </span>
  );
}
