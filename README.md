# Ticket checkout with escrow

A thin slice of a ticket resale marketplace: sell a ticket, take the money
through a real payment gateway, and account for every cent with a
double-entry ledger.

- **Storefront**: Next.js 15 (App Router, server-rendered), mobile-first
- **Backend**: Node.js + Fastify (owns the payment webhook/IPN)
- **Database**: PostgreSQL 16
- **Payment**: VNPay sandbox (`sandbox.vnpay.vn`)
- **Accounting**: double-entry ledger, every balance derived from the journal

---

## 1. Quick start

```bash
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:3100>.

The API container runs the migrations and the seed automatically, so the
database comes up with:

| Role | Name |
| --- | --- |
| buyer | Nguyen Lan (nguoi mua) |
| seller | Tran Minh (nguoi ban) |
| seller | Le Huy (nguoi ban) |
| admin | Ops Admin |

Two events, five listings across the two sellers.

Useful commands:

```bash
docker compose logs -f api      # API logs
docker compose exec api npm run db:reset -w @tce/api   # wipe and re-seed
npm test                        # unit tests (fees + ledger)
API_BASE_URL=http://localhost:3101 npm run e2e -w @tce/api   # end-to-end money flow
```

> The default host ports are **3100** (storefront), **3101** (API) and
> **55432** (Postgres) so the stack does not collide with a local PostgreSQL
> install. They are all configurable in `.env` (`WEB_PORT`, `API_PORT`,
> `DB_PORT`).

### Running without Docker

If you prefer to run the apps directly against a local PostgreSQL:

```bash
npm install
npm run build:shared

# terminal 1 - API
cd apps/api
DATABASE_URL=postgres://user@localhost:5432/tickets npm run db:init
DATABASE_URL=postgres://user@localhost:5432/tickets MOCK_GATEWAY=true PORT=3101 npm run dev

# terminal 2 - storefront
cd apps/web
API_BASE_URL=http://localhost:3101 npm run dev
```

`scripts/dev-local.sh` does both plus the migrations in one command.

---

## 2. Which payment gateway, and why

**VNPay sandbox.**

Reasons:

1. **Native VND.** The whole marketplace prices in VND. VNPay settles in VND,
   so there is no FX conversion and no rounding surprise on the gateway side.
   Stripe, for example, would charge in USD and force a conversion step
   *before* the fee split - which is exactly where money bugs hide.
2. **A real IPN contract.** VNPay posts an `IPN` notification with a SHA256
   signature and publishes a `vnp_ApiUrl` that the merchant can call back to
   confirm the transaction server-to-server. That means the app *verifies*
   the notification instead of trusting the browser redirect - which is what
   the brief asks for.
3. **A public sandbox.** `sandbox.vnpay.vn` accepts test cards without an
   onboarding call, so the flow can be demonstrated end to end.
4. **Domestic relevance.** The buyer journey (VNPay app, bank cards, QR) is
   the one the end users would actually take.

### Credentials

Sandbox credentials are **not** in this repository. Register at
<https://sandbox.vnpay.vn> and put them into your local `.env`:

```
VNPAY_MERCHANT_CODE=...
VNPAY_SECRET_KEY=...
MOCK_GATEWAY=false
```

Send the credentials to the reviewers separately, as requested.

### The mock gateway

Until you have credentials, the app runs with `MOCK_GATEWAY=true`: a small
local simulator that follows the same contract (redirect to a payment page,
then POST a correctly signed payload to the same IPN endpoint). It exists so
the repository can be cloned and run by anyone in one command.

**It is a development aid, not a payment gateway**, and it is listed under
"not production ready" below.

---

## 3. How gateway callbacks reach the app locally

The gateway calls the IPN endpoint from *its* servers, so `localhost` is not
reachable. A public tunnel is required.

### Option A - cloudflared (included in compose)

```bash
docker compose --profile tunnel up --build
```

The tunnel prints a URL like `https://random-words.trycloudflare.com`. Copy it
into `.env`:

```
PUBLIC_BASE_URL=https://random-words.trycloudflare.com
```

