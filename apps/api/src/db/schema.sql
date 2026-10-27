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
  status            TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'RELEASED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_REQUIRED')),
  gateway           TEXT NOT NULL,
  -- The ticket reservation is only valid for this long. When it passes
  -- the order is EXPIRED and the tickets go back to the listing.
  expires_at        TIMESTAMPTZ NOT NULL,
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

-- Every notification the gateway sent us, *including* the ones we rejected.
--
-- This is the reconciliation log: an operator can compare it against the
-- gateway's own transaction list to find notifications that were lost or
-- that arrived with a bad signature. Without it, a dropped IPN is invisible.
CREATE TABLE IF NOT EXISTS payment_events (
  id                BIGSERIAL PRIMARY KEY,
  txn_ref           TEXT,
  provider_txn_id   TEXT,
  signature_valid   BOOLEAN NOT NULL,
  applied           BOOLEAN NOT NULL DEFAULT false,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_events_txn_ref_idx ON payment_events(txn_ref);

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

-- ---------------------------------------------------------------------
-- Immutability of the journal.
--
-- Decision (brief was silent): a posted ledger entry must never be edited
-- or deleted. The only way to correct a mistake is to post a *reversing*
-- transaction, which keeps the history auditable. This is enforced by the
-- database, not by convention, so an operator with SQL access cannot
-- silently rewrite the money history.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_transactions_no_update ON ledger_transactions;
CREATE TRIGGER ledger_transactions_no_update
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- The same rule for the gateway notifications: they are evidence of what
-- the gateway told us and must not be rewritten either.
DROP TRIGGER IF EXISTS payments_no_update ON payments;
CREATE TRIGGER payments_no_update
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ---------------------------------------------------------------------
-- Idempotency of checkout.
--
-- Decision (brief was silent): a double-tapped "Pay" button must not
-- create two orders. The client sends an Idempotency-Key; the same key
-- from the same buyer returns the original order instead of a new one.
-- ---------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_uniq
  ON orders (buyer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- Migration of an existing database.
--
-- The schema above uses CREATE TABLE IF NOT EXISTS, so a database created
-- before a column was added would keep the old shape. These statements
-- bring an existing database up to the current definition. They are all
-- idempotent, so running them on a fresh database is a no-op.
-- ---------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Existing orders have no expiry; give them one so the column is never
-- null and the lazy expiry can compare against it.
UPDATE orders
   SET expires_at = created_at + interval '15 minutes'
 WHERE expires_at IS NULL;

-- The status CHECK constraint has to be replaced to allow the two new
-- states. The old constraint is dropped by name; if it does not exist
-- (a fresh database) the DROP is a no-op.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'RELEASED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUND_REQUIRED'));

-- A raw notification is evidence of what the gateway said; it must not be
-- rewritten either.
DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
CREATE TRIGGER payment_events_no_update
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
