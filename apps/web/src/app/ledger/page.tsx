import { apiFetch } from '@/lib/api';
import { formatVnd } from '@tce/shared';

export const dynamic = 'force-dynamic';

interface LedgerBalance {
  accountCode: string;
  accountName: string;
  kind: string;
  ownerUserId: string | null;
  debitTotalVnd: number;
  creditTotalVnd: number;
  balanceVnd: number;
}

interface LedgerTxn {
  txnId: string;
  refType: string;
  memo: string;
  createdAt: string;
  lines: Array<{
    accountCode: string;
    accountName: string;
    direction: 'debit' | 'credit';
    amountVnd: number;
  }>;
}

export default async function LedgerPage() {
  const [{ balances }, { transactions }] = await Promise.all([
    apiFetch<{ balances: LedgerBalance[] }>('/api/ledger/balances'),
    apiFetch<{ transactions: LedgerTxn[] }>('/api/ledger/transactions'),
  ]);

  const totalDebit = balances.reduce((s, b) => s + b.debitTotalVnd, 0);
  const totalCredit = balances.reduce((s, b) => s + b.creditTotalVnd, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">So ke doi entry</h1>
        <p className="text-sm text-slate-500">
          Tong No = {formatVnd(totalDebit)} - Tong Co = {formatVnd(totalCredit)} -{' '}
          {totalDebit === totalCredit ? (
            <span className="font-semibold text-emerald-600">can bang</span>
          ) : (
            <span className="font-semibold text-red-600">KHONG can bang</span>
          )}
        </p>
      </div>

      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Tai khoan</th>
              <th className="px-3 py-2 text-right">No</th>
              <th className="px-3 py-2 text-right">Co</th>
              <th className="px-3 py-2 text-right">So du</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.accountCode} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <p className="font-medium">{b.accountName}</p>
                  <p className="text-xs text-slate-400">{b.accountCode}</p>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatVnd(b.debitTotalVnd)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatVnd(b.creditTotalVnd)}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {formatVnd(b.balanceVnd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Cac but to ke toan</h2>
        {transactions.map((txn) => (
          <div key={txn.txnId} className="card space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{txn.memo}</p>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {txn.refType}
              </span>
            </div>
            <ul className="space-y-1 text-sm">
              {txn.lines.map((line, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="text-slate-600">
                    {line.direction === 'debit' ? 'No' : 'Co'} {line.accountCode}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatVnd(line.amountVnd)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
