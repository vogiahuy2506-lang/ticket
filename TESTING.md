# Kế hoạch test - ticket checkout with escrow

Hướng dẫn này bám sát từng câu trong đề bài, theo thứ tự giám khảo đọc.
Mỗi bước đều ghi rõ **làm gì** và **thấy gì** để biết là đúng.

---

## 0. Chuẩn bị (5 phút)

```bash
git clone https://github.com/vogiahuy2506-lang/ticket.git && cd ticket
cp .env.example .env
./scripts/dev.sh
```

> `<repo>` trong bản cũ của tài liệu này là **placeholder**, không phải URL
> thật - dán nguyên `<repo>` vào terminal sẽ ra `zsh: parse error near '&&'`
> vì zsh hiểu `<` là toán tử redirection. Dùng URL thật ở trên.

Mở <http://localhost:3000>.

Kiểm tra app đã sống:

```bash
curl http://localhost:3101/health
# {"status":"ok","db":true,"provider":"mock"}
```

Trang mở đầu phải hiện **2 sự kiện**:

| Sự kiện | Số nhóm vé | Vé còn lại |
| --- | --- | --- |
| Đại nhạc Sơn Trà - Đêm Mưa | 4 | 18 |
| Hội thảo Kỷ nam 2026 | 2 | 7 |

> `dev.sh` tự giải quyết xung đột cổng 3000/3101 (dừng container cũ **và** process `npm run dev` còn sót trên host). Nếu từng chạy `npm run dev` thì phải dừng nó trước khi chạy `dev.sh`.

### 0.1 Đưa dữ liệu về trạng thái sạch (làm trước khi demo)

Kho vé có sẵn là **hữu hạn**, và sau mỗi lần demo các sự kiện sẽ ở trạng
thái `completed` (đã giải ngân) còn vé thì đã bán mất. Để bắt đầu một lần
demo sạch:

```bash
docker compose exec api npm run db:reset -w @tce/api
```

Lệnh này **xoá toàn bộ bảng, áp lại schema và seed lại dữ liệu mẫu** — một
lệnh là xong, không cần chạy thêm `db:init`. (Trước đây `db:reset` chỉ xoá
bảng, còn `db:init` mới seed; hai lệnh dễ lẫn. Nay đã gộp lại.)

Kiểm tra lại:

```bash
docker compose exec -T db psql -U postgres -d tickets -c "select name, status from events order by name;"
```
→ cả 2 sự kiện đều `scheduled` ✓

```bash
docker compose exec -T db psql -U postgres -d tickets -c "select count(*) from orders;"
docker compose exec -T db psql -U postgres -d tickets -c "select count(*) from ledger_transactions;"
```
→ `0` và `0` ✓

> Nếu `docker compose up` bị dừng bằng `Ctrl+C` thì các container cũng bị
> stop theo. Khởi động lại bằng `docker compose up -d` (thêm `-d` để chạy
> nền, không bị `Ctrl+C` giết).

**Dữ liệu seed** (6 nhóm vé, 3 người bán):

| Sự kiện | Nhóm vé | Giá | Còn lại | Người bán |
| --- | --- | --- | --- | --- |
| Đại nhạc Sơn Trà | Vé giá rẻ - khu vực C | 800.000 ₫ | 3 | Võ Chị |
| Đại nhạc Sơn Trà | Vé Standard - khu vực B | 900.000 ₫ | 4 | Trần Minh |
| Đại nhạc Sơn Trà | Vé vòng 2 | 1.200.000 ₫ | 5 | Lê Huy |
| Đại nhạc Sơn Trà | Vé VIP - khu vực A | 1.500.000 ₫ | 6 | Trần Minh |
| Hội thảo Kỷ nam | Vé góc - giá lẻ (test làm tròn) | 333.333 ₫ | 3 | Võ Chị |
| Hội thảo Kỷ nam | Vé phim khu vực B | 750.000 ₫ | 4 | Lê Huy |

