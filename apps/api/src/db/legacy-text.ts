import type { Db } from './types.js';

/**
 * Names that older versions of the app wrote without Vietnamese diacritics.
 *
 * The demo data is seeded by name, so a database that was created before the
 * copy was fixed still holds rows like "Le Huy (nguoi ban)". Those names leak
 * into the ledger account labels and into the UI, where they look like a
 * broken encoding rather than like a deliberate design.
 *
 * The mapping is keyed by the old name. It is deliberately exhaustive for the
 * seeded users: an unknown name is left alone, because renaming a real user's
 * display name would change data the operator entered by hand.
 */
const LEGACY_USER_NAMES: Record<string, string> = {
  'Nguyen Lan (nguoi mua)': 'Nguyễn Lan (người mua)',
  'Pham Dung (nguoi mua)': 'Phạm Dung (người mua)',
  'Tran Minh (nguoi ban)': 'Trần Minh (người bán)',
  'Le Huy (nguoi ban)': 'Lê Huy (người bán)',
  'Vo Chi (nguoi ban)': 'Võ Chị (người bán)',
};

/**
 * Renames the seeded users that still carry their old, unaccented name.
 *
 * `users.name` is UNIQUE, so a rename can collide with a row that already
 * has the accented name. In that case the old row is left as it is - the
 * seeded users are looked up by name afterwards, so a duplicate would be
 * harmless, but failing the migration would not be.
 */
export async function fixLegacyUserNames(sql: Db): Promise<number> {
  let fixed = 0;

  for (const [legacy, current] of Object.entries(LEGACY_USER_NAMES)) {
    const rows = await sql<{ id: string }[]>`
      UPDATE users SET name = ${current}
      WHERE name = ${legacy}
        AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.name = ${current})
      RETURNING id
    `;
    fixed += rows.length;
  }

  return fixed;
}

/**
 * Refreshes the label of a ledger account whose owner was renamed.
 *
 * The account name is built from the user's name ("Tiền chờ giải ngân -
 * Le Huy (nguoi ban)"), so a renamed user leaves a stale label behind. The
 * account code itself is the identity, the label is only a label.
 */
export async function fixLegacyAccountNames(sql: Db): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE ledger_accounts a
    SET name = 'Tiền chờ giải ngân - ' || u.name
    FROM users u
    WHERE a.owner_user_id = u.id
      AND a.code LIKE 'liability:user:%:pending'
      AND a.name <> 'Tiền chờ giải ngân - ' || u.name
  `;
  const pending = rows.length;

  await sql`
    UPDATE ledger_accounts a
    SET name = 'Tiền khả dụng - ' || u.name
    FROM users u
    WHERE a.owner_user_id = u.id
      AND a.code LIKE 'liability:user:%:available'
      AND a.name <> 'Tiền khả dụng - ' || u.name
  `;

  return pending;
}

/**
 * Moves the refunds of the old shared account onto the per-buyer accounts.
 *
 * The refunds used to be booked on one global `liability:refund_payable`
 * account, which meant a buyer could not see what the platform owed them.
 * They are now booked on `liability:user:{id}:refund`.
 *
 * A journal entry cannot be edited or deleted, so the money is *moved*, not
 * rewritten: a reversing transaction takes the balance off the old account
 * and puts it on the new one. The order that produced the refund is known
 * from the transaction's `ref_id`, so each buyer's refunds can be split
 * without guessing.
 *
 * The old account is left in place (with a zero balance) so the history
 * stays readable.
 */
export async function moveRefundsToBuyerAccounts(sql: Db): Promise<number> {
  const oldAccount = await sql<{ id: string }[]>`
    SELECT id FROM ledger_accounts WHERE code = 'liability:refund_payable' LIMIT 1
  `;
  if (!oldAccount[0]) return 0;

  const balance = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_vnd
                             WHEN direction = 'debit'  THEN -amount_vnd END), 0) AS total
    FROM ledger_entries
    WHERE account_id = ${oldAccount[0].id}
  `;
  const total = Number(balance[0]?.total ?? 0);
  if (total === 0) return 0;

  // The refunds that are still on the old account, grouped by the buyer of
  // the order they belong to.
  //
  // The transactions this migration writes are marked with
  // `ref_type = 'REFUND_REASSIGN'`, so a second run finds nothing left on
  // the old account and does nothing.
  const refunds = await sql<
    Array<{ buyer_id: string; user_name: string; amount_vnd: string }>
  >`
    SELECT o.buyer_id, u.name AS user_name, SUM(e.amount_vnd) AS amount_vnd
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.txn_id
    JOIN orders o ON o.id = t.ref_id
    JOIN users u ON u.id = o.buyer_id
    WHERE e.account_id = ${oldAccount[0].id}
      AND t.ref_type = 'LATE_PAYMENT_REFUND'
      AND e.direction = 'credit'
    GROUP BY o.buyer_id, u.name
  `;

  for (const r of refunds) {
    const amount = Number(r.amount_vnd);
    if (amount <= 0) continue;

    const code = `liability:user:${r.buyer_id}:refund`;
    const account = await sql<{ id: string }[]>`
      INSERT INTO ledger_accounts (code, kind, owner_user_id, name)
      VALUES (${code}, 'liability', ${r.buyer_id}, ${`Tiền phải hoàn - ${r.user_name}`})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;

    // A reversing pair: the money leaves the shared account and lands on
    // the buyer's own account. Two entries, one transaction, balanced.
    const txn = await sql<{ id: string }[]>`
      INSERT INTO ledger_transactions (ref_type, ref_id, memo)
      VALUES ('REFUND_REASSIGN', NULL, 'Chuyển nợ hoàn tiền sang tài khoản của người mua')
      RETURNING id
    `;

    await sql`
      INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
      VALUES
        (${txn[0]!.id}, ${oldAccount[0].id}, 'debit', ${amount}),
        (${txn[0]!.id}, ${account[0]!.id}, 'credit', ${amount})
    `;
  }

  return refunds.length;
}
