# Ticket checkout with escrow

A thin slice of a ticket resale marketplace: sell a ticket, take the money
through a real payment gateway, and account for every cent with a
double-entry ledger.

- **Storefront**: Next.js 15 (App Router, server-rendered), mobile-first
- **Backend**: Node.js + Fastify (owns the payment webhook/IPN)
- **Database**: PostgreSQL 16
- **Payment**: VNPay sandbox (`sandbox.vnpayment.vn`)
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
| buyer | Nguyễn Lan (người mua) |
| buyer | Phạm Dung (người mua) |
| seller | Trần Minh (người bán) |
| seller | Lê Huy (người bán) |
| seller | Võ Chị (người bán) |
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
| `npm test` | unit tests + integration tests (needs a database) |
| `npm run test:unit` | unit tests only (no database) |
| `npm run test:api` | integration tests only (needs a database) |
| `npm run e2e` | end-to-end money flow (boots its own API) |
| `npm run verify` | typecheck + test + e2e + build, the same as CI |

> `npm run e2e` **starts the API itself**, applies the migrations, seeds the
> users, provisions a throwaway event and runs the whole money flow against
> it. It needs nothing but a reachable database, so a reviewer can clone the
> repo and run it with one command. It is repeatable: each run creates its
> own fixture and asserts *deltas*, so running it twice in a row passes both
> times.
>
> The run happens in a **private Postgres schema** that is dropped again
> afterwards, exactly like the integration tests do. So the demo data is
> never polluted by a test run - the storefront keeps showing only the
> seeded events, and the reviewer never has to reset the database by hand.
> (`E2E_EXTERNAL=1` runs against an already-running stack instead; that mode
> has no private schema to drop, so it deletes the rows it created at the
> end of the run.)
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
2. **A real IPN contract.** VNPay posts an `IPN` notification with an
   HMAC-SHA512 signature and publishes a `vnp_ApiUrl` that the merchant can
   call back to confirm the transaction server-to-server. That means the app
   *verifies* the notification instead of trusting the browser redirect -
   which is what the brief asks for.
3. **A public sandbox.** `sandbox.vnpayment.vn` accepts test cards without an
   onboarding call, so the flow can be demonstrated end to end.
4. **Domestic relevance.** The buyer journey (VNPay app, bank cards, QR) is
   the one the end users would actually take.

### The wire format, as the official samples define it

The details below were taken from the current VNPay documentation
(<https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html>) and
its PHP / Java / Python / C# samples. They are easy to get wrong, and
getting them wrong means the sandbox rejects the payment or the IPN never
verifies:

| Detail | Rule |
| --- | --- |
| `vnp_Amount` | the VND amount **multiplied by 100** (10,000 VND is sent as `1000000`). The IPN returns the same multiplied value, so it is divided by 100 before it is compared to the order. |
| `vnp_SecureHash` | `HMAC-SHA512(secretKey, hashData)`, lowercase hex, 128 characters. `hashData` is the alphabetically sorted (`ksort`) list of the non-empty parameters, URL-encoded, joined with `&`. The hash fields are excluded. |
| `vnp_CreateDate`, `vnp_ExpireDate` | `yyyyMMddHHmmss` in **GMT+7**. |
| `vnp_NotifyUrl` | where the gateway sends the server-to-server notification. **Not optional**: without it VNPay has no way to deliver the IPN, and the order stays `PENDING_PAYMENT` forever. |
| Success | `vnp_ResponseCode == '00'` **and** `vnp_TransactionStatus == '00'`. |
| The IPN request | a **GET** with the parameters in the query string. The reply is HTTP 200 with `{"RspCode":"00","Message":"..."}`. |
| RspCode | `00` success, `01` order not found, `02` already confirmed, `04` invalid amount, `97` invalid signature, `99` invalid request. |

