import { api } from '@/lib/api';
import { getCurrentUser } from '@/lib/session';
import { formatVnd, ledgerEntryTitle } from '@tce/shared';
import { Badge, EmptyState, MoneyRow, PageHeader, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <EmptyState title="Chưa có người dùng" hint="Chọn một người dùng ở thanh trên để xem ví." />
    );
  }

  const { balances, transactions } = await api.wallet(user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Ví của ${user.name}`}
        subtitle="Số dư được tính trực tiếp từ lịch sử giao dịch - không có cột số dư riêng."
        action={<Badge tone="brand">{user.role}</Badge>}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Chờ giải ngân
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-amber-700">
            {formatVnd(balances.pendingVnd)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Tiền bạn giữ cho đến khi sự kiện diễn ra
          </p>
        </div>
        <div className="card">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
            Khả dụng
          </p>
          <p className="mt-1.5 text-lg font-bold table-num text-emerald-700">
            {formatVnd(balances.availableVnd)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">
            Đã giải ngân, có thể rút
          </p>
        </div>
      </div>

      <section className="card space-y-1">
        <SectionTitle title="Tổng cộng" />
        <MoneyRow
          label="Tổng của bạn"
          value={formatVnd(balances.totalVnd)}
          strong
        />
        <div className="border-t border-ink-100 pt-1">
          <MoneyRow
            label="Tiền tại cổng thanh toán"
            value={formatVnd(balances.gatewayCashVnd)}
            tone="muted"
          />
          <MoneyRow
            label="Doanh thu phí của sàn"
            value={formatVnd(balances.platformFeeVnd)}
            tone="muted"
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionTitle
          title="Lịch sử giao dịch"
          hint={`${transactions.length} giao dịch`}
        />

        {transactions.length === 0 ? (
          <EmptyState
            title="Chưa có giao dịch nào"
            hint="Mua một vé ở trang Sự kiện để xem các dòng tiền đi vào ví này."
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
                  {ledgerEntryTitle(txn.refType, txn.refId)}
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
                        {line.direction === 'debit' ? 'Nợ' : 'Có'}
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