and restart the API (`docker compose up -d api`). That URL is what the app
sends to the gateway as `vnp_NotifyUrl`.

### Option B - ngrok

```bash
ngrok http 3101
export PUBLIC_BASE_URL=$(ngrok url 3101 | ...)
```

### Verifying locally

The IPN endpoint is:

```
POST {PUBLIC_BASE_URL}/api/ipn/vnpay
```

It answers with `{"RspCode":"00","RspStatus":"00"}` on success and
`{"RspCode":"02"}` on a rejected notification - the response body VNPay
expects. Rejections are logged by the API.

To exercise it without the real gateway, `apps/api/scripts/e2e.ts` signs a
payload exactly the way VNPay does and posts it three times, proving the
handler is idempotent.

### The demo walkthrough (5 minutes)

With `MOCK_GATEWAY=true` (the default) the whole flow runs locally:

1. Open <http://localhost:3100> - pick an event.
2. Choose a listing, set the quantity, press **Thanh toan**. The browser is
   redirected to the simulated gateway page.
3. Press **Thanh toan \<amount\> VND**. The page signs the payload and POSTs
   it to the app's own IPN endpoint, exactly like VNPay does, then sends you
   back to the order page.
4. The order page shows **Da thanh toan (escrow)** and the money split.
5. Switch the user (top right) to a seller and open **Vi cua toi**: the money
   is in *Cho giai ngan (escrow)*, not yet *Khai dung*.
6. Back on the event list press **Hoan tat su kien (giai ngan escrow)**.
7. The seller's wallet now shows the money under *Khai dung*, and the order
   is **Da giai ngan**.
8. Open **So cai** to see every journal entry and the derived balances, with
   a line that says the ledger is *can bang* (balanced).

---

## 4. The money model

### Fees

| | Amount |
| --- | --- |
| Listing price | `price_vnd` per ticket |
| Buyer pays | subtotal **+ 10%** service fee |
| Seller receives | subtotal **- 5%** fee |
| Platform keeps | the difference (15% of the subtotal) |

Worked example - 2 tickets at 1,000,000 VND:

```
subtotal        2,000,000
buyer fee (10%)   200,000   -> buyer pays   2,200,000
seller fee (5%)   100,000
seller net      1,900,000
platform fee      300,000
```

### Accounts (chart of accounts)

| Code | Kind | Meaning |
| --- | --- | --- |
| `asset:gateway_cash` | asset | money held at the payment gateway |
| `liability:user:{id}:pending` | liability | seller's money, still escrowed |
| `liability:user:{id}:available` | liability | seller's money, released |
| `revenue:platform_fee` | revenue | fees kept by the platform |

### The two postings

**1. Payment captured** (when a verified IPN arrives):

```
Dr  asset:gateway_cash                    2,200,000
    Cr  liability:user:{seller}:pending      1,900,000
    Cr  revenue:platform_fee                   300,000
```

**2. Escrow released** (when the event is marked completed):

```
Dr  liability:user:{seller}:pending       1,900,000
    Cr  liability:user:{seller}:available    1,900,000
```

Both are balanced, and both live in one database transaction, so a posting is
never partially applied.

### Balances are derived, never stored

There is no balance column anywhere in the schema. The UI reads:

```
pending   = SUM(credit) - SUM(debit)  over liability:user:{id}:pending
available = SUM(credit) - SUM(debit)  over liability:user:{id}:available
```

`GET /api/ledger/audit` re-checks that every transaction satisfies
`sum(debit) == sum(credit)`, and `GET /api/ledger/balances` returns the
derived balances. The `/ledger` page shows both side by side.

### Order lifecycle

```
PENDING_PAYMENT --(IPN, verified)--> PAID --(event completed)--> RELEASED
        |
        +--(IPN, failed)--> FAILED
```

- The **buyer's redirect back from the gateway never changes state.** The
  result page reads the persisted status and polls it. If the IPN has not
  arrived yet the order honestly shows "waiting for the gateway".
- The IPN handler is **idempotent**: the `payments` table has
  `UNIQUE (provider, provider_txn_id)`, and the order row is locked with
  `FOR UPDATE` before the posting, so a repeated or concurrent notification
  can never book the money twice.
