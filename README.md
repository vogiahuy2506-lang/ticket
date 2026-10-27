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
./scripts/dev.sh
```

Then open <http://localhost:3000>.

> `scripts/dev.sh` is `docker compose up --build` plus one thing: it stops
> any container that is still holding one of the ports first. A previous
> clone of this repo keeps running after you close the terminal, and the
> next `docker compose up` would fail with
> `port is already allocated`. Plain `docker compose up --build` works fine
> too, once nothing else is holding the ports.

> Copy the commands one line at a time. A trailing `# comment` on the same
> line would be passed to the command as an argument (`docker compose` would
> answer `no such service: #`).

The API container runs the migrations and the seed automatically, so the
database comes up with:

| Role | Name |
| --- | --- |
| buyer | Nguyen Lan (nguoi mua) |
| seller | Tran Minh (nguoi ban) |
| seller | Le Huy (nguoi ban) |
| admin | Ops Admin |

Two events, six listings across the two sellers (one of them deliberately
priced at an odd amount - 333,333 VND - so the fee rounding is visible).

Useful commands:

```bash
docker compose logs -f api
docker compose exec api npm run db:reset -w @tce/api
npm test
npm run e2e
```

| Command | What it does |
| --- | --- |
| `docker compose logs -f api` | tail the API logs |
| `docker compose exec api npm run db:reset -w @tce/api` | wipe and re-seed the database |
| `npm test` | unit tests (fees + ledger) |
| `npm run e2e` | end-to-end money flow (boots its own API) |

> `npm run e2e` **starts the API itself**, applies the migrations, seeds the
> users, provisions a throwaway event and runs the whole money flow against
> it. It needs nothing but a reachable database, so a reviewer can clone the
> repo and run it with one command. It is repeatable: each run creates its
> own fixture and asserts *deltas*, so running it twice in a row passes both
> times.
>
> On a fresh clone, start only the database first:
>
> ```bash
> docker compose up -d db
> npm install
> npm run e2e
> ```
>
> Inside Docker, run it against the compose database:
>
> ```bash
> docker compose exec api npm run e2e
> ```

> The default host ports are **3000** (storefront), **3101** (API) and
> **55432** (Postgres) so the stack does not collide with a local PostgreSQL
> install. They are all configurable in `.env` (`WEB_PORT`, `API_PORT`,
> `DB_PORT`).
>
> A single `.env` drives both the Docker stack and a host-run process. The
> only difference is which hostnames are used: inside compose the API
> reaches the database as `db` and the storefront reaches the API as
> `api`, while on the host both use `localhost`. `docker-compose.yml`
> hard-codes the container-side values so the two can never get mixed up.

### Troubleshooting

**`Bind for 0.0.0.0:55432 failed: port is already allocated`**

Something else on your machine already uses that port - most often a
*previous* clone of this repo that is still running. Docker keeps the
container alive even after the terminal is closed, so the ports stay taken:

```bash
docker ps --format "{{.Names}}\t{{.Ports}}"
docker compose down
```

If the leftover stack belongs to a different clone (a different directory,
therefore a different Compose project name), stop it by container name:

```bash
docker rm -f <project>-db-1 <project>-api-1 <project>-web-1
```

Or simply move your copy to a free port - edit `DB_PORT`, `API_PORT` and
`WEB_PORT` in `.env`. Remember to change `DATABASE_URL`, `PUBLIC_BASE_URL`,
`API_BASE_URL` and `WEB_BASE_URL` to match, because those carry the port
numbers too.

**`npm run e2e` fails with `getaddrinfo ENOTFOUND db`**

`DATABASE_URL` still points at the Docker service name `db`. That hostname
only resolves inside the Compose network. On the host it must be
`localhost:<DB_PORT>`, which is what `.env.example` now contains.

**`docker compose up` says `no such service: #`**

A `#` comment was pasted onto the end of a `docker compose` line. Compose
is not a shell - it reads the `#` as a service name. Keep the comment on
its own line.

### Running without Docker

The apps can run directly on the host while Postgres stays in Docker. Start
only the database, then run the apps from the repo root:

```bash
docker compose up -d db
npm install
npm run build:shared
npm run db:init
npm run dev
```

The storefront comes up on <http://localhost:3000> and the API on
<http://localhost:3101>.

> `.env` (copied from `.env.example`) points `DATABASE_URL` at
> `localhost:55432`, which is the **host port** of the compose database. That
> is the right value for processes running on the host. Inside the compose
> network the API uses the `db` service name instead - `docker-compose.yml`
> sets that explicitly, so the two never get mixed up.
>
> `.env.local`, if you create one, overrides `.env`. Real environment
> variables always win over both files.

If you prefer to run against a local PostgreSQL instead of the compose one:

```bash
npm install
npm run build:shared
```

```bash
# terminal 1 - API
cd apps/api
DATABASE_URL=postgres://user@localhost:5432/tickets npm run db:init
DATABASE_URL=postgres://user@localhost:5432/tickets MOCK_GATEWAY=true PORT=3101 npm run dev
```

