import { api } from '@/lib/api';
import { getCurrentUser } from '@/lib/session';
import { formatVnd } from '@tce/shared';

export const dynamic = 'force-dynamic';

export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) {
    return <p className="card text-sm text-slate-500">Chua co nguoi dung.</p>;
  }

  const { balances, transactions } = await api.wallet(user.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Vi cua {user.name}</h1>
        <p className="text-sm text-slate-500">
          So du duoc tinh truc tiep tu so ke doi entry (khong co cot so du rieng).
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Cho giai ngan (escrow)
          </p>
          <p className="mt-1 text-xl font-bold text-amber-600">
            {formatVnd(balances.pendingVnd)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Tien ban giu cho den khi su kien dien ra
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Khai dung
          </p>
          <p className="mt-1 text-xl font-bold text-emerald-600">
            {formatVnd(balances.availableVnd)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Da giai ngan, co the rut
          </p>
        </div>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Tong cong</h2>
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">Tong cua ban</span>
          <span className="font-bold">{formatVnd(balances.totalVnd)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">Tien tai cong thanh toan</span>
          <span className="font-medium">{formatVnd(balances.gatewayCashVnd)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-slate-600">Doanh thu phi cua san</span>
          <span className="font-medium">{formatVnd(balances.platformFeeVnd)}</span>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Lich su giao dich</h2>
        {transactions.length === 0 ? (
          <p className="text-sm text-slate-500">Chua co giao dich nao.</p>
        ) : (
          transactions.map((txn) => (
            <div key={txn.txnId} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{txn.memo}</p>
                <span className="shrink-0 text-xs text-slate-400">
                  {new Date(txn.createdAt).toLocaleString('vi-VN')}
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {txn.lines.map((line, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      {line.direction === 'debit' ? 'No' : 'Co'} {line.accountName}
                    </span>
                    <span className="shrink-0 font-medium">
                      {formatVnd(line.amountVnd)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
