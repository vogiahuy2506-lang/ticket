import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getCurrentUser, listUsers } from '@/lib/session';
import { switchUser } from '@/app/actions';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'VeX - Chợ vé sự kiện',
  description:
    'Marketplace vé sự kiện: thanh toán qua VNPay, escrow và lịch sử giao dịch.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

const NAV = [
  { href: '/', label: 'Sự kiện' },
  { href: '/wallet', label: 'Ví của tôi' },
  { href: '/ledger', label: 'Lịch sử giao dịch' },
];

/** Only shown to an operator. */
const ADMIN_NAV = { href: '/admin', label: 'Quản trị' };

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [current, users] = await Promise.all([getCurrentUser(), listUsers()]);

  return (
    <html lang="vi">
      <body>
        <a href="#main" className="skip-link">
          Bỏ qua điều hướng
        </a>

        <header className="sticky top-0 z-30 border-b border-ink-200/70 bg-white/85 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2.5">
            <Link href="/" className="group flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-600 text-sm font-black text-white shadow-sm transition group-hover:bg-brand-700">
                V
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-base font-bold tracking-tight text-ink-900">
                  VeX
                </span>
                <span className="mt-0.5 hidden text-[10px] uppercase tracking-wider text-ink-400 sm:block">
                  vé sự kiện
                </span>
              </span>
            </Link>

            <form action={switchUser} className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="userId">
                Đổi người dùng
              </label>
              <select
                id="userId"
                name="userId"
                defaultValue={current?.id ?? ''}
                className="max-w-[42vw] truncate rounded-lg border border-ink-200 bg-ink-50 px-2 py-1.5 text-sm text-ink-700 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:max-w-none"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm font-medium text-white transition hover:bg-ink-800 active:scale-95"
              >
                Đổi
              </button>
            </form>
          </div>

          <nav className="border-t border-ink-100 bg-white/60">
            <div className="mx-auto flex w-full max-w-5xl gap-1 px-2 py-1.5 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-1.5 font-medium text-ink-600 transition hover:bg-ink-100 hover:text-ink-900"
                >
                  {item.label}
                </Link>
              ))}
              {current?.role === 'admin' ? (
                <Link
                  href={ADMIN_NAV.href}
                  className="rounded-lg bg-brand-50 px-3 py-1.5 font-medium text-brand-700 transition hover:bg-brand-100"
                >
                  {ADMIN_NAV.label}
                </Link>
              ) : null}
            </div>
          </nav>
        </header>

        <main id="main" className="container-page">
          {children}
        </main>

        <footer className="border-t border-ink-200/70 bg-white/60">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 text-xs leading-relaxed text-ink-400">
            <p>
              VeX - bạn cắt nhịp giao dịch vé sự kiện. Mọi dòng tiền đều được ghi
              vào lịch sử giao dịch; không có số dư nào được lưu riêng.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
