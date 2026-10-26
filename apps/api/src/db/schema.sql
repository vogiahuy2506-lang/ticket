-- Schema for the ticket marketplace slice.
-- Money is stored as BIGINT (integer VND). No float columns anywhere.

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  venue       TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seller_id         UUID NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  quantity_total    INTEGER NOT NULL CHECK (quantity_total > 0),
  quantity_sold     INTEGER NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  price_vnd         BIGINT NOT NULL CHECK (price_vnd >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listings_sold_within_total CHECK (quantity_sold <= quantity_total)
);

CREATE INDEX IF NOT EXISTS listings_event_idx ON listings(event_id);

CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          UUID NOT NULL REFERENCES users(id),
  listing_id        UUID NOT NULL REFERENCES listings(id),
  event_id          UUID NOT NULL REFERENCES events(id),
  seller_id         UUID NOT NULL REFERENCES users(id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_vnd    BIGINT NOT NULL CHECK (unit_price_vnd >= 0),
  subtotal_vnd      BIGINT NOT NULL,
  buyer_fee_vnd     BIGINT NOT NULL,
  seller_fee_vnd    BIGINT NOT NULL,
  gross_vnd         BIGINT NOT NULL,
  seller_net_vnd    BIGINT NOT NULL,
  platform_fee_vnd  BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'RELEASED', 'FAILED', 'CANCELLED')),
  gateway           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  released_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS orders_event_idx ON orders(event_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- One row per gateway notification. The unique constraint on
-- (provider, provider_txn_id) is what makes IPN handling idempotent.
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_txn_id   TEXT NOT NULL,
  provider_txn_ref  TEXT,
  amount_vnd        BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),
  raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_provider_txn_uniq UNIQUE (provider, provider_txn_id)
);

CREATE INDEX IF NOT EXISTS payments_order_idx ON payments(order_id);

-- Chart of accounts. user accounts are scoped to a single user via owner_user_id.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  owner_user_id UUID REFERENCES users(id),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type    TEXT NOT NULL,          -- e.g. 'PAYMENT_CAPTURE', 'ESCROW_RELEASE'
  ref_id      UUID,                   -- order id (nullable for manual/ops txns)
  memo        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Double-entry lines. Every transaction must have equal debit and credit totals.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id        UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES ledger_accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_vnd    BIGINT NOT NULL CHECK (amount_vnd > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_txn_idx ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries(account_id);