- The IPN is rejected (no ledger write) if the signature does not match, if
  the amount differs from the order, or if the order is unknown.

---

## 5. Repository layout

```
docker-compose.yml          postgres + api + web (+ optional tunnel profile)
.env.example
packages/shared/            money helpers, fee model, zod schemas, unit tests
apps/api/
  src/db/                   schema.sql, migrate, seed, accounts
  src/services/ledger.ts    double-entry posting, balances, audit
  src/services/orders.ts    order lifecycle, IPN handling, escrow release
  src/payments/vnpay.ts     VNPay sandbox adapter (sign / verify)
  src/payments/mock.ts      local gateway simulator
  src/routes/               HTTP API + the mock payment page
  scripts/e2e.ts            end-to-end money-flow check
apps/web/
  src/app/page.tsx          event list
  src/app/events/[id]/      event page with listings (SSR)
  src/app/orders/[id]/      payment result page (SSR + status poller)
  src/app/wallet/           pending / available balances
  src/app/ledger/           the journal and all account balances
  src/app/actions.ts        server actions: checkout, switch user, complete event
```

---

## 6. Decisions I made where the brief was silent

1. **Stack split.** Next.js for the SSR storefront, a separate Fastify
   service for the API. The brief asks for "a server-rendered React framework
   *and* a Node.js backend", so they are two processes. The webhook lives in
   the backend, which is the component that must be reachable from the
   internet.
2. **Integer VND everywhere.** Amounts are `BIGINT` in the database and plain
   integers in code. No floats, no decimal type: VND has no circulating
   subunit, so a float would only introduce rounding drift into the fee
   split.
3. **Fee rounding.** The 10% and 5% are each computed on the subtotal and
   rounded half-up to whole VND independently. This guarantees
   `gross == sellerNet + platformFee` for every order, which is what keeps
   the ledger balanced. The platform absorbs the sub-VND remainder.
4. **Chart of accounts.** The platform fee is *revenue*, the gateway balance
   is an *asset*, and escrow is a *liability* of the platform towards the
   seller - split into `pending` and `available` so the escrow state is
   visible in the balance itself rather than in a separate flag.
5. **No balance columns.** A deliberate reading of "every balance must be
   derivable from the ledger": balances are always computed from
   `ledger_entries`.
6. **Escrow is per order, released per event.** Marking an event completed
   releases every paid order of that event, each with its own ledger
   transaction so the journal stays traceable back to the order.
7. **Quantity is reserved at checkout**, not at payment, and the listing row
   is locked `FOR UPDATE`. Otherwise two buyers could buy the same last
   ticket. A failed payment gives the quantity back.
8. **User switcher is a cookie** (`tce_uid`), as the brief allows. There is
   no authentication; anyone can switch to any user.
9. **The "complete event" button is on the event list**, not behind a login,
   because there is no auth in this task. In production it would be an
   internal operations tool.
10. **The buyer re-check is a poll**, not a guess: the result page shows the
    persisted status and re-reads it every few seconds.
11. **The mock gateway** exists so the repository runs with one command
    before anyone has VNPay credentials. It is clearly labelled and listed
    as not production ready.
12. **Vietnamese UI**, mobile-first layout (single column, 16px inputs so
    iOS does not zoom on focus, sticky header, `viewport` meta tag).

---

## 7. What is not production ready

Honest list:

- **No authentication or authorization.** The user switcher is open to
  anyone, and "complete event" is a public button. Production needs real
  sessions and a role check on every mutating endpoint.
- **The mock gateway** must be switched off; it accepts any payment.
- **IPN replay protection is partial.** The unique constraint makes the
  *effect* of a replay idempotent, but there is no timestamp/nonce window
  rejecting a stale notification, and no `vnp_ApiUrl` server-to-server
  confirmation (VNPay supports it - I would add it as a second verification
  step).
- **IPN secrets are not rotated**, and there is no rate limiting on the
  webhook.