Người dùng (dropdown **Đổi người dùng** ở thanh trên): 2 buyer (Nguyễn Lan, Phạm Dung),
3 seller (Võ Chị, Trần Minh, Lê Huy), 1 admin (Ops Admin).

---

## 1. Data — "Seed one or two events and several listings from at least two sellers"

**Kiểm tra:** mở <http://localhost:3000>.

- Thấy 2 sự kiện ✓
- Bấm vào "Hội thảo Kỷ nam 2026" → thấy 2 nhóm vé, của 2 seller khác nhau
  (Võ Chị, Lê Huy) ✓
- Mỗi nhóm vé hiện: tên, **giá vé** (800.000 ₫), **số lượng còn lại**
  (badge "Còn 4 vé", hoặc "Chỉ còn 2 vé" khi sắp hết, hoặc "Hết vé") và
  "đã bán 1/3" ✓
- Giá hiện bằng **VND** (800.000 ₫) ✓

**Về phí (hiện ở chân trang trang chủ):**
"Phí người mua 10% - cộng thêm vào tổng tiền bạn trả" /
"Phí người bán 5% - trừ khỏi tiền bạn nhận" /
"Tiền người bán được giữ trong escrow đến khi sự kiện hoàn tất mới vào số dư khả dụng" ✓

**Về "no authentication, a dropdown is fine":**
- Có dropdown **Đổi người dùng** ở góc trên phải ✓
- Bấm **Đổi** → trang render lại theo user đó ✓

---

## 2. Checkout — "event page, server-rendered, listings with price and available quantity"

**Kiểm tra server-rendered:** xem View Source (Cmd+U) trang sự kiện → nội dung
listing nằm ngay trong HTML, không phải JS fetch sau.

**Kiểm tra chọn listing + số lượng:**
1. Vào 1 sự kiện
2. Ở nhóm vé "Vé Standard - khu vực B" (900.000 ₫), đổi số lượng `1` → `2`
3. Bảng phí **cập nhật ngay** bên dưới, không cần bấm gì ✓
4. Bấm **Thanh toán**

**Kiểm tra "work well on a phone browser":**
- DevTools → thu nhỏ về 390×844 (iPhone) → một cột, nút bấm đủ lớn, không tràn ngang ✓
- Meta viewport có `width=device-width` ✓

**Kiểm tra chặn mua quá số lượng còn lại:**
- Đặt số lượng lớn hơn "còn lại" → nút **Thanh toán** bị disable ✓
- Sự kiện đã kết thúc → nút hiện **Đã kết thúc**, không bấm được ✓

---

## 3. Payment — "redirected to the gateway, pays with test credentials, comes back to a result page with the order's real status"

> Mặc định `MOCK_GATEWAY=true` → dùng trang giả lập **cùng đúng wire format VNPay**
> (amount ×100, HMAC-SHA512, IPN là GET). Sang phần "Test với VNPay sandbox thật" ở bước 3.4.

### 3.1 Redirect tới cổng thanh toán

1. Bấm **Thanh toán** → trình duyệt nhảy tới `localhost:3101/mock-pay?...`
2. Trang tiêu đề ghi rõ: **"Trang thanh toán MÔ PHỎNG - không phải VNPay"** ✓

   > Có mock là hợp lý: giám khảo clone repo phải chạy được ngay. Nhưng mock phải
   > **nói thẳng là mock** - một trang giả giống VNPay thật là cái bẫy cho người review.

### 3.2 Thanh toán bằng thẻ test

3. Ở tab **Thẻ quốc tế**, dùng sẵn: số thẻ `4242 4242 4242 4242`, hạn `12/28`, CVV `123`
4. Bấm nút **Thanh toán \<số tiền\>**

### 3.3 Quay lại trang kết quả — trạng thái **thật**

5. Trình duyệt tự quay lại `/orders/<id>?gateway=ok`
6. Trang hiện **"Kết quả thanh toán"**, trạng thái **"Trong escrow"** (đã thanh toán) ✓

