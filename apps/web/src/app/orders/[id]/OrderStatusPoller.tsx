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
    label: 'Đang chờ thanh toán',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200',
    dot: 'bg-amber-500',
    hint: 'Đã chuyển tới cổng thanh toán.',
  },
  PAID: {
    label: 'Đã thanh toán - tiền giữ trong escrow',
    cls: 'bg-sky-50 text-sky-800 ring-sky-200',
    dot: 'bg-sky-500',
    hint: 'Tiền đã vào cổng thanh toán, người bán chưa nhận được.',
  },
  RELEASED: {
    label: 'Đã giải ngân',
    cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    dot: 'bg-emerald-500',
    hint: 'Sự kiện đã diễn ra, tiền đã chuyển sang số dư khả dụng của người bán.',
  },
  FAILED: {
    label: 'Thanh toán thất bại',
    cls: 'bg-red-50 text-red-800 ring-red-200',
    dot: 'bg-red-500',
    hint: 'Thanh toán không thành công, số vé đã được trả lại.',
  },
  CANCELLED: {
    label: 'Đã hủy',
    cls: 'bg-ink-100 text-ink-700 ring-ink-200',
    dot: 'bg-ink-400',
    hint: 'Đơn hàng đã bị hủy.',
  },
  EXPIRED: {
    label: 'Hết thời gian giữ vé',
    cls: 'bg-ink-100 text-ink-700 ring-ink-200',
    dot: 'bg-ink-400',
    hint:
      'Bạn không hoàn tất thanh toán trong 15 phút, số vé đã được trả lại cho người bán.',
  },
  REFUND_REQUIRED: {
    label: 'Đã thanh toán - sẽ được hoàn tiền',
    cls: 'bg-orange-50 text-orange-800 ring-orange-200',
    dot: 'bg-orange-500',
    hint:
      'Tiền đã đến cổng nhưng thời gian giữ vé đã hết, vé đã được bán cho người khác. Tiền của bạn sẽ được hoàn lại.',
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
    // An EXPIRED order is polled too: the lazy sweep released the ticket,
    // but the buyer may well have paid - and if the IPN was lost, the money
    // would sit at the gateway with nobody looking for it. The re-check
    // asks the gateway directly, so a lost notification can still be
    // recovered.
    if (status !== 'PENDING_PAYMENT' && status !== 'EXPIRED') return;

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
        <span className="text-sm font-medium text-ink-700">Trạng thái đơn hàng</span>
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

      {status === 'PENDING_PAYMENT' || status === 'EXPIRED' ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-sm text-amber-900">
          <p>
            {status === 'PENDING_PAYMENT'
              ? 'Nếu vừa mới thanh toán xong, thông báo (IPN) từ cổng máy đến trong vài giây - trang này sẽ tự cập nhật.'
              : 'Thời gian giữ vé đã hết, nhưng nếu bạn đã thanh toán thì tiền vẫn được trả lại cho bạn. Trang này sẽ hỏi cổng thanh toán và tự cập nhật.'}
          </p>
          <button
            type="button"
            onClick={recheck}
            disabled={checking}
            className="btn-secondary mt-2.5 bg-white"
          >
            {checking ? 'Đang kiểm tra...' : 'Kiểm tra lại trạng thái'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