The signing algorithm lives in **one** file
(`apps/api/src/payments/vnpay-crypto.ts`) and is shared by the real
provider, the local mock gateway and the e2e test. A second copy of the
algorithm would let the mock and the server drift apart and hide exactly
the bug this task is about.

The local mock gateway deliberately speaks the **same** wire format -
amount multiplied by 100, HMAC-SHA512, notification over GET - so the code
that talks to the real sandbox is the code that talks to the mock. A mock
with a different contract would hide bugs rather than expose them.

That is not a theoretical concern: `vnp_NotifyUrl` was missing from the
real provider while the mock had it, and because the mock takes the notify
address from a form attribute instead of the query string, the whole test
suite stayed green while the real gateway would never have known where to
deliver the IPN. `apps/api/test/provider.test.ts` now asserts that both
providers send the same parameter set, so a mock that is more forgiving
than the real thing cannot hide a gap again.

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

It answers with HTTP 200 and a JSON body, always - that is what makes the
gateway stop retrying:

| `RspCode` | When |
| --- | --- |
| `00` | the notification was applied (the money was booked) |
| `02` | already confirmed - the same notification arrived again |
| `01` | no order with that `vnp_TxnRef` |
| `04` | the amount on the notification is not the amount of the order |
| `97` | the signature does not match our secret key |
| `99` | the request has no transaction reference |

Every notification - including the rejected ones - is written to the
`payment_events` table, which is the reconciliation log an operator
compares against the gateway's own transaction list.

To exercise it without the real gateway, `apps/api/scripts/e2e.ts` signs a
payload exactly the way VNPay does and posts it three times, proving the
handler is idempotent: the money is booked once and the replays are
answered with `02`.

### The demo walkthrough (5 minutes)

With `MOCK_GATEWAY=true` (the default) the whole flow runs locally:

1. Open <http://localhost:3000> - pick an event.
2. Choose a listing, set the quantity, press **Thanh toán**. The browser is
   redirected to the simulated gateway page.
3. Press **Thanh toán \<amount\> VND**. The page signs the payload and sends
   it to the app's own IPN endpoint, exactly like VNPay does, then sends you
   back to the order page.
4. The order page shows **Đã thanh toán - tiền giữ trong escrow** and the
   money split.
5. Switch the user (top right) to a seller and open **Ví của tôi**: the money
   is in *Chờ giải ngân (escrow)*, not yet *Khả dụng*.
6. Switch to **Ops Admin** and press **Hoàn tất sự kiện** on the event list
   (or **Giải ngân escrow cho sự kiện này** on the dashboard). Only the admin
   role sees that button, and the server action checks the role too.
7. The seller's wallet now shows the money under *Khả dụng*, and the order
   is **Đã giải ngân**.
8. Open **Lịch sử giao dịch** to see every journal entry and the derived
   balances, with a line that says the ledger is *cân bằng* (balanced).

### Using the storefront

The storefront is a small demo with no real authentication. The dropdown in
the header - **Đổi người dùng** - switches the acting user, and everything
on the page is rendered for that user.

| Page | What it is for |
| --- | --- |
| **Sự kiện** (`/`) | The event list. Every card shows the venue, the start time, how many tickets are left and how many listings it has. The price model is explained at the bottom of the page. |
| **Sự kiện → một sự kiện** (`/events/<id>`) | The listings of one event. Each listing is a checkout form: pick a quantity, see the fee breakdown update live, press **Thanh toán**. |
| **Kết quả thanh toán** (`/orders/<id>`) | The order status, the money split and every IPN the gateway sent for this order. The page polls the API every 3 seconds while the order is still waiting for the gateway. |
| **Ví của tôi** (`/wallet`) | The acting user's wallet: money waiting for release (escrow), money available to withdraw, and the transaction history. |
| **Lịch sử giao dịch** (`/ledger`) | The platform-wide double-entry journal: the balance of every account and every posted entry. |
| **Quản trị** (`/admin`) | The operations dashboard. Only shown to the `admin` role. |