**Bằng chứng IPN (quan trọng - đề nói "the gateway's notification must be handled correctly"):**
7. Cuộn xuống mục **"Thông báo từ cổng thanh toán"** → thấy bản ghi IPN với
   `vnp_ResponseCode = 00`, `vnp_TransactionStatus = 00` ✓

   > Trang này đọc trạng thái **đã lưu trong DB**, không phải query string
   > `?gateway=ok` từ redirect. Redirect có thể bị sửa bởi người dùng; IPN thì không.

**Đối chiếu số tiền** — dùng listing 800.000 ₫ × 2 vé:

| Khoản mục | Kỳ vọng |
| --- | --- |
| Giá vé × 2 | 1.600.000 ₫ |
| Phí dịch vụ người mua (10%) | 160.000 ₫ |
| **Tổng người mua trả** | **1.760.000 ₫** |
| Người bán nhận (trừ 5% phí) | 1.520.000 ₫ |
| Sàn giữ phí (15%) | 240.000 ₫ |

Check: 1.520.000 + 240.000 = 1.760.000 ✓

**Test làm tròn** (listing giá lẻ 333.333 ₫ × 2):
- Tổng mua **733.333 ₫** (666.666 + 66.667)
- Người bán nhận **633.333 ₫**
- Sàn giữ **100.000 ₫**
- Check: 633.333 + 100.000 = 733.333 ✓

**Test IPN trùng lặp (idempotency):**
```bash
# đối soát toàn bộ journal
npm run db:audit
```
Kết quả: `[audit] the journal is balanced (N transaction(s) checked)`.
Nếu IPN bị gửi lại, log API phải trả `RspCode: 02` ("already confirmed") và
**không** ghi thêm giao dịch vào ledger - số giao dịch trong audit không đổi.

### 3.4 Test với VNPay sandbox thật (nếu đã đăng ký)

1. Điền `VNPAY_MERCHANT_CODE` / `VNPAY_SECRET_KEY` trong `.env`, đặt `MOCK_GATEWAY=false`
2. Khởi động lại stack
3. Cần IPN URL công khai - xem phần **"How gateway callbacks reach the app locally"**
   trong README (cloudflared / ngrok), rồi đăng ký URL đó ở merchant portal VNPay
4. Thanh toán bằng thẻ test NCB trên sandbox → IPN thật về → trạng thái đổi sang
   "Trong escrow" ✓

**Bằng chứng đã chạy thật** (README mục *"What a run against the live sandbox showed (2026-10-28)"*)
ghi lại: `RspCode 00`, order → `PAID`, ledger ghi đúng 1 giao dịch cân bằng.

---

## 4. Escrow & ledger — "double-entry, every balance derivable, pending + available in UI, complete event releases"

### 4.1 Tiền người bán nằm ở escrow, chưa vào khả dụng

1. Dropdown → **Võ Chị (người bán)**
2. Mở **Ví của tôi** (`/wallet`)
3. Thấy 2 thẻ:
   - **Chờ giải ngân** = 1.520.000 ₫ (tiền còn bị giữ)
   - **Khả dụng** = 0 ₫ ✓
4. Mục **Lịch sử giao dịch** hiện giao dịch `PAYMENT_CAPTURE` với 3 dòng:
   - Nợ `asset:gateway_cash` 1.760.000
   - Có `liability:user:<Võ Chị>:pending` 1.520.000
   - Có `revenue:platform_fee` 240.000 ✓

   Nợ = Có ✓ — đây là **double-entry**.

### 4.2 Mọi số dư suy ra từ ledger, không lưu riêng

1. Mở **Lịch sử giao dịch** (`/ledger`)
2. Mỗi giao dịch có **2 dòng (Nợ - Có)** ✓
3. Mục **Số dư tài khoản** ở trên: tổng Nợ = tổng Có, có dòng báo **cân bằng** ✓

