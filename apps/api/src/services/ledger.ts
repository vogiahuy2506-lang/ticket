import type { Db } from '../db/types.js';
import { withTx } from '../db/types.js';
import {
  ACCOUNT_CODES,
  availableAccountCode,
  ensurePlatformAccounts,
  ensureUserAccounts,
  getAccountByCode,
  pendingAccountCode,
  refundAccountCode,
} from '../db/accounts.js';

/**
 * Double-entry ledger.
 *
 * Every money movement is one `ledger_transactions` row with N
 * `ledger_entries` lines. Invariants enforced here:
 *
 *  1. each line amount > 0 (enforced by CHECK constraint as well)
 *  2. sum(debit) === sum(credit) for every transaction
 *  3. a transaction is written inside one DB transaction, so a partially
 *     applied posting is impossible
 *  4. all balances are derived by aggregating ledger_entries; there is no
 *     balance column anywhere in the schema
 */

export interface PostingLine {
  accountCode: string;
  direction: 'debit' | 'credit';
  amountVnd: number;
}

export interface Posting {
  refType: string;
  refId?: string | null;
  memo: string;
  lines: PostingLine[];
}

export interface TransactionSummary {
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

/**
 * Posts a balanced double-entry transaction.
 *
 * Throws if the lines are not balanced - a caller must never be able to
 * write an unbalanced journal entry.
 */
export async function postTransaction(sql: Db, posting: Posting): Promise<string> {
  const debitTotal = posting.lines
    .filter((l) => l.direction === 'debit')
    .reduce((sum, l) => sum + l.amountVnd, 0);
  const creditTotal = posting.lines
    .filter((l) => l.direction === 'credit')
    .reduce((sum, l) => sum + l.amountVnd, 0);

  if (posting.lines.length < 2) {
    throw new Error('A double-entry transaction needs at least two lines');
  }
  if (debitTotal !== creditTotal) {
    throw new Error(
      `Unbalanced transaction: debit ${debitTotal} !== credit ${creditTotal}`,
    );
  }
  if (debitTotal <= 0) {
    throw new Error('Transaction total must be positive');
  }
  for (const line of posting.lines) {
    if (!Number.isSafeInteger(line.amountVnd) || line.amountVnd <= 0) {
      throw new Error(`Invalid line amount: ${line.amountVnd}`);
    }
  }

  return withTx(sql, async (tx) => {
    const txnRows = await tx<{ id: string }[]>`
      INSERT INTO ledger_transactions (ref_type, ref_id, memo)
      VALUES (${posting.refType}, ${posting.refId ?? null}, ${posting.memo})
      RETURNING id
    `;
    const txnId = txnRows[0]!.id;

    for (const line of posting.lines) {
      const account = await getAccountByCode(tx, line.accountCode);
      if (!account) {
        throw new Error(`Ledger account not found: ${line.accountCode}`);
      }
      await tx`
        INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
        VALUES (${txnId}, ${account.id}, ${line.direction}, ${line.amountVnd})
      `;
    }

    return txnId;
  });
}

export interface AccountBalance {
  accountCode: string;
  accountName: string;
  kind: string;
  ownerUserId: string | null;
  /** sum(debit) - sum(credit); for liabilities this is the negative of the owed amount */
  debitTotalVnd: number;
  creditTotalVnd: number;
  /** signed balance from the account owner's point of view */
  balanceVnd: number;
}

/**
 * Computes every account balance from the ledger.
 *
 * Sign convention:
 *   assets / expenses : debit positive  -> balance = debit - credit
 *   liabilities / revenue / equity : credit positive -> balance = credit - debit
 */
export async function computeBalances(sql: Db): Promise<AccountBalance[]> {
  const rows = await sql<
    Array<{
      code: string;
      name: string;
      kind: string;
      owner_user_id: string | null;
      debit_total: string;
      credit_total: string;
    }>
  >`
    SELECT
      a.code,
      a.name,
      a.kind,
      a.owner_user_id,
      COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_vnd END), 0) AS debit_total,
      COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_vnd END), 0) AS credit_total
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_id = a.id
    GROUP BY a.id, a.code, a.name, a.kind, a.owner_user_id
    ORDER BY a.code
  `;

  return rows.map((r) => {
    const debit = Number(r.debit_total);
    const credit = Number(r.credit_total);
    const creditPositive =
      r.kind === 'liability' || r.kind === 'revenue' || r.kind === 'equity';
    return {
      accountCode: r.code,
      accountName: r.name,
      kind: r.kind,
      ownerUserId: r.owner_user_id,
      debitTotalVnd: debit,
      creditTotalVnd: credit,
      balanceVnd: creditPositive ? credit - debit : debit - credit,
    };
  });
}

export interface UserBalances {
  userId: string;
  pendingVnd: number;
  availableVnd: number;
  /** money the platform owes this user back (a late payment) */
  refundOwedVnd: number;
  totalVnd: number;
  platformFeeVnd: number;
  gatewayCashVnd: number;
}

export async function getUserBalances(
  sql: Db,
  userId: string,
): Promise<UserBalances> {
  const balances = await computeBalances(sql);
  const byCode = new Map(balances.map((b) => [b.accountCode, b]));

  const pending = byCode.get(pendingAccountCode(userId))?.balanceVnd ?? 0;
  const available = byCode.get(availableAccountCode(userId))?.balanceVnd ?? 0;
  const refundOwed = byCode.get(refundAccountCode(userId))?.balanceVnd ?? 0;

  return {
    userId,
    pendingVnd: pending,
    availableVnd: available,
    refundOwedVnd: refundOwed,
    totalVnd: pending + available + refundOwed,
    platformFeeVnd: byCode.get(ACCOUNT_CODES.platformFee)?.balanceVnd ?? 0,
    gatewayCashVnd: byCode.get(ACCOUNT_CODES.gatewayCash)?.balanceVnd ?? 0,
  };
}

export async function listTransactions(
  sql: Db,
  limit = 100,
): Promise<TransactionSummary[]> {
  const txns = await sql<
    Array<{
      id: string;
      ref_type: string;
      ref_id: string | null;
      memo: string;
      created_at: string;
    }>
  >`
    SELECT id, ref_type, ref_id, memo, created_at
    FROM ledger_transactions
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const lines = await sql<
    Array<{
      txn_id: string;
      code: string;
      name: string;
      direction: 'debit' | 'credit';
      amount_vnd: string;
    }>
  >`
    SELECT e.txn_id, a.code, a.name, e.direction, e.amount_vnd
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.txn_id IN ${sql(txns.map((t) => t.id))}
    ORDER BY a.code
  `;

  const linesByTxn = new Map<string, TransactionSummary['lines']>();
  for (const l of lines) {
    const arr = linesByTxn.get(l.txn_id) ?? [];
    arr.push({
      accountCode: l.code,
      accountName: l.name,
      direction: l.direction,
      amountVnd: Number(l.amount_vnd),
    });
    linesByTxn.set(l.txn_id, arr);
  }

  return txns.map((t) => ({
    txnId: t.id,
    refType: t.ref_type,
    refId: t.ref_id,
    memo: t.memo,
    createdAt: t.created_at,
    lines: linesByTxn.get(t.id) ?? [],
  }));
}

/**
 * The transactions that touched one user's accounts.
 *
 * The wallet cannot simply take the last N transactions of the whole
 * platform and filter them in JavaScript: on a busy platform the user's
 * own entries would fall outside that window and simply disappear from
 * their wallet. The filter is therefore done in the database, and the
 * limit applies to *the user's* transactions.
 */
export async function listTransactionsForUser(
  sql: Db,
  userId: string,
  limit = 50,
): Promise<TransactionSummary[]> {
  const txns = await sql<
    Array<{
      id: string;
      ref_type: string;
      ref_id: string | null;
      memo: string;
      created_at: string;
    }>
  >`
    SELECT DISTINCT t.id, t.ref_type, t.ref_id, t.memo, t.created_at
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE a.owner_user_id = ${userId}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${limit}
  `;

  if (txns.length === 0) return [];

  const lines = await sql<
    Array<{
      txn_id: string;
      code: string;
      name: string;
      direction: 'debit' | 'credit';
      amount_vnd: string;
    }>
  >`
    SELECT e.txn_id, a.code, a.name, e.direction, e.amount_vnd
    FROM ledger_entries e
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.txn_id IN ${sql(txns.map((t) => t.id))}
    ORDER BY a.code
  `;

  const linesByTxn = new Map<string, TransactionSummary['lines']>();
  for (const l of lines) {
    const arr = linesByTxn.get(l.txn_id) ?? [];
    arr.push({
      accountCode: l.code,
      accountName: l.name,
      direction: l.direction,
      amountVnd: Number(l.amount_vnd),
    });
    linesByTxn.set(l.txn_id, arr);
  }

  return txns.map((t) => ({
    txnId: t.id,
    refType: t.ref_type,
    refId: t.ref_id,
    memo: t.memo,
    createdAt: t.created_at,
    lines: linesByTxn.get(t.id) ?? [],
  }));
}

/**
 * Verifies the ledger globally: every transaction must be balanced.
 * Exposed as an API endpoint and used by the test suite - this is the check
 * that backs the claim "every balance is derivable from the ledger".
 */
export async function auditLedger(sql: Db): Promise<{
  ok: boolean;
  unbalanced: Array<{ txnId: string; debit: number; credit: number }>;
}> {
  const rows = await sql<Array<{ txn_id: string; debit: string; credit: string }>>`
    SELECT
      txn_id,
      COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_vnd END), 0) AS debit,
      COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_vnd END), 0) AS credit
    FROM ledger_entries
    GROUP BY txn_id
    HAVING COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_vnd END), 0)
        <> COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_vnd END), 0)
  `;
  return {
    ok: rows.length === 0,
    unbalanced: rows.map((r) => ({
      txnId: r.txn_id,
      debit: Number(r.debit),
      credit: Number(r.credit),
    })),
  };
}

/**
 * The display name of a user, used to label their ledger accounts.
 *
 * The name is read from the `users` table rather than passed in, because
 * passing the id as the name would label the account "Tiền chờ giải ngân -
 * 9babd67a-3607-4505-b42b-b02a6d0eead3" - a UUID in a place where a human
 * name belongs.
 */
async function sellerName(sql: Db, userId: string): Promise<string> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0]?.name ?? userId;
}

/**
 * Books a captured payment: money arrives at the gateway, part of it is owed
 * to the seller (escrowed) and the platform keeps the fee difference.
 */
export async function postPaymentCapture(
  sql: Db,
  args: {
    orderId: string;
    sellerId: string;
    grossVnd: number;
    sellerNetVnd: number;
    platformFeeVnd: number;
    memo: string;
  },
): Promise<string> {
  await ensurePlatformAccounts(sql);
  await ensureUserAccounts(sql, args.sellerId, await sellerName(sql, args.sellerId));

  // A very cheap ticket can round the platform fee down to zero (5% of a
  // 9-dong subtotal is 0). The journal rejects a zero-amount line, so the
  // zero line is left out instead of failing the whole payment - the
  // buyer would otherwise be charged for a ticket that is never booked.
  const lines: PostingLine[] = (
    [
      {
        accountCode: ACCOUNT_CODES.gatewayCash,
        direction: 'debit' as const,
        amountVnd: args.grossVnd,
      },
      {
        accountCode: pendingAccountCode(args.sellerId),
        direction: 'credit' as const,
        amountVnd: args.sellerNetVnd,
      },
      {
        accountCode: ACCOUNT_CODES.platformFee,
        direction: 'credit' as const,
        amountVnd: args.platformFeeVnd,
      },
    ] satisfies PostingLine[]
  ).filter((l) => l.amountVnd > 0);

  return postTransaction(sql, {
    refType: 'PAYMENT_CAPTURE',
    refId: args.orderId,
    memo: args.memo,
    lines,
  });
}

/**
 * Releases escrowed money for one order: pending liability -> available liability.
 */
export async function postEscrowRelease(
  sql: Db,
  args: { orderId: string; sellerId: string; amountVnd: number; memo: string },
): Promise<string> {
  return postTransaction(sql, {
    refType: 'ESCROW_RELEASE',
    refId: args.orderId,
    memo: args.memo,
    lines: [
      {
        accountCode: pendingAccountCode(args.sellerId),
        direction: 'debit',
        amountVnd: args.amountVnd,
      },
      {
        accountCode: availableAccountCode(args.sellerId),
        direction: 'credit',
        amountVnd: args.amountVnd,
      },
    ],
  });
}

/**
 * Books a payment that arrived after the ticket reservation had expired.
 *
 * The buyer paid, but the tickets were already sold to somebody else, so the
 * seller must not receive the money. The amount leaves the gateway cash and
 * becomes a liability towards *that buyer* - the platform owes them a
 * refund. The refund is booked on a per-buyer account
 * (`liability:user:{id}:refund`) so the buyer can see what they are owed
 * in their own wallet, instead of the platform holding an anonymous lump
 * of money somewhere.
 *
 * The actual refund API call is out of scope for this test task, so the
 * money stays in that account until an operator refunds it.
 */
export async function postLatePaymentRefund(
  sql: Db,
  args: { orderId: string; buyerId: string; amountVnd: number; memo: string },
): Promise<string> {
  await ensurePlatformAccounts(sql);
  await ensureUserAccounts(sql, args.buyerId, await sellerName(sql, args.buyerId));

  return postTransaction(sql, {
    refType: 'LATE_PAYMENT_REFUND',
    refId: args.orderId,
    memo: args.memo,
    lines: [
      {
        accountCode: ACCOUNT_CODES.gatewayCash,
        direction: 'debit',
        amountVnd: args.amountVnd,
      },
      {
        accountCode: refundAccountCode(args.buyerId),
        direction: 'credit',
        amountVnd: args.amountVnd,
      },
    ],
  });
}