**Reading the money model.** The buyer pays the listing price plus a 10%
service fee; the seller receives the price minus 5%; the platform keeps the
15% difference. The two seller balances are the escrow split:

- **Chờ giải ngân** - the money is at the gateway but still owed to the
  seller. It only moves to *Khả dụng* when the event is completed.
- **Khả dụng** - released, ready to withdraw.

**Why the buyer is redirected to a gateway and nothing happens yet.** The
**Thanh toán** button only creates an order in `PENDING_PAYMENT` state and
redirects the browser. No money moves. The money moves when the gateway's
IPN arrives at `/api/ipn/vnpay` - the redirect in the browser is never
trusted, which is why the order page keeps polling instead of assuming the
payment went through.

**The 15-minute hold.** A created order reserves its tickets for 15 minutes.
If the buyer never pays, the order becomes **Hết thời gian giữ vé** and the
tickets go back to the listing. If the buyer pays *after* that window, the
order becomes **Cần hoàn tiền** - the money is booked as owed to the buyer,
not as seller escrow.

**Releasing the escrow.** Only the admin can do it, from the event list or
from the dashboard. Completing an event releases every escrowed seller
balance at once and cancels the orders that were never paid for. An event
that has been completed stops selling tickets: the checkout button is
disabled and reads **Đã kết thúc**.

**Reading the ledger.** Every money movement is one entry with two lines
(a debit and a credit). **Nợ** is the debit side and **Có** is the credit
side, and every entry balances: `Tổng Nợ = Tổng Có`. No balance is stored
anywhere - it is always derived from the journal, so the wallet, the
dashboard and the ledger can never disagree. Click an account code to expand
it, or press **Chép** to copy the full code.

**The mock gateway.** `MOCK_GATEWAY=true` (the default) mounts `/mock-pay`,
a fake VNPay page. It has two buttons: **Thanh toán** (succeeds) and **Thanh
toán thất bại (mô phỏng)** (declines). Both sign the payload with the same
HMAC-SHA512 routine the real gateway uses, so the IPN that arrives at our
own endpoint is indistinguishable from a real one. Use the failing button to
see the tickets return to the listing.

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
PENDING_PAYMENT --(IPN, verified, in time)--> PAID --(event completed)--> RELEASED
        |
        +--(IPN, failed)--> FAILED
        +--(reservation expired)--> EXPIRED
        +--(event completed before payment)--> CANCELLED
        +--(IPN, verified, but too late)--> REFUND_REQUIRED
