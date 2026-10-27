import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getCurrentUser, listUsers } from '@/lib/session';
import { switchUser } from '@/app/actions';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'VeX - Cho ve su kien',
  description:
    'Marketplace ve su kien: thanh toan qua VNPay, escrow va so ke doi entry.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

const NAV = [
  { href: '/', label: 'Su kien' },
  { href: '/wallet', label: 'Vi cua toi' },
  { href: '/ledger', label: 'So cai' },
];

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
          Bo qua dieu huong
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
                  ve su kien
                </span>
              </span>
            </Link>

            <form action={switchUser} className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="userId">
                Doi nguoi dung
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
                Doi
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
            </div>
          </nav>
        </header>

        <main id="main" className="container-page">
          {children}
        </main>

        <footer className="border-t border-ink-200/70 bg-white/60">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 text-xs leading-relaxed text-ink-400">
            <p>
              VeX - ban cat nhip giao dich ve su kien. Moi dong tien deu duoc ghi
              vao so ke doi entry; khong co so du nao duoc luu rieng.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