Kiểm chứng bằng SQL (không có bảng/cột số dư nào):
```bash
docker compose exec -T db psql -U postgres -d tickets -c "
select
 (select coalesce(sum(amount_vnd),0) from ledger_entries where direction='debit')  as tong_no,
 (select coalesce(sum(amount_vnd),0) from ledger_entries where direction='credit') as tong_co,
 (select coalesce(sum(amount_vnd),0) from ledger_entries where direction='debit')
 - (select coalesce(sum(amount_vnd),0) from ledger_entries where direction='credit') as chenh_lech;
"
```
→ `chenh_lech = 0` ✓

```bash
docker compose exec -T db psql -U postgres -d tickets -c "\d ledger_entries"
```
→ không có cột `balance` nào ✓

### 4.3 Ledger là append-only (không sửa được lịch sử)

```bash
docker compose exec -T db psql -U postgres -d tickets -c "
update ledger_entries set amount_vnd = 1;"
```
→ bị Postgres **từ chối** (trigger), không sửa được ✓
Tương tự `delete from ledger_entries;` → bị từ chối ✓

### 4.4 Hoàn tất sự kiện → giải ngân escrow

1. Dropdown → **Ops Admin**
2. Trang chủ hiện nút **"Hoàn tất sự kiện"** trên thẻ sự kiện.
   (User khác sẽ thấy dòng *"Chỉ quản trị viên mới giải ngân được"* thay cho nút) ✓
3. Bấm **Hoàn tất sự kiện** → sự kiện chuyển sang "Escrow đã được giải ngân"
4. **Hoàn tất sự kiện** trên trang chủ là đủ; hoặc vào **Quản trị** →
   **Sự kiện chờ giải ngân** → **Giải ngân escrow cho sự kiện này**
5. Dashboard cập nhật: **escrow → 0 ₫**, **đã giải ngân → 1.520.000 ₫** ✓

### 4.5 Tiền vào khả dụng của người bán

6. Dropdown → **Võ Chị (người bán)** → **Ví của tôi**
7. **Chờ giải ngân = 0 ₫**, **Khả dụng = 1.520.000 ₫** ✓
8. Lịch sử có thêm giao dịch `ESCROW_RELEASE`:
   - Nợ `liability:user:<Võ Chị>:pending` 1.520.000
   - Có `liability:user:<Võ Chị>:available` 1.520.000 ✓
9. Trang **Đơn hàng** của Võ Chị → đơn đó ở trạng thái **"Đã giải ngân"** ✓

### 4.6 Không có payout thật

- Không có API gọi chuyển khoản ngân hàng nào. Giải ngân chỉ là ghi giữa 2 tài khoản
  nợ trong ledger (README mục *"The escrow release is not a real settlement"* nói rõ) ✓

### 4.7 Database tự bảo vệ cân bằng (không chỉ ứng dụng)

Ứng dụng đã tự kiểm tra `debit == credit` trước khi ghi. Điểm cần chứng minh
ở đây là **tầng database cũng vậy** — ai có SQL access cũng không chèn được
một dòng lệch một vế.

```bash
docker compose exec -T db psql -U postgres -d tickets <<'SQL'
BEGIN;
INSERT INTO ledger_transactions (ref_type, memo)
  VALUES ('MANUAL_TEST', 'thu nghiem can bang');
INSERT INTO ledger_entries (txn_id, account_id, direction, amount_vnd)
  SELECT (SELECT id FROM ledger_transactions WHERE memo='thu nghiem can bang' LIMIT 1),
         id, 'debit', 999999
  FROM ledger_accounts WHERE code = 'asset:gateway_cash';
COMMIT;
SQL
```
→ **ERROR: unbalanced ledger transaction ...: debit 999999 <> credit 0** ✓
→ transaction bị rollback, **không có gì được ghi** ✓

Vì sao lại là *deferrable*? Vì các dòng của một giao dịch được insert **từng dòng
một**, nên tổng chỉ biết được khi dòng cuối cùng vào — vì vậy trigger chạy ở
`COMMIT`, không phải sau mỗi câu lệnh.