```

- **Every successful payment books the money.** If the order can still be
  fulfilled it is a normal capture; if it cannot (it was declined, expired,
  or the event was completed), the amount is booked as
  `liability:refund_payable` - money owed back to the buyer - and the
  reserved ticket is returned to the listing. A notification is never
  accepted and then dropped on the floor.

- The **buyer's redirect back from the gateway never changes state.** The
  result page reads the persisted status and polls it. If the IPN has not
  arrived yet the order honestly shows "waiting for the gateway".
- The IPN handler is **idempotent**: the `payments` table has
  `UNIQUE (provider, provider_txn_id)`, and the order row is locked with
  `FOR UPDATE` before the posting, so a repeated or concurrent notification
  can never book the money twice.
- The IPN is rejected (no ledger write) if the signature does not match, if
  the amount differs from the order, or if the order is unknown. The
  rejection codes follow the official list: `97` invalid signature, `01`
  order not found, `04` invalid amount, `99` invalid request.
- A **replayed** notification (the same `provider_txn_id` arriving again)
  is answered with `02` "already confirmed". The money was booked on the
  first delivery; the replay changes nothing.
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

### Ticket reservation and the late payment

A checkout reserves the tickets for **15 minutes** (`orders.expires_at`).
When that passes, the buyer abandoned the checkout and the tickets must go
back to the listing - otherwise one abandoned checkout permanently removes
tickets from the market.

The expiry is a **lazy sweep**: there is no cron, the sweep runs whenever
the app touches the orders (event list, event page, new checkout, event
completion). A lazy sweep is enough at this scale and it removes a whole
class of "the background job silently died" bugs. A cron is listed under
[not production ready](#7-what-is-not-production-ready).

The hard case is a payment that arrives **after** the reservation expired.
The buyer paid, but the tickets were already sold to somebody else, so:

- the seller must **not** receive the money (the buyer has no ticket),
- but the buyer did pay, so the amount is booked as
  `Dr asset:gateway_cash / Cr liability:refund_payable`,
- and the order becomes `REFUND_REQUIRED`.

The refund itself (calling VNPay's refund API) is out of scope for this
test task, so the money stays in `liability:refund_payable` until an
operator refunds it. The admin dashboard shows that figure.

There is a subtle case here that the e2e test covers explicitly: the lazy
sweep may have already marked the order `EXPIRED` before the IPN arrives.
The IPN handler therefore treats `EXPIRED` exactly like an expired
`PENDING_PAYMENT` - it must still settle the money, never silently drop
it.

---

## 5. Repository layout

```
docker-compose.yml          postgres + api + web (+ optional tunnel profile)
.env.example
packages/shared/            money helpers, fee model, zod schemas, unit tests
  src/money.ts             integer VND arithmetic (no floats anywhere)
  src/fees.ts              the 10% / 5% split and the rounding rule
  src/account-code.ts      shortening an account code for display
  src/ledger-labels.ts     the Vietnamese headline of a journal entry
  src/schemas.ts           the zod schemas shared by the API and the web
apps/api/
  src/db/                   schema.sql, migrate, seed, accounts, isolated
  src/db/legacy-text.ts     repairs names written without Vietnamese diacritics
  src/services/ledger.ts    double-entry posting, balances, audit
  src/services/orders.ts    order lifecycle, IPN handling, escrow release
  src/services/admin.ts     the operations dashboard aggregates
  src/payments/vnpay-crypto.ts  the VNPay signing algorithm (one shared copy)
  src/payments/vnpay.ts     VNPay sandbox adapter (sign / verify)
  src/payments/mock.ts      local gateway simulator
  src/routes/               HTTP API + the mock payment page
  scripts/e2e-run.ts       boots the API and runs the e2e check in one command
  scripts/e2e.ts           the money-flow assertions themselves
  test/                    unit + integration tests (a private schema each)
    helpers/db.ts          creates the throwaway schema, points the app at it
    helpers/fixtures.ts    the rows a test needs (users, events, listings)
    ledger.test.ts         the signature algorithm and the posting guardrails
    provider.test.ts       the redirect request sent to the gateway
    orders.test.ts         the checkout rules
    ipn.test.ts            the gateway notification
    http.test.ts           the HTTP surface and the response codes
    invariants.test.ts     the money invariants
    legacy-text.test.ts    the repair of the unaccented names
apps/web/
  src/app/page.tsx          event list
  src/app/events/[id]/      event page with listings (SSR)
  src/app/orders/[id]/      payment result page (SSR + status poller)
  src/app/wallet/           pending / available balances
  src/app/ledger/           the journal and all account balances
  src/app/admin/            the operations dashboard (admin only)
  src/app/actions.ts        server actions: checkout, switch user, complete event
  src/components/           ListingCheckoutForm, AccountCode, the shared UI
scripts/
  dev.sh                    starts the stack, freeing the ports it needs first
  dev-local.sh              runs the apps on the host against the compose db
  push-to-github.sh         creates the remote (if needed) and pushes
.github/workflows/ci.yml   typecheck + unit + integration + e2e on every push
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
    The run itself happens in a **private Postgres schema** that is dropped
    again afterwards. That was not the first design: the e2e script used to
    write straight into the developer's database and never cleaned up, so
    every run left an `E2E event ...` behind and the storefront slowly
    filled up with events nobody had booked. The integration tests already
    used a private schema; the e2e runner now does the same, through the
    shared `src/db/isolated.ts` helper.
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
21. **The ticket reservation lasts 15 minutes** and is released lazily
    (no cron). An abandoned checkout would otherwise remove tickets from the
    market forever.
