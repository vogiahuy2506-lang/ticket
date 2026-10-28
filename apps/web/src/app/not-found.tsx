import Link from 'next/link';
import { EmptyState } from '@/components/ui';

/**
 * The app's own 404 page.
 *
 * Without it Next.js falls back to its built-in "404: This page could not be
 * found" screen, which is unstyled and in English - it looks like a broken
 * deployment rather than a finished product, and on the checkout journey
 * (the buyer comes back from the gateway to `/orders/<id>`) it is the *last*
 * screen the buyer sees before deciding whether the purchase worked.
 */
export default function NotFound() {
  return (
    <div className="space-y-6">
      <EmptyState
        title="Không tìm thấy trang"
        hint="Đường dẫn này không tồn tại, hoặc nội dung bạn tìm đã được dọn đi."
        action={
          <Link href="/" className="btn-secondary bg-white">
            Về trang chủ
          </Link>
        }
      />
    </div>
  );
}