Dọn lại (không bắt buộc, dữ liệu test cũng không ảnh hưởng demo):
```bash
docker compose exec -T db psql -U postgres -d tickets -c "
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_update;
ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_no_update;
DELETE FROM ledger_entries WHERE txn_id IN (SELECT id FROM ledger_transactions WHERE memo='thu nghiem can bang');
DELETE FROM ledger_transactions WHERE memo='thu nghiem can bang';
ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_update;
ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_no_update;"
```

### 4.8 Phân quyền được kiểm ở tầng API (không chỉ ẩn nút)

Ứng dụng chỉ cần giấu nút là đủ cho một bài demo, nhưng **API cũng phải từ chối**.
Vì vậy các endpoint sau kiểm tra vai trò *trong API*:

| Endpoint | Cần vai trò | Kiểm tra bằng cách |
|---|---|---|
| `POST /api/events/:id/complete` | `admin` | gọi bằng `curl` với header của người mua |
| `GET /api/admin/overview` | `admin` | idem |
| `GET /api/admin/orders` | `admin` | idem |
| `POST /api/admin/events` | `admin` | idem |
| `GET /api/admin/payment-events` | `admin` | idem |
| `GET /api/wallet/:userId` | chính chủ (hoặc admin) | xem ví của người khác |
| `GET /api/orders?userId=…` | chính chủ (hoặc admin) | xem đơn của người khác |
| `GET /api/orders/:id` | người mua / người bán / admin | xem đơn của người khác |

Lấy id của một người bất kỳ:
```bash
docker compose exec -T db psql -U postgres -d tickets -t -c "
select id, name, role from users order by role;"
```

Thử giải ngân escrow bằng tài khoản người mua:
```bash
EVENT_ID=$(docker compose exec -T db psql -U postgres -d tickets -t -c "select id from events limit 1;")
BUYER_ID=$(docker compose exec -T db psql -U postgres -d tickets -t -c "select id from users where role='buyer' limit 1;")

curl -s -X POST "http://localhost:3101/api/events/$EVENT_ID/complete" \
  -H "content-type: application/json" \
  -H "x-tce-user-id: $BUYER_ID"
```
→ `{"error":"FORBIDDEN","message":"Endpoint này cần vai trò admin"}` ✓
→ escrow **không** bị giải ngân ✓

Đọc ví của người khác:
```bash
SELLER_ID=$(docker compose exec -T db psql -U postgres -d tickets -t -c "select id from users where role='seller' limit 1;")
curl -s "http://localhost:3101/api/wallet/$SELLER_ID" -H "x-tce-user-id: $BUYER_ID"
```
→ `{"error":"FORBIDDEN", ...}` ✓

Không nói ai đang làm gì:
```bash
curl -s "http://localhost:3101/api/wallet/$SELLER_ID"
```
→ `{"error":"UNKNOWN_CALLER"}` (401) ✓

> Lưu ý khi trình diễn: header `x-tce-user-id` chỉ là *danh tính*, không phải
> *bằng chứng*. API tự tra vai trò trong database, nên không thể tự khai vai
> admin — nhưng ai cũng có thể chọn "Ops Admin" trong dropdown (đề bài cho
> phép). README ghi rõ điểm này.

---

## 5. Trả lời trực tiếp các câu hỏi giám khảo có thể hỏi

