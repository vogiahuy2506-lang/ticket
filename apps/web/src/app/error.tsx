'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * The error boundary for the app.
 *
 * Without it, a failing page renders Next.js's default error overlay in
 * development and a blank page in production. A blank page is the worst
 * possible outcome on the checkout journey: the buyer comes back from the
 * gateway, sees nothing, and does not know whether the payment went
 * through.
 *
 * So a failure says what happened and offers the way out - and it says it
 * in the app's own language, not in a stack trace.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The real report goes to the server logs; the screen is for the
    // visitor, not for the stack trace.
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-300 bg-white/60 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-ink-700">
        Hệ thống đang gặp sự cố
      </p>
      <p className="max-w-xs text-xs text-ink-500">
        Không tải được dữ liệu. Thử lại, hoặc quay lại trang chủ. Đơn hàng
        của bạn vẫn được lưu - nếu bạn đã thanh toán, tiền sẽ được ghi nhận
        vào hệ thống.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={reset} className="btn-secondary bg-white">
          Thử lại
        </button>
        <Link href="/" className="btn-secondary bg-white">
          Về trang chủ
        </Link>
      </div>
    </div>
  );
}
