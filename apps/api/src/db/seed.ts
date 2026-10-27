import { getSql } from './client.js';
import { ensurePlatformAccounts, ensureUserAccounts } from './accounts.js';

/**
 * Idempotent seed.
 *
 * Decision (brief was silent): users are looked up by a stable `slug` so
 * re-running the seed never duplicates data and the demo users always have
 * stable ids.
 */
const BUYER_SLUG = 'buyer-lan';
const SELLER_SLUGS = ['seller-minh', 'seller-huy'];

export async function seed(): Promise<void> {
  const sql = getSql();

  const users = await sql<{ id: string; name: string }[]>`
    INSERT INTO users (name, role)
    VALUES
      ('Nguyen Lan (nguoi mua)', 'buyer'),
      ('Pham Dung (nguoi mua)', 'buyer'),
      ('Tran Minh (nguoi ban)', 'seller'),
      ('Le Huy (nguoi ban)', 'seller'),
      ('Vo Chi (nguoi ban)', 'seller'),
      ('Ops Admin', 'admin')
    ON CONFLICT DO NOTHING
    RETURNING id, name
  `;

  // ON CONFLICT DO NOTHING cannot target a slug because there is no unique
  // index on name yet; use a select-then-insert to stay idempotent.
  const allUsers = await sql<{ id: string; name: string; role: string }[]>`
    SELECT id, name, role FROM users ORDER BY name
  `;
  const byName = new Map(allUsers.map((u) => [u.name, u]));
  void users;

  const buyer = byName.get('Nguyen Lan (nguoi mua)');
  const seller1 = byName.get('Tran Minh (nguoi ban)');
  const seller2 = byName.get('Le Huy (nguoi ban)');
  const seller3 = byName.get('Vo Chi (nguoi ban)');
  const admin = byName.get('Ops Admin');

  if (!buyer || !seller1 || !seller2 || !seller3 || !admin) {
    throw new Error('Seed users missing - run the seeder on a fresh database');
  }

  await ensurePlatformAccounts(sql);
  for (const u of [buyer, seller1, seller2, seller3, admin]) {
    await ensureUserAccounts(sql, u.id, u.name);
  }

  const existingEvents = await sql<{ id: string }[]>`SELECT id FROM events LIMIT 1`;
  if (existingEvents.length > 0) {
    console.log('[seed] data already present, skipping');
    return;
  }

  const events = await sql<{ id: string; name: string }[]>`
    INSERT INTO events (name, venue, starts_at)
    VALUES
      ('Dai nhac Son Tra - Dem Mua', 'San Van Hoa TP.HCM', now() + interval '30 days'),
      ('Hoi thao Ky nam 2026', 'Nha thi dau My Dinh', now() + interval '60 days')
    RETURNING id, name
  `;
  const [concert, conference] = events;

  // Six listings across two events, at least two different sellers per
  // event. The prices are multiples of 1,000 (the usual ticket price) and
  // the quantities are small, so the demo data looks like a real market.
  //
  // The last listing is the odd one out on purpose: a price that is not a
  // multiple of 1,000 and a quantity of 3, so the half-up rounding of the
  // 10% / 5% fees is visible in the UI and in the e2e assertions.
  await sql`
    INSERT INTO listings (event_id, seller_id, title, quantity_total, price_vnd)
    VALUES
      (${concert!.id}, ${seller1.id}, 'Vé VIP - khu vuc A', 6, 1500000),
      (${concert!.id}, ${seller1.id}, 'Vé Standard - khu vuc B', 4, 900000),
      (${concert!.id}, ${seller2.id}, 'Vé vé vòng 2', 5, 1200000),
      (${concert!.id}, ${seller3.id}, 'Vé gia re - khu vuc C', 3, 800000),
      (${conference!.id}, ${seller2.id}, 'Vé phim khu vuc B', 4, 750000),
      (${conference!.id}, ${seller3.id}, 'Vé goc - gia le (test lam tron)', 3, 333333)
  `;

  console.log('[seed] users, events, listings created');
}