| Câu hỏi | Trả lời | Chứng minh |
| --- | --- | --- |
| Chọn cổng nào, vì sao? | VNPay sandbox | README §2 (4 lý do), kèm log chạy thật |
| IPN sai chữ ký thì sao? | Từ chối, trả `RspCode 97`, **không** ghi ledger | `apps/api/src/payments/vnpay-crypto.ts`, test `provider.test.ts` |
| IPN lặp lại thì sao? | Trả `RspCode 02`, tiền ghi 1 lần | test `ipn.test.ts` |
| IPN tới muộn (đơn đã hết 15 phút)? | `REFUND_REQUIRED` - ghi vào tài khoản `refund` của người mua, **không** trả seller | `services/orders.ts` |
| Mất IPN thì sao? | Nút "Kiểm tra lại trạng thái" gọi `querydr` hỏi cổng | `mock-registry.ts` + test |
| Người mua tự bán vé của mình? | 409 `OWN_LISTING` | test `gaps.test.ts` |
| Mua quá số vé còn lại? | 400 | test |
| Sự kiện đã xong còn bán vé? | 409 `EVENT_COMPLETED` | test |
| Checkout bị double-tap? | `Idempotency-Key` → cùng 1 đơn | test `orders.test.ts` |
| 2 người mua cùng lúc? | `SELECT ... FOR UPDATE`, không deadlock | test `race.test.ts` (8 vòng) |
| Có auth thật không? | **Không** - đề cho phép dropdown. Role chỉ ở tầng UI | README §6 mục 13, §7 |
| Không production-ready gì? | 5-6 điểm liệt kê thẳng | README §7 |

---

## 6. Test tự động (chạy song song với demo)

```bash
npm run verify     # typecheck + unit + integration + e2e + build  (giống CI)
npm test           # unit + integration (cần database)
npm run e2e        # money flow qua HTTP thật, tự boot API, tự dọn schema
npm run test:unit  # không cần database
```

Kết quả kỳ vọng: **30 unit (shared) + 143 unit+integration (api) + e2e + build**,
tất cả xanh.
CI GitHub Actions chạy đúng bộ này trên mỗi push.

`npm run e2e` chạy trong **schema Postgres riêng** rồi xóa đi - **không làm bẩn
dữ liệu demo**, nên bạn có thể chạy giữa lúc đang demo.

---

## 7. Checklist nộp bài

- [x] `docker compose up` (qua `dev.sh`) chạy được từ clone sạch
- [x] Dữ liệu sạch trước khi demo: `db:reset` (1 lệnh là đủ), cả 2 sự kiện
      `scheduled`, `orders` = 0, `ledger_transactions` = 0
- [x] `.env.example` có đủ biến, **không** chứa credential thật
- [x] README đủ 5 mục bắt buộc: cách chạy + callback, cổng & lý do, quyết định
      khi đề im lặng, chưa production-ready, cách dùng AI + thời gian
- [x] Repo **shared với `github.com/syn-mcj`** ← *xem ghi chú bên dưới*
- [ ] VNPay sandbox credentials gửi **riêng** cho giám khảo, không đưa vào repo
      ← *việc của bạn, không làm được từ repo*
- [x] CI xanh trên `main`
- [x] Mọi dòng tiền cân bằng, ledger append-only
- [x] Pending + available hiện rõ trên UI

### Ghi chú: "Send your sandbox credentials to us separately, not in the repository"

Đây là dòng trong đề bài nói: **bạn phải gửi cho giám khảo tài khoản VNPay
sandbox qua một kênh riêng (email, zalo, messenger), KHÔNG commit vào GitHub.**

Lý do: `VNPAY_SECRET_KEY` là khóa dùng để **ký (sign) và xác minh (verify)
chữ ký của IPN**. Người có secret này có thể giả mạo thông báo "thanh toán
thành công" cho đơn hàng bất kỳ. Nếu nó nằm trong repo public, bất kỳ ai
clone repo cũng đọc được - và lúc đó tài khoản sandbox của bạn không còn là
"sandbox" nữa, nó là một credential lộ thiên.

**Cơ chế đã chuẩn bị sẵn (không cần code thêm):**

| Nơi | Nội dung | Đã commit? |
| --- | --- | --- |
| `.env.example` | `VNPAY_MERCHANT_CODE=` / `VNPAY_SECRET_KEY=` - **rỗng** | ✅ Có (đúng) |
| `.env` (local) | giá trị thật của bạn | ❌ Không - trong `.gitignore` |
| README §"Credentials" | hướng dẫn điền + gửi riêng | ✅ Có |

