import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getCurrentUser, listUsers } from '@/lib/session';
import { switchUser } from '@/app/actions';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'VeX - Cho ve su kien',
  description: 'Marketplace ve su kien: thanh toan qua VNPay, escrow va so ke doi entry.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [current, users] = await Promise.all([getCurrentUser(), listUsers()]);

  return (
    <html lang="vi">
      <body>
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <Link href="/" className="text-lg font-bold tracking-tight text-brand-700">
              VeX
              <span className="ml-1 text-xs font-normal text-slate-500">ve su kien</span>
            </Link>
            <form action={switchUser} className="flex items-center gap-2">
              <label className="sr-only" htmlFor="userId">
                Doi nguoi dung
              </label>
              <select
                id="userId"
                name="userId"
                defaultValue={current?.id ?? ''}
                className="max-w-[45vw] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
              >
                Doi
              </button>
            </form>
          </div>
        </header>

        <nav className="mx-auto flex w-full max-w-3xl gap-4 px-4 pt-3 text-sm">
          <Link
            href="/"
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            Su kien
          </Link>
          <Link
            href="/wallet"
            className="font-medium text-slate-600 underline-offset-4 hover:underline"
          >
            Vi cua toi
          </Link>
          <Link
            href="/ledger"
            className="font-medium text-slate-600 underline-offset-4 hover:underline"
          >
            So cai
          </Link>
        </nav>

        <main className="container-page">{children}</main>
      </body>
    </html>
  );
}