22. **A payment that arrives after the reservation expires is
    `REFUND_REQUIRED`, not `PAID`.** The buyer paid, so the money has to be
    accounted for - but the tickets are gone, so the seller must not get it.
    It is booked as `liability:refund_payable` until an operator refunds
    it. Dropping the notification would lose the buyer's money; paying the
    seller would be worse.
23. **A seller cannot buy their own listing** (`409 OWN_LISTING`). The money
    would move from the seller to the seller, the platform fee would be
    invented, and the escrow would be nonsense.
24. **Every raw gateway notification is logged** in `payment_events`,
    including the ones we reject. It is the reconciliation log: an operator
    compares it against the gateway's own transaction list to find
    notifications that never arrived. The `payments` table only holds the
    notifications that were applied.
25. **The admin role gets an operations dashboard** (`/admin`): the money
    currently held in escrow, the orders stuck waiting for a gateway, the
    events waiting for a release, the escrow per seller, all orders, and the
    raw IPN log. Every number is derived from the ledger, and the e2e test
    asserts that the dashboard agrees with the journal - the dashboard can
    never become a second source of truth.

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
  who eats the gateway fee. The late-payment path books the liability
  (`liability:refund_payable`) but an operator still has to call the
  gateway's refund API and post the reversing entry by hand.
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
  could not be applied. The `payment_events` table is the first building
  block for the dead-letter queue, but nothing consumes it yet.
- **The reservation expiry is a lazy sweep, not a cron.** It runs when the
  app touches the orders. With no traffic, an abandoned reservation stays
  "reserved" in the database until the next request - harmless here, but a
  real deployment needs a scheduled job.
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
- A later pass compared the implementation against the **current** VNPay
  documentation and found three real bugs that would have made the sandbox
  integration fail on the first try:
  - `vnp_Amount` was sent as the raw VND amount. The gateway expects it
    **multiplied by 100**, so a 2,640,000 VND order was sent as `2640000`
    instead of `264000000` - a 100x underpayment, or a rejection.
  - the signature used `sha256(secret + query + secret)`. The real algorithm
    is `HMAC-SHA512(secret, hashData)` over the sorted, URL-encoded
    parameters - so **every** IPN would have been rejected as an invalid
    signature.
  - the IPN endpoint only accepted `POST`, but VNPay notifies with a `GET`.
  Fixed against the official PHP / Java / Python / C# samples. The signing
  algorithm was then moved into a single shared module used by the real
  provider, the mock gateway and the test - having a second copy in the
  mock is exactly how the two would have drifted apart and hidden the bug.
- The lazy expiry sweep introduced its own bug, which the new e2e assertion
  caught immediately: the sweep marked an abandoned order `EXPIRED`, and the
  IPN handler only looked at `PENDING_PAYMENT`, so a payment that arrived
  after the sweep was **silently dropped** - the buyer's money would have
  disappeared. Fixed by treating `EXPIRED` as a late payment that still has
  to be settled as `REFUND_REQUIRED`.
- A final audit of the IPN handler against every order status found **three
  more money bugs**, all of the same shape: a *successful* notification that
  arrived for an order that could no longer be fulfilled was accepted
  (`RspCode 00`) but **nothing was posted to the ledger** - the buyer's
  money simply disappeared. The gateway cash did not grow and no liability
  towards the buyer was created.
  - **Decline, then a successful retry.** The buyer declined at the gateway
    (the order became `FAILED` and the ticket went back to the listing) and
    then paid successfully on a retry. The retry was accepted and the money
    was dropped.
  - **Payment after the event was completed.** The order had become
    `CANCELLED`, the notification arrived afterwards, and the money was
    dropped.
  - **A late payment that leaked a ticket.** When a payment arrived after
    the reservation window but *before* the lazy sweep had run, the order
    became `REFUND_REQUIRED` and the money was booked correctly - but the
    reserved ticket was never given back. The sweep only ever touches
    `PENDING_PAYMENT` orders, so a `REFUND_REQUIRED` order would hold its
    ticket forever: the stock leaked away with every late payment.

  All three are fixed: a successful payment now always books the money. If
  the order can still be fulfilled it is a normal capture; if it cannot, the
  amount is booked as `liability:refund_payable` (money owed back to the
  buyer), and the reserved ticket is returned to the listing. The amount is
  now also checked on *every* notification, not only on the success path.
  The e2e script asserts each of the three cases.
