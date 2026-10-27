import { apiFetch } from '@/lib/api';
import { formatVnd } from '@tce/shared';
import { Badge, MoneyRow, PageHeader, SectionTitle } from '@/components/ui';

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

const KIND_TONE: Record<string, 'info' | 'brand' | 'success' | 'neutral' | 'danger'> = {
  asset: 'info',
  liability: 'brand',
  revenue: 'success',
  equity: 'neutral',
  expense: 'danger',
};

const REF_TONE: Record<string, 'info' | 'success'> = {
  PAYMENT_CAPTURE: 'info',
  ESCROW_RELEASE: 'success',
};

const REF_LABEL: Record<string, string> = {
  PAYMENT_CAPTURE: 'Thanh toan',
  ESCROW_RELEASE: 'Giai ngan escrow',
};

export default async function LedgerPage() {
  const [{ balances }, { transactions }] = await Promise.all([
    apiFetch<{ balances: LedgerBalance[] }>('/api/ledger/balances'),
    apiFetch<{ transactions: LedgerTxn[] }>('/api/ledger/transactions'),
  ]);

  const totalDebit = balances.reduce((s, b) => s + b.debitTotalVnd, 0);
  const totalCredit = balances.reduce((s, b) => s + b.creditTotalVnd, 0);
  const balanced = totalDebit === totalCredit;

  // Only accounts that actually moved, so the table is not padded with zeros.
  const active = balances.filter(
    (b) => b.debitTotalVnd !== 0 || b.creditTotalVnd !== 0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="So ke doi entry"
        subtitle="Moi dong tien deu duoc ghi vao mot but to co hai dong (No - Co). Khong co so du nao duoc luu rieng."
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Tong No
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-ink-900">
            {formatVnd(totalDebit)}
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Tong Co
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-ink-900">
            {formatVnd(totalCredit)}
          </p>
        </div>
      </div>

      <div
        className={`flex items-center gap-2.5 rounded-2xl border p-3.5 text-sm font-medium ${
          balanced
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}
      >
        <span
          aria-hidden
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
            balanced ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        >
          {balanced ? '=' : '!'}
        </span>
        {balanced
          ? 'So ke doi entry can bang - Tong No bang Tong Co.'
          : 'SO KE DOI ENTRY KHONG CAN BANG.'}
      </div>

      <section className="space-y-3">
        <SectionTitle
          title="So du tai khoan"
          hint={`${active.length} tai khoan da co phat sinh`}
        />

        <div className="card scroll-x p-0">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/70 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-4 py-2.5 font-semibold">Tai khoan</th>
                <th className="px-4 py-2.5 text-right font-semibold">No</th>
                <th className="px-4 py-2.5 text-right font-semibold">Co</th>
                <th className="px-4 py-2.5 text-right font-semibold">So du</th>
              </tr>
            </thead>
            <tbody className="divide-line">
              {active.map((b) => (
                <tr
                  key={b.accountCode}
                  className="transition-colors hover:bg-ink-50/60"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-ink-900">{b.accountName}</p>
                      <Badge tone={KIND_TONE[b.kind] ?? 'neutral'}>
                        {b.kind}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-ink-400">
                      {b.accountCode}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right table-num text-ink-600">
                    {b.debitTotalVnd === 0 ? (
                      <span className="text-ink-300">-</span>
                    ) : (
                      formatVnd(b.debitTotalVnd)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right table-num text-ink-600">
                    {b.creditTotalVnd === 0 ? (
                      <span className="text-ink-300">-</span>
                    ) : (
                      formatVnd(b.creditTotalVnd)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right table-num font-bold text-ink-900">
                    {formatVnd(b.balanceVnd)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-200 bg-ink-50/70">
                <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-ink-500">
                  Tong cong
                </td>
                <td className="px-4 py-2.5 text-right table-num font-bold text-ink-900">
                  {formatVnd(totalDebit)}
                </td>
                <td className="px-4 py-2.5 text-right table-num font-bold text-ink-900">
                  {formatVnd(totalCredit)}
                </td>
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle
          title="Cac but to ke toan"
          hint={`${transactions.length} but to`}
        />

        {transactions.length === 0 ? (
          <p className="card text-sm text-ink-500">Chua co but to nao.</p>
        ) : null}

        <div className="space-y-3">
          {transactions.map((txn) => (
            <article key={txn.txnId} className="card overflow-hidden p-0">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">
                    {txn.memo}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {new Date(txn.createdAt).toLocaleString('vi-VN', {
                      dateStyle: 'medium',
                      timeStyle: 'medium',
                    })}
                  </p>
                </div>
                <Badge tone={REF_TONE[txn.refType] ?? 'neutral'}>
                  {REF_LABEL[txn.refType] ?? txn.refType}
                </Badge>
              </div>

              <ul className="divide-line">
                {txn.lines.map((line, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                          line.direction === 'debit'
                            ? 'bg-brand-50 text-brand-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {line.direction === 'debit' ? 'No' : 'Co'}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink-700">
                          {line.accountName}
                        </p>
                        <p className="truncate font-mono text-[11px] text-ink-400">
                          {line.accountCode}
                        </p>
                      </div>
                    </div>
                    <span className="shrink-0 table-num text-sm font-semibold text-ink-900">
                      {formatVnd(line.amountVnd)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="card space-y-1">
        <p className="text-sm font-semibold text-ink-900">Tai khoan pho bien</p>
        <MoneyRow
          label="asset:gateway_cash - Tien tai cong thanh toan"
          value="Tien cua san dang giu"
        />
        <MoneyRow
          label="liability:user:...:pending - Tien cho giai ngan"
          value="Escrow cua nguoi ban"
        />
        <MoneyRow
          label="liability:user:...:available - Tien kha dung"
          value="San duong rut"
        />
        <MoneyRow
          label="revenue:platform_fee - Phi dich vu cua san"
          value="Doanh thu"
        />
      </section>
    </div>
  );
}
