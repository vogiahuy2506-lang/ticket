import { apiFetch } from '@/lib/api';
import { formatDateTimeVi, formatVnd, ledgerEntryTitle } from '@tce/shared';
import { Badge, MoneyRow, PageHeader, SectionTitle } from '@/components/ui';
import { AccountCode } from '@/components/AccountCode';

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
  refId: string | null;
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

const REF_TONE: Record<string, 'info' | 'success' | 'warning'> = {
  PAYMENT_CAPTURE: 'info',
  ESCROW_RELEASE: 'success',
  LATE_PAYMENT_REFUND: 'warning',
  REFUND_REASSIGN: 'warning',
};

const REF_LABEL: Record<string, string> = {
  PAYMENT_CAPTURE: 'Thanh toán',
  ESCROW_RELEASE: 'Giải ngân escrow',
  LATE_PAYMENT_REFUND: 'Hoàn tiền',
  REFUND_REASSIGN: 'Chuyển nợ hoàn tiền',
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
        title="Lịch sử giao dịch"
        subtitle="Mọi dòng tiền đều được ghi thành một giao dịch có hai dòng (Nợ - Có). Không có số dư nào được lưu riêng."
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Tổng Nợ
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-ink-900">
            {formatVnd(totalDebit)}
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Tổng Có
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
          ? 'Giao dịch cân bằng - Tổng Nợ bằng Tổng Có.'
          : 'GIAO DỊCH KHÔNG CÂN BẰNG.'}
      </div>

      <section className="space-y-3">
        <SectionTitle
          title="Số dư tài khoản"
          hint={`${active.length} tài khoản đã có phát sinh`}
        />

        <div className="card scroll-x p-0">
          {/*
            On a phone the four columns do not fit: 414px of viewport
            against a table that needs ~544px. The "No" and "Co" columns
            are the *movement* of an account; the "Số dư" column is what
            the account holds right now, which is the number a reader
            actually looks for. So the movement columns are hidden on a
            small screen and the balance stays visible - the account
            name, the kind and the balance are the useful summary, and
            the full journal entry further down the page still shows
            every debit and credit.
          */}
          <table className="w-full min-w-[20rem] text-sm sm:min-w-[34rem]">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/70 text-left text-[11px] uppercase tracking-wider text-ink-500">
                <th className="px-4 py-2.5 font-semibold">Tài khoản</th>
                <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">
                  Nợ
                </th>
                <th className="hidden px-4 py-2.5 text-right font-semibold sm:table-cell">
                  Có
                </th>
                <th className="px-4 py-2.5 text-right font-semibold">Số dư</th>
              </tr>
            </thead>
            <tbody className="divide-line">
              {active.map((b) => (
                <tr
                  key={b.accountCode}
                  className="transition-colors hover:bg-ink-50/60"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink-900">{b.accountName}</p>
                      <Badge tone={KIND_TONE[b.kind] ?? 'neutral'}>
                        {b.kind}
                      </Badge>
                    </div>
                    {/*
                      The account code carries a UUID, so it is far too
                      long for a phone. It is shown shortened, expands on
                      click and can be copied - see AccountCode.
                    */}
                    <AccountCode code={b.accountCode} />
                  </td>
                  <td className="hidden px-4 py-3 text-right table-num text-ink-600 sm:table-cell">
                    {b.debitTotalVnd === 0 ? (
                      <span className="text-ink-300">-</span>
                    ) : (
                      formatVnd(b.debitTotalVnd)
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-right table-num text-ink-600 sm:table-cell">
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
                  Tổng cộng
                </td>
                <td className="hidden px-4 py-2.5 text-right table-num font-bold text-ink-900 sm:table-cell">
                  {formatVnd(totalDebit)}
                </td>
                <td className="hidden px-4 py-2.5 text-right table-num font-bold text-ink-900 sm:table-cell">
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
          title="Các giao dịch"
          hint={`${transactions.length} giao dịch`}
        />

        {transactions.length === 0 ? (
          <p className="card text-sm text-ink-500">Chưa có giao dịch nào.</p>
        ) : null}

        <div className="space-y-3">
          {transactions.map((txn) => (
            <article key={txn.txnId} className="card overflow-hidden p-0">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">
                    {ledgerEntryTitle(txn.refType, txn.refId)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {formatDateTimeVi(txn.createdAt, {
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
                        {line.direction === 'debit' ? 'Nợ' : 'Có'}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink-700">
                          {line.accountName}
                        </p>
                        <AccountCode code={line.accountCode} truncate />
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
        <p className="text-sm font-semibold text-ink-900">Tài khoản phổ biến</p>
        <MoneyRow
          label="asset:gateway_cash - Tiền tại cổng thanh toán"
          value="Tiền của sàn đang giữ"
        />
        <MoneyRow
          label="liability:user:...:pending - Tiền chờ giải ngân"
          value="Escrow của người bán"
        />
        <MoneyRow
          label="liability:user:...:available - Tiền khả dụng"
          value="Sẵn sàng rút"
        />
        <MoneyRow
          label="revenue:platform_fee - Phí dịch vụ của sàn"
          value="Doanh thu"
        />
      </section>
    </div>
  );
}