- Writing the integration tests (section 9) found **two more**:
  - **A second payment for an order that was already paid.** The first fix
    above deliberately excluded `PAID` / `RELEASED` / `REFUND_REQUIRED` from
    the refund branch, on the reasoning that "their money was already
    booked". That reasoning is wrong for a *second* payment: the buyer
    handed over real money that the order does not account for, and it
    was simply dropped. The buyer paid twice and the second payment
    vanished. The rule is now: a notification that is *new* and cannot be
    fulfilled always books the amount as owed to the buyer.
  - **A ticket cheap enough that the platform fee rounds to zero.** 5% of a
    9-dong subtotal is 0, and the journal rejects a zero-amount line
    (`CHECK (amount_vnd > 0)`). The whole capture therefore threw, so the
    buyer was charged for a ticket that was never booked - a payment that
    failed outright on a cheap listing. A zero-amount line is now left out
    of the posting instead of failing it.
- A review of the whole flow against the brief found **one bug that the
  test suite could not see**: `VnPayProvider.createPayment` never sent
  `vnp_NotifyUrl`. The parameter was passed in and then dropped, so the
  real gateway would never have known where to deliver the IPN - the
  payment page would load, the buyer would pay, and the order would sit
  in `PENDING_PAYMENT` forever. The whole suite was green, because the
  *mock* gateway takes the notify address from a form attribute rather
  than from the query string, so it did not need the parameter at all.
  The mock was more forgiving than the real thing, which is exactly the
  failure mode a mock is supposed to prevent. Fixed, and
  `apps/api/test/provider.test.ts` now asserts that both providers send
  the same parameter set - so a mock that drifts ahead of reality can no
  longer hide a gap.

---

## 9. Test coverage

There are three layers, and each one covers what the others cannot.

### Unit tests (no database)

`npm run test:unit`:

- `packages/shared/test/fees.test.ts` - the 10%/5% split, rounding, and the
  invariant `gross == sellerNet + platformFee` across a grid of amounts
  (including a wide sweep of odd prices and quantities).
- `packages/shared/test/ledger-labels.test.ts` - the Vietnamese headline of a
  journal entry, derived from the entry *type* rather than from the memo
  that was stored with it (a memo can never be rewritten).
- `packages/shared/test/account-code.test.ts` - the shortening of an account
  code for display: the UUID is cut to its first eight characters, the
  meaningful parts are kept, and shortening twice changes nothing.
- `apps/api/test/ledger.test.ts` - the VNPay signature algorithm (a tampered
  payload must be rejected) and the guardrails of `postTransaction` (an
  unbalanced or single-line posting must throw).

### Integration tests (a real database)

`npm run test:api` - 68 tests that run against a real Postgres, in a
**private schema per test file** that is dropped afterwards. The
developer's own database is never touched, and the tests can be run as
often as you like.

Each test file gets its own schema (`tce_<name>_<random>`) and points the
`search_path` at it, so the application code runs unmodified against a
database of its own. That is why the HTTP tests can boot the real server
and still be safe.

