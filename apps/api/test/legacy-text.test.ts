import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fixLegacyAccountNames,
  fixLegacyUserNames,
} from '../src/db/legacy-text.js';
import {
  createIsolatedDb,
  isDatabaseReachable,
  useIsolatedDb,
  type IsolatedDb,
} from './helpers/db.js';

/**
 * A database that was created before the copy was fixed still holds rows
 * with unaccented names. Those names leak into the ledger account labels
 * and into the UI, where they look like a broken encoding. The migration
 * has to repair them on its own - nobody is going to run a manual script.
 */
const dbAvailable = await isDatabaseReachable();

describe.skipIf(!dbAvailable)('legacy text repair', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDb('legacy');
    useIsolatedDb(db.sql);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('renames a seeded user that still carries the old name', async () => {
    const rows = await db.sql<{ id: string }[]>`
      INSERT INTO users (name, role)
      VALUES ('Le Huy (nguoi ban)', 'seller')
      RETURNING id
    `;
    const id = rows[0]!.id;

    const fixed = await fixLegacyUserNames(db.sql);
    expect(fixed).toBe(1);

    const after = await db.sql<{ name: string }[]>`
      SELECT name FROM users WHERE id = ${id}
    `;
    expect(after[0]!.name).toBe('Lê Huy (người bán)');
  });

  it('never renames a user whose accented name already exists', async () => {
    await db.sql`
      INSERT INTO users (name, role)
      VALUES ('Vo Chi (nguoi ban)', 'seller')
    `;
    await db.sql`
      INSERT INTO users (name, role)
      VALUES ('Võ Chị (người bán)', 'seller')
    `;

    // The rename would violate the UNIQUE constraint on users.name, so
    // the legacy row is left alone instead of breaking the migration.
    await fixLegacyUserNames(db.sql);

    const names = await db.sql<{ name: string }[]>`
      SELECT name FROM users WHERE name LIKE 'Vo Chi%' OR name LIKE 'Võ Chị%'
      ORDER BY name
    `;
    expect(names.map((n) => n.name)).toEqual([
      'Vo Chi (nguoi ban)',
      'Võ Chị (người bán)',
    ]);
  });

  it('relabels the ledger accounts of a renamed user', async () => {
    const rows = await db.sql<{ id: string }[]>`
      INSERT INTO users (name, role)
      VALUES ('Tran Minh (nguoi ban)', 'seller')
      RETURNING id
    `;
    const userId = rows[0]!.id;

    await db.sql`
      INSERT INTO ledger_accounts (code, kind, owner_user_id, name)
      VALUES
        (${`liability:user:${userId}:pending`}, 'liability', ${userId},
         'Tien cho giai ngan - Tran Minh (nguoi ban)'),
        (${`liability:user:${userId}:available`}, 'liability', ${userId},
         'Tien kha dung - Tran Minh (nguoi ban)')
    `;

    await fixLegacyUserNames(db.sql);
    await fixLegacyAccountNames(db.sql);

    const accounts = await db.sql<{ code: string; name: string }[]>`
      SELECT code, name FROM ledger_accounts WHERE owner_user_id = ${userId}
      ORDER BY code
    `;
    expect(accounts.map((a) => a.name)).toEqual([
      'Tiền khả dụng - Trần Minh (người bán)',
      'Tiền chờ giải ngân - Trần Minh (người bán)',
    ]);
  });
});