- **No refunds.** The `REFUNDED` payment status exists in the schema but no
  flow produces it. A refund would need a reverse posting and a rule for
  who eats the gateway fee.
- **No real payouts.** Releasing escrow only moves money between the
  platform's own liability accounts. There is no bank transfer, no KYC, no
  payout batching, and no reconciliation with the gateway's settlement file.
- **Migrations are a single `schema.sql` executed with `IF NOT EXISTS`**,
  not a versioned migration tool (no down migrations, no drift detection).
- **Ledger entries are append-only by convention only** - there is no
  database-level trigger that forbids updating or deleting a posted entry,
  and no hash chain, so an operator with database access could rewrite
  history.
- **No audit log** for who did what (who completed an event, who switched
  user).
- **No observability**: no structured logging pipeline, no metrics, no
  alerting on IPN failures, no dead-letter queue for notifications that
  could not be applied.
- **No idempotency on the checkout endpoint itself** - a double-tapped
  "Pay" button creates two orders (the second one is a separate order with
  its own reservation).
- **Prices and quantities are trusted from the client** for the quantity
  only; the price is read from the database, but there is no per-user price
  or promotion engine.
- **No e2e test framework** (Playwright/Cypress). The e2e script covers the
  money flow, but the UI is only manually verified on a phone viewport.
- **The seed data is dev data** and the reset script is destructive.

### What I would do next, in order

1. Real auth (session + role) and lock the mutation endpoints.
2. Switch on the VNPay sandbox, add the `vnp_ApiUrl` confirmation call, and
   make the IPN handler the single source of truth for order state.
3. Versioned migrations (node-pg-migrate or Drizzle) + a `ledger_entries`
   immutability trigger + an append-only audit log.
4. Refund flow with a reverse posting, including who absorbs the gateway fee.
5. Payout batching with reconciliation against the gateway settlement report.
6. Idempotency keys on checkout and a reconciliation job that compares the
   ledger's `asset:gateway_cash` against the gateway's actual balance.
7. Playwright e2e on a phone viewport, and a CI pipeline running the unit
   tests plus the e2e money-flow check against a Postgres service container.
8. Move money to a numeric(20,0) or integer-with-`numeric` type if the
   marketplace ever supports currencies with subunits.

---

## 8. How I used AI, and how long it took

**Tooling.** Cursor (agent mode + plan mode) for the whole implementation:
scaffolding, the fee/ledger logic, the Fastify routes, the VNPay signing and
verification, the Next.js pages, the Docker setup, the tests and this README.
The fee model, the account chart and the idempotency strategy were designed
by me; AI accelerated writing and caught type errors.

**Time.** Roughly one working day of wall-clock time, most of it spent in
AI-assisted iteration. The parts that took the longest were getting the
double-entry postings to stay balanced inside nested transactions, and the
local callback story (the local machine had a PostgreSQL on 5432 and Docker
Desktop's disk was full, so ports had to be made configurable).

**What the AI got wrong along the way**, and how it was caught:

- It initially used `postgres.js`'s `Sql` type inside transaction callbacks,
  which does not typecheck (`TransactionSql` is a different interface). Fixed
  by introducing a `Db` union plus a `withTx` helper that opens a savepoint
  when it is already inside a transaction.
- The first IPN implementation could double-post under a concurrent replay;
  the `FOR UPDATE` lock and the unique constraint on
  `(provider, provider_txn_id)` were added to close it, and the e2e script
  now replays the same notification three times to prove it.

---

## 9. Test coverage

`npm test` runs the unit tests:

- `packages/shared/test/fees.test.ts` - the 10%/5% split, rounding, and the
  invariant `gross == sellerNet + platformFee` across a grid of amounts.

`npm run e2e -w @tce/api` runs the money flow against a live stack:

1. create an order through the checkout endpoint
2. assert the buyer is charged subtotal + 10%
3. post a correctly signed IPN -> the order becomes `PAID`
4. post the same IPN three more times -> the ledger is unchanged
5. assert the seller's money is in `pending`, not `available`
6. mark the event completed -> the money moves to `available`
7. assert the ledger is still balanced at every step