| File | What it covers |
|---|---|
| `test/orders.test.ts` | the checkout rules: an invalid quantity, an unknown listing, a seller buying their own ticket, a completed event, not enough tickets left, the `Idempotency-Key` (same order, and scoped per buyer), two buyers racing for the last ticket, eight buyers racing for three tickets, and the expiry sweep |
| `test/ipn.test.ts` | the gateway notification: a normal capture, the same notification twice, a declined payment, a wrong amount, a late payment, and a second payment for an order that was already paid, released or refunded |
| `test/http.test.ts` | the HTTP surface: every rejection code (`400`, `404`, `409`), the IPN response codes (`01`, `02`, `04`, `97`, `99`), the escrow release, the cancellation of unpaid orders, the reconciliation log, and the append-only guarantee |
| `test/invariants.test.ts` | the money invariants over a wide grid of prices and quantities, and a long run of buy-pay-release cycles that must end perfectly solvent |
| `test/legacy-text.test.ts` | the repair of names and account labels that an older version wrote without Vietnamese diacritics |

Two of these tests found real bugs while they were being written (see
section 8).

### Provider tests (no database)

`apps/api/test/provider.test.ts` - the redirect request that is sent to the
gateway. It asserts that `vnp_NotifyUrl` (the IPN callback address) is
present, that the amount is multiplied by 100, that the request is signed,
and that the real provider and the local mock send the **same** parameter
set. That last assertion is the important one: the mock used to be more
forgiving than the real gateway, which is how a missing `vnp_NotifyUrl`
survived a fully green test suite.

### End-to-end (the real HTTP flow)

`npm run e2e -w @tce/api` runs the money flow. It boots the API itself and
provisions a throwaway event, so it needs nothing but a database, and it can
be run as often as you like:

1. create an order through the checkout endpoint
2. assert the buyer is charged subtotal + 10%
3. replay the checkout with the same `Idempotency-Key` -> the same order
4. post a correctly signed IPN -> the order becomes `PAID`
5. post the same IPN three more times -> the ledger booked the money exactly
   once (asserted by counting the `PAYMENT_CAPTURE` transactions) and the
   replays are answered with `RspCode 02` ("already confirmed")
6. assert the seller's money is in `pending`, not `available`
7. assert the platform kept 10% + 5% and the gateway holds the gross
8. mark the event completed -> the money moves to `available`
9. assert the ledger is still balanced at every step
10. assert a posted ledger entry cannot be updated or deleted (DB trigger)
11. assert checkout for the now-completed event is rejected with `409`
12. post a signed IPN that reports a *declined* payment -> the order becomes
    `FAILED` and the reserved ticket is returned to the listing
13. a seller cannot buy their own listing -> `409`
14. the lazy sweep expires an abandoned reservation -> the order becomes
    `EXPIRED` and the ticket goes back to the listing
15. an IPN that arrives *after* the sweep -> the order becomes
    `REFUND_REQUIRED`, the money is booked as `liability:refund_payable`
    (not as seller escrow), and the ledger stays balanced
16. a decline followed by a **successful retry** -> the money is booked as
    `liability:refund_payable` (it must not disappear)
17. a late payment that arrives *before* the sweep -> the order becomes
    `REFUND_REQUIRED` **and the reserved ticket goes back to the listing**
18. a payment for an order that was cancelled by the event completion ->
    the money is booked as `liability:refund_payable`
19. a **second** payment for an order that was already paid -> the money
    reaches the gateway cash and is booked as `liability:refund_payable`
    (the seller must not be paid twice)
20. the admin dashboard agrees with the journal, number for number
21. every raw notification is logged in `payment_events`, including a
    rejected one (bad signature -> `RspCode 97`, and it is still logged)

---

## 10. Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. install the dependencies
2. build the shared package
3. typecheck the API and the web app
4. run the unit and integration tests
5. run the end-to-end money flow
6. build everything
7. assert the journal is still balanced at the end of the run

It uses a Postgres service container, so the integration tests really run -
in CI a missing database is a hard error, not a skip. A silently skipped
suite is worse than a red build.

`npm run verify` runs the same steps locally.