Đã kiểm tra: `git log --all -p -- .env` không có gì (`.env` **chưa từng** được
commit), và trong toàn bộ history chỉ tồn tại placeholder `VNPAY_SECRET_KEY=...`
trong README. **Không có secret thật nào lọt ra repo.**

**Việc bạn cần làm - 3 bước:**

1. **Đăng ký VNPay sandbox** tại <https://sandbox.vnpayment.vn/devreg/>.
   VNPay gửi email cho bạn 2 giá trị: `vnp_TmnCode` (mã merchant) và
   `vnp_HashSecret` (secret key).
   > ✅ **Đã xong** - tài khoản sandbox đã được đăng ký và chạy thật một
   > giao dịch với thẻ NCB (thành công, IPN đã về, sổ cái cân bằng).
   > Hai giá trị nằm trong `.env` local của bạn và **chỉ** được gửi riêng.
2. **Điền vào `.env` local** (file này KHÔNG lên GitHub):
   ```
   VNPAY_MERCHANT_CODE=<vnp_TmnCode của bạn>
   VNPAY_SECRET_KEY=<vnp_HashSecret của bạn>
   MOCK_GATEWAY=false
   ```
   Rồi `docker compose up -d --build api` để nạp lại env.
3. **Gửi riêng cho giám khảo** - email hoặc nhắn zalo/messenger, kèm:
   - `vnp_TmnCode`
   - `vnp_HashSecret`
   - link hướng dẫn đăng nhập sandbox
   - link tunnel IPN của bạn (nếu họ muốn chạy thật)

**Nếu bạn chưa đăng ký được / không muốn gửi:** nói rõ với giám khảo rằng
bạn dùng mock gateway (wire format giống hệt VNPay) và gửi kèm
`MOCK_GATEWAY_SECRET=mock-secret-local-dev` để họ tự chạy. Đề cho phép
"where this task is unclear, make a judgement call" - nhưng nói thẳng là mock
còn hơn im lặng.

### Ghi chú: "shared with https://github.com/syn-mcj"

Repo hiện tại: `github.com/vogiahuy2506-lang/ticket` (public, không phải fork).

> **Đã làm xong phần có thể làm từ phía bạn.** `Syn-McJ` đã được mời làm
> **collaborator** với quyền `write` trên repo này, nên khi họ chấp nhận lời
> mời thì họ clone được, push được, và không cần bạn làm gì thêm.
>
> Lời mời có sẵn tại
> <https://github.com/vogiahuy2506-lang/ticket/invitations>.

Cách làm nếu cần làm lại (ví dụ lời mời hết hạn):

```bash
# 1. đăng nhập GitHub CLI (mở trình duyệt, xác nhận bằng mã)
gh auth login

# 2a. Nếu giám khảo đã tạo repo trước: đổi remote rồi push
REMOTE_REPO=Syn-McJ/ticket ./scripts/push-to-github.sh

# 2b. Nếu giám khảo chưa tạo repo: tạo repo trống rồi push
gh repo create Syn-McJ/ticket --public --description "Ticket checkout with escrow" --clone=false
REMOTE_REPO=Syn-McJ/ticket ./scripts/push-to-github.sh

# 2c. Hoặc bảo giám khảo add bạn làm collaborator, rồi bạn push lên repo của họ
```

Sau đó kiểm tra:

```bash
git remote -v                       # remote phải trỏ tới syn-mcj
curl -s https://api.github.com/repos/Syn-McJ/ticket | grep full_name
```

> **Đừng** tạo repo private: giám khảo cần clone được để chạy thử. Nếu
> `Syn-McJ/ticket` đã tồn tại và có code, dùng cách (2c) - bảo họ add bạn
> làm collaborator.

### Ghi chú: khi hết vé seed

Kho catalogue hữu hạn. Hết vé thì vào **Quản trị** → **Thêm vé mới** →
**Tạo sự kiện mới** (điền tên, địa điểm, giờ bắt đầu, thêm nhóm vé).
Tạo sự kiện **không** động vào ledger.