```bash
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

1. Open <http://localhost:3000> - pick an event.
2. Choose a listing, set the quantity, press **Thanh toan**. The browser is
   redirected to the simulated gateway page.
3. Press **Thanh toan \<amount\> VND**. The page signs the payload and POSTs
   it to the app's own IPN endpoint, exactly like VNPay does, then sends you
   back to the order page.
4. The order page shows **Da thanh toan (escrow)** and the money split.
5. Switch the user (top right) to a seller and open **Vi cua toi**: the money
   is in *Cho giai ngan (escrow)*, not yet *Khai dung*.
6. Switch to **Ops Admin** and press **Hoan tat su kien (giai ngan escrow)**
   on the event list. Only the admin role sees that button, and the server
   action checks the role too.
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

### The journal is append-only at the database level

A posted ledger entry can never be edited or deleted. This is **not** just a
convention - a Postgres trigger rejects `UPDATE` and `DELETE` on
`ledger_entries`, `ledger_transactions` and `payments`:

```sql
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
```

The only way to correct a mistake is to post a *reversing* transaction, so
the history stays auditable. `GET /api/ledger/integrity` proves it by
attempting the mutation inside a rolled-back transaction and reporting
whether the database refused it.

### Order lifecycle

```
PENDING_PAYMENT --(IPN, verified)--> PAID --(event completed)--> RELEASED
        |
        +--(IPN, failed)--> FAILED
        +--(event completed before payment)--> CANCELLED
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
- A *valid* notification that reports a **declined** payment is **applied**,
  not dropped: the order becomes `FAILED` and the reserved tickets go back to
  the listing. Only an invalid signature means "not trustworthy"; a declined
  payment is a legitimate outcome that has to be settled.
- **Checkout is idempotent too**: the client sends an `Idempotency-Key`
  (`UNIQUE (buyer_id, idempotency_key)`), so a double-tapped "Pay" button
  returns the original order instead of reserving a second batch of tickets.
- **A completed event sells no more.** Checkout for an event that has
  already been marked completed is rejected with `409`, because such an
  order could never be released from escrow - the money would be trapped
  with no way out.
- When an event is completed, any order still in `PENDING_PAYMENT` is
  cancelled and its reserved tickets are returned to the listing.

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
  scripts/e2e-run.ts       boots the API and runs the e2e check in one command
  scripts/e2e.ts           the money-flow assertions themselves
apps/web/
  src/app/page.tsx          event list
  src/app/events/[id]/      event page with listings (SSR)
  src/app/orders/[id]/      payment result page (SSR + status poller)
  src/app/wallet/           pending / available balances
  src/app/ledger/           the journal and all account balances
  src/app/actions.ts        server actions: checkout, switch user, complete event
scripts/
  dev.sh                    starts the stack, freeing the ports it needs first
  dev-local.sh              runs the apps on the host against the compose db
  push-to-github.sh         creates the remote (if needed) and pushes
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
13. **Roles exist in the data model, but there is no authentication.** The
    brief says "No authentication needed for this test task", so there is no
    login. The `users.role` column (`buyer` / `seller` / `admin`) still
    drives the domain logic, and the operator-only action ("complete event"
    = release escrow) is gated on `admin` both in the UI *and* in the server
    action - hiding a button is not enough, because a Next.js server action
    is an HTTP endpoint. This is presentation-level authorization only:
    anyone can pick "Ops Admin" in the dropdown. Adding a real session later
    means replacing the source of `getCurrentUser()`, nothing else.
14. **Anyone can buy, not only the `buyer` role.** In a real marketplace a
    seller is very often a buyer too. Forcing one role per user would need
    a many-to-many role table, which the brief does not ask for.
15. **The ledger is append-only at the database level**, enforced by a
    trigger rather than by convention. Corrections go through a reversing
    transaction, so the audit trail is preserved.
16. **Checkout takes an `Idempotency-Key`**, and a completed event rejects
    new checkouts. Both are about not trapping money: the first prevents a
    double-tap from creating two orders, the second prevents an order that
    could never be released from escrow.
17. **The e2e test provisions its own fixture** and asserts *deltas* rather
    than absolute balances. It can therefore run repeatedly against the same
    database without a reset, which is what a reviewer will actually do.
18. **One `.env` drives both Docker and a host-run process.** The values in
    it are always *host* values (`localhost`). The container-side values
    (`db`, `api`) are hard-coded in `docker-compose.yml` instead of being
    interpolated from `.env`, because the same variable cannot mean both
    things at once. This was a bug I hit myself: an earlier `.env` pointed
    `DATABASE_URL` at `db`, so `npm run e2e` on the host failed with
    `getaddrinfo ENOTFOUND db`.
19. **`npm run e2e` migrates and seeds first.** A fresh clone has an empty
    database, so the runner applies the schema and the seed (both
    idempotent) before provisioning its fixture. The reviewer needs exactly
    one command, not three.
20. **A role check lives in the server action, not only in the UI.** The
    "complete event" button is hidden for non-admins, and the server action
    re-checks the role. A Next.js server action is an HTTP endpoint, so
    hiding the button is not authorization.

---

## 7. What is not production ready

Honest list:

- **No authentication or authorization.** The user switcher is open to
  anyone, and the API endpoint behind "complete event" is not protected -
  the *web* layer checks the admin role, but anyone who can reach the API
  can call it. Production needs real sessions and a role check on every
  mutating endpoint.
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
- **The ledger is append-only, but not tamper-evident.** The trigger stops
  `UPDATE`/`DELETE`, but there is no hash chain, so an operator with direct
  database access could still rewrite history by dropping the trigger.
- **No audit log** for who did what (who completed an event, who switched
  user).
- **No observability**: no structured logging pipeline, no metrics, no
  alerting on IPN failures, no dead-letter queue for notifications that
  could not be applied.
- **Prices and quantities are trusted from the client** for the quantity
  only; the price is read from the database, but there is no per-user price
  or promotion engine.
- **No e2e test framework** (Playwright/Cypress). The e2e script covers the
  money flow, but the UI is only manually verified on a phone viewport.
- **The seed data is dev data** and the reset script is destructive.
- **The escrow release is not a real settlement.** Releasing an event moves
  money between two liability accounts; there is no bank transfer, no KYC
  and no reconciliation against the gateway's settlement report.

### Pushing it to GitHub

The repository ships a helper that creates the remote (if needed) and pushes:

```bash
./scripts/push-to-github.sh
```

It defaults to `vogiahuy2506-lang/ticket`; override with
`REMOTE_REPO=owner/name ./scripts/push-to-github.sh`.

### What I would do next, in order

1. Real auth (session + role) and lock the mutation endpoints, including
   the API ones - right now the role check only exists in the web layer.
2. Switch on the VNPay sandbox, add the `vnp_ApiUrl` confirmation call, and
   make the IPN handler the single source of truth for order state.
3. Versioned migrations (node-pg-migrate or Drizzle) + an append-only audit
   log + a hash chain over the journal.
4. Refund flow with a reverse posting, including who absorbs the gateway fee.
5. Payout batching with reconciliation against the gateway settlement report.
6. A reconciliation job that compares the ledger's `asset:gateway_cash`
   against the gateway's actual balance.
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
- The first version of the ledger-immutability check ran `ROLLBACK` as a
  statement inside the transaction callback. `postgres.js` does not support
  that, and the check silently passed for the wrong reason. Fixed by forcing
  a rollback with a thrown sentinel error and comparing the error message
  against the trigger's own error - so the test now actually distinguishes
  "the database refused it" from "we rolled it back ourselves".
- The e2e script originally picked the first `scheduled` event and asserted
  *absolute* balances. After running it twice it failed, because the first
  run had completed the event and the balances had moved. This was a real
  bug in the test, not in the app, and it is the kind of thing a reviewer
  hits immediately. Fixed by having the runner provision its own fixture
  and by asserting deltas instead of absolute values.
- The same test run surfaced a real product bug: buying a ticket for an
  event that had already been completed created an order whose money could
  never be released from escrow. Fixed by rejecting that checkout with a
  `409`, and by cancelling any still-pending order when an event is
  completed.
- A later manual pass through the UI found another real product bug: a
  **declined** payment was treated as an untrustworthy notification and
  dropped before it reached the order service. The order stayed
  `PENDING_PAYMENT` forever and the tickets it had reserved were never
  returned to the listing - so every declined payment silently leaked stock.
  The root cause was using "the payment did not succeed" as a synonym for
  "this notification is not trustworthy". Fixed by splitting the two in
  `VerifyResult`: `signatureValid` decides whether the notification can be
  applied, `ok` only says whether the payment succeeded. A declined payment
  is now applied (order `FAILED`, ticket returned); only a bad signature is
  dropped. The e2e script asserts this path.

---

## 9. Test coverage

`npm test` runs the unit tests:

- `packages/shared/test/fees.test.ts` - the 10%/5% split, rounding, and the
  invariant `gross == sellerNet + platformFee` across a grid of amounts
  (including a wide sweep of odd prices and quantities).
- `apps/api/test/ledger.test.ts` - the VNPay signature algorithm (a tampered
  payload must be rejected) and the guardrails of `postTransaction` (an
  unbalanced or single-line posting must throw).

`npm run e2e -w @tce/api` runs the money flow. It boots the API itself and
provisions a throwaway event, so it needs nothing but a database, and it can
be run as often as you like:

1. create an order through the checkout endpoint
2. assert the buyer is charged subtotal + 10%
3. replay the checkout with the same `Idempotency-Key` -> the same order
4. post a correctly signed IPN -> the order becomes `PAID`
5. post the same IPN three more times -> the ledger booked the money exactly
   once (asserted by counting the `PAYMENT_CAPTURE` transactions)
6. assert the seller's money is in `pending`, not `available`
7. assert the platform kept 10% + 5% and the gateway holds the gross
8. mark the event completed -> the money moves to `available`
9. assert the ledger is still balanced at every step
10. assert a posted ledger entry cannot be updated or deleted (DB trigger)
11. assert checkout for the now-completed event is rejected with `409`
12. post a signed IPN that reports a *declined* payment -> the order becomes
    `FAILED` and the reserved ticket is returned to the listing
