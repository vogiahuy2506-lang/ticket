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
