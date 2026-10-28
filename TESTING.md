# Kế hoạch test - ticket checkout with escrow

Hướng dẫn này bám sát từng câu trong đề bài, theo thứ tự giám khảo đọc.
Mỗi bước đều ghi rõ **làm gì** và **thấy gì** để biết là đúng.

---

## 0. Chuẩn bị (5 phút)

```bash
git clone <repo> && cd ticket-checkout-escrow
cp .env.example .env
./scripts/dev.sh
```

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

Kết quả kỳ vọng: **30 unit + 126 integration + e2e + build**, tất cả xanh.
CI GitHub Actions chạy đúng bộ này trên mỗi push.

`npm run e2e` chạy trong **schema Postgres riêng** rồi xóa đi - **không làm bẩn
dữ liệu demo**, nên bạn có thể chạy giữa lúc đang demo.

---

## 7. Checklist nộp bài

- [ ] `docker compose up` (qua `dev.sh`) chạy được từ clone sạch
- [ ] `.env.example` có đủ biến, **không** chứa credential thật
- [ ] README đủ 5 mục bắt buộc: cách chạy + callback, cổng & lý do, quyết định
      khi đề im lặng, chưa production-ready, cách dùng AI + thời gian
- [ ] Repo **shared với `github.com/syn-mcj`** ← *xem ghi chú bên dưới*
- [ ] VNPay sandbox credentials gửi **riêng** cho giám khảo, không đưa vào repo
- [ ] CI xanh trên `main`
- [ ] Mọi dòng tiền cân bằng, ledger append-only
- [ ] Pending + available hiện rõ trên UI

### Ghi chú: "shared with https://github.com/syn-mcj"

Repo hiện tại: `github.com/vogiahuy2506-lang/ticket` (public).

Nếu `syn-mcj` là tài khoản của giám khảo và họ đã tạo repo:
```bash
REMOTE_REPO=syn-mcj/ticket ./scripts/push-to-github.sh
```
Script sẽ tự đổi remote và push. Nếu họ chưa tạo repo, cần bảo họ tạo rồi bạn push,
hoặc họ add bạn làm collaborator rồi bạn push lên `syn-mcj/ticket`.
Không có credential nào trong máy lúc này, nên bước này **phải tự làm** —
không tự động hoá được.

### Ghi chú: khi hết vé seed

Kho catalogue hữu hạn. Hết vé thì vào **Quản trị** → **Thêm vé mới** →
**Tạo sự kiện mới** (điền tên, địa điểm, giờ bắt đầu, thêm nhóm vé).
Tạo sự kiện **không** động vào ledger.
