import { api } from '@/lib/api';
import { getCurrentUser } from '@/lib/session';
import { formatVnd } from '@tce/shared';
import { Badge, EmptyState, MoneyRow, PageHeader, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <EmptyState title="Chua co nguoi dung" hint="Chon mot nguoi dung o thanh tren de xem vi." />
    );
  }

  const { balances, transactions } = await api.wallet(user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Vi cua ${user.name}`}
        subtitle="So du duoc tinh truc tiep tu so ke doi entry - khong co cot so du rieng."
        action={<Badge tone="brand">{user.role}</Badge>}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Cho giai ngan
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-amber-700">
            {formatVnd(balances.pendingVnd)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Tien ban giu cho den khi su kien dien ra
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Khai dung
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-emerald-700">
            {formatVnd(balances.availableVnd)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Da giai ngan, co the rut
          </p>
        </div>
      </div>

      <section className="card space-y-1">
        <SectionTitle title="Tong cong" />
        <MoneyRow
          label="Tong cua ban"
          value={formatVnd(balances.totalVnd)}
          strong
        />
        <div className="border-t border-ink-100 pt-1">
          <MoneyRow
            label="Tien tai cong thanh toan"
            value={formatVnd(balances.gatewayCashVnd)}
            tone="muted"
          />
          <MoneyRow
            label="Doanh thu phi cua san"
            value={formatVnd(balances.platformFeeVnd)}
            tone="muted"
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle
          title="Lich su giao dich"
          hint={`${transactions.length} giao dich`}
        />

        {transactions.length === 0 ? (
          <EmptyState
            title="Chua co giao dich nao"
            hint="Mua mot ve o trang Su kien de xem cac dong tien di vao vi nay."
          />
        ) : null}

        <div className="space-y-2.5">
          {transactions.map((txn) => (
            <article
              key={txn.txnId}
              className="card overflow-hidden p-0"
            >
              <div className="flex items-start justify-between gap-2 border-b border-ink-100 bg-ink-50/60 px-4 py-2.5">
                <p className="min-w-0 text-sm font-medium text-ink-900">
                  {txn.memo}
                </p>
                <span className="shrink-0 text-[11px] text-ink-400">
                  {new Date(txn.createdAt).toLocaleString('vi-VN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
              <ul className="divide-line">
                {txn.lines.map((line, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          line.direction === 'debit'
                            ? 'bg-brand-50 text-brand-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {line.direction === 'debit' ? 'No' : 'Co'}
                      </span>
                      <span className="truncate text-xs text-ink-600">
                        {line.accountName}
                      </span>
                    </div>
                    <span className="shrink-0 table-num text-xs font-semibold text-ink-900">
                      {formatVnd(line.amountVnd)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
