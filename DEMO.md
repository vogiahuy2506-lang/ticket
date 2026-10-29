# Kịch bản trình bày bài (5 phút)

Dùng khi demo cho giám khảo. Mọi con số trong tài liệu này đã chạy thật và
được kiểm lại trên code hiện tại.

---

## 0. Trước khi bắt đầu (5 phút, làm trước khi gặp giám khảo)

```bash
cp .env.example .env        # nếu chưa có
./scripts/dev.sh             # dựng stack
```

Kiểm tra stack đã sống:

```bash
curl -s http://localhost:3101/health
# {"status":"ok","db":true,"provider":"mock"}
```

**Nếu demo với VNPay sandbox thật** (khuyến nghị, ấn tượng mạnh hơn):

1. Mở <https://sandbox.vnpayment.vn/merchantv2/>, vào **Thay đổi thông tin
   cấu hình** (<https://sandbox.vnpayment.vn/merchantv2/Account/TerminalEdit.htm>).
2. **IPN Url** = `<tunnel-url>/api/ipn/vnpay`
3. **Giao thức IPN** = `GET`
4. **Kiểu mã hóa** = `HMACSHA512`
5. Bấm **Hoàn thành**.

> Bước này là **bắt buộc** nếu muốn IPN thật. Không có nó, gateway không có
> chỗ để gọi về, order sẽ kẹt ở `PENDING_PAYMENT` dù buyer đã trả tiền.

Bấm link **Test call IPN** trên trang đó. Kết quả đúng là:

```json
{"RspCode":"97","Message":"Invalid signature"}
```

`97` là **đúng** - link test ký bằng hash giả. Nếu ra `00` mới là lỗi.

---

## 1. Khoảnh khối mở đầu (30 giây)

Mở <http://localhost:3000>.

Nói:

> "Đây là VeX - một lát cắt của chợ vé sự kiện: checkout, thanh toán qua
> VNPay, giữ tiền trong escrow, và một sổ cái kép. Trước khi vào code, tôi
> sẽ chạy một giao dịch thật từ đầu đến cuối, rồi mở sổ cái ra cho anh
> xem tiền đi đâu."

---

## 2. Chọn người mua (20 giây)

Thanh trên cùng: dropdown **Nguyễn Lan (người mua)** → bấm **Đổi**.

> "Không có đăng nhập - đề bài cho phép, tôi ghi rõ trong README. Người
> dùng được chọn bằng cookie, nhưng **quyền** thì lấy từ database, không
> phải từ dropdown. Sau này thay `getCurrentUser()` là xong."

---

## 3. Vào sự kiện, xem giá (40 giây)

Bấm **Sự kiện** → **Đại nhạc Sơn Trà - Đêm Mưa**.

Chỉ vào card vé:

> "Ba người bán trên một sự kiện. Số lượng còn lại hiện ra ngay - vì vé
> được **giữ chỗ lúc checkout**, không phải lúc thanh toán. Nếu không,
> hai người mua có thể cùng mua tấm vé cuối."

Chỉ vào card **Vé góc - giá lẻ (test làm tròn) 333.333 ₫** ở sự kiện kia:

> "Cái giá lẻ này cố ý. 10% và 5% được làm tròn **riêng biệt**, nên
> `gross == sellerNet + platformFee` đúng với **mọi** đơn hàng - đây là
> điều kiện để sổ cái luôn cân bằng."

---

## 4. Checkout (60 giây)

Chọn **Vé Standard - khu vực B** (900.000 ₫ / vé), đổi số lượng = **2**.

Chỉ vào khung tổng:

> "1.800.000 tiền vé, cộng 10% phí dịch vụ = 180.000. Buyer trả
> **1.980.000 ₫**."

Bấm **Thanh toán** → bị đưa sang trang cổng thanh toán.

---

## 5. Thanh toán (60 giây)

**Nếu dùng mock gateway** (mặc định): trang giả lập có sẵn số thẻ
`4242 4242 4242 4242`, hết hạn `12/28`, CVV `123`. Bấm
**Thanh toán 1.980.000 ₫**.

**Nếu dùng VNPay sandbox thật**: nhập thẻ NCB
`9704198526191432198`, tên `NGUYEN VAN A`, hạn `07/15`, OTP `123456`.

> "Số tiền trên dây là `vnp_Amount`. VNPay nhân với 100, nên `198000000`
> trên wire là `1.980.000` đồng. IPN trả về cũng nhân 100 - nếu quên
> chia, mọi đơn hàng sẽ bị từ chối với mã `04`."

Trình duyệt quay lại trang đơn hàng. Trang tự cập nhật trong vài giây.

---

## 6. Xem escrow (40 giây)

Trang kết quả hiện:

```
Trạng thái đơn hàng   Đã thanh toán - tiền giữ trong escrow
```

Và khối **Chi tiết tiền**:

| Dòng | Số tiền |
| --- | --- |
| Giá vé x 2 | 1.800.000 ₫ |
| Phí dịch vụ người mua (10%) | 180.000 ₫ |
| **Tổng người mua trả** | **1.980.000 ₫** |
| Người bán nhận (trừ 5% phí) | 1.710.000 ₫ |
| Sàn giữ phí (15%) | 270.000 ₫ |

> "Đây là điểm cốt lõi của bài: **buyer trả 1.980.000, nhưng người bán chưa
> được nhận đồng nào**. Tiền nằm ở cổng thanh toán, ghi vào sổ cái như
> một khoản nợ của sàn với người bán."

---

## 7. Đổi sang người bán, xem escrow (60 giây)

Thanh trên cùng → **Trần Minh (người bán)** → **Đổi** → bấm **Ví của tôi**.

> "Số dư **chờ giải ngân** là 1.710.000. Và đây là điểm tôi muốn giám
> khảo chú ý: **không có cột số dư nào trong database**. Số này được tính
> từ `ledger_entries`. Muốn kiểm tra thì xem mục *Số dư được tính trực tiếp
> từ lịch sử giao dịch*."

Cuộn xuống mục **Lịch sử giao dịch** - thấy giao dịch **Thanh toán** với
2 dòng Nợ/Có.

---

## 8. Giải ngân escrow (60 giây) - đỉnh điểm

Đổi sang **Ops Admin** → **Đổi** → bấm tab **Quản trị**.

Chỉ vào **Sự kiện chờ giải ngân** → bấm **Giải ngân escrow cho sự kiện này**.

> "Giờ sự kiện kết thúc, tiền được giải ngân. Không ai chuyển tiền -
> sàn **ghi một bút toán** trong sổ cái. Đó là điểm: mọi đồng tiền đều
> đi qua một giao dịch kép, không có ai sửa số dư bằng tay."

Quay lại **Ví của tôi** (vẫn là Ops Admin) → đổi sang **Trần Minh** →
**Đổi** → **Ví của tôi**:

| | Trước | Sau |
| --- | --- | --- |
| Chờ giải ngân | 1.710.000 ₫ | **0 ₫** |
| Khả dụng | 0 ₫ | **1.710.000 ₫** |

> "Trạng thái escrow nằm **trong chính cái tài khoản**, không phải một cột
> cờ riêng. `liability:user:{id}:pending` thành `liability:user:{id}:available`
> - đọc số dư là biết ngay trạng thái."

---

## 9. Mở sổ cái (60 giây)

Bấm tab **Lịch sử giao dịch**.

> "Đây là sổ cái kép. Mọi dòng tiền là một giao dịch có **hai dòng bằng
> nhau**: Nợ và Có. Ở đây Tổng Nợ bằng Tổng Có - và đó không phải tính
> toán của tôi, mà là **ràng buộc của database**."

Chỉ vào 2 giao dịch:

```
Thanh toán
   Nợ  1.980.000  Tiền tại cổng thanh toán
   Có  1.710.000  Tiền chờ giải ngân - Trần Minh
   Có    270.000  Phí dịch vụ của sàn

Giải ngân escrow
   Nợ  1.710.000  Tiền chờ giải ngân - Trần Minh
   Có  1.710.000  Tiền khả dụng - Trần Minh
```

> "Và sổ cái này **append-only ở tầng database** - có trigger chặn UPDATE và
> DELETE. Muốn sửa sai thì phải đi bút toán đảo, không xóa đi. Sửa sai thì
> lịch sử vẫn đúng."

---

## 10. Câu hỏi khó (nếu giám khảo hỏi)

**"Ai xem được sổ cái này?"**
> "Ai cũng xem được, và đó là **quyết định có chủ đích** - sổ cái là dấu
> vết kiểm toán, escrow mà buyer không kiểm tra được thì không đáng tin.
> Nó chỉ hiện **số tiền, không hiện ai**. Muốn private thì thêm role check
> vào `/api/ledger/*`, một chỗ."

**"Có race condition không - người mua thanh toán đúng lúc sự kiện kết thúc?"**
> "Có, và đây là chỗ tôi cẩn thận nhất. Checkout khóa dòng `events` bằng
> `FOR SHARE`, giải ngân khóa bằng `FOR UPDATE`. Cùng thứ tự khóa - nếu
> đảo thứ tự thì Postgres deadlock. Có `test/race.test.ts` chạy 8 lần để
> chứng minh. Nếu không xử lý: buyer trả tiền vào escrow không bao giờ
> được giải ngân - **tiền bị kẹt, không lối ra**."

**"Đơn hàng bị double-tap thì sao?"**
> "Checkout nhận `Idempotency-Key`, có `UNIQUE (buyer_id, idempotency_key)`.
> Bấm hai lần là cùng một đơn, không phải hai đơn."

**"IPN đến trùng thì sao?"**
> "Idempotent. Có `UNIQUE (provider, order_id, provider_txn_id)` và một
> partial unique index riêng chặn cùng một `vnp_TransactionNo` ở **đơn
> khác**. Đơn thứ hai nhận `RspCode: 02` - đã xác nhận rồi, tiền đã ghi
> một lần."

**"IPN sai chữ ký thì sao?"**
> "Từ chối, mã `97`, **không** ghi sổ cái. Nhưng vẫn log vào
> `payment_events` - đó là bảng đối soát, dùng để tìm thông báo bị mất."

**"Thanh toán đến muộn, vé đã hết?"**
> "Không drop thông báo - drop là mất tiền buyer. Nó thành `REFUND_REQUIRED`
> và được ghi vào `liability:user:{buyer}:refund`, một tài khoản **riêng cho
> từng buyer** để họ thấy được sàn đang giữ tiền của mình."

**"Có authentication không?"**
> "Không - đề nói rõ không cần. Nhưng `role` vẫn có hiệu lực thật: giải
> ngân escrow, tạo event, xem dashboard đều kiểm tra `admin` **ở server
> action và ở API**, không chỉ ẩn nút. Còn thiếu là chứng minh danh tính."

**"Không có test E2E thật à?"**
> "Có, `npm run e2e` chạy đủ dòng tiền qua HTTP thật, tự boot API, tự
> dọn schema riêng, và assert **số chênh lệch** nên chạy lại nhiều lần
> vẫn pass. CI chạy nó mỗi lần push."

---

## 11. Câu hỏi hơi gai (nếu giám khảo đào sâu) - trả lời thẳng

**"Có dùng AI không?"**
> "Có. Tôi dùng Cursor. Nhưng tôi để lại cả những lần AI sai trong README
> mục 8 - và một trong số đó là **lỗi sản phẩm thật**: ban đầu payment bị
> declined bị coi là 'không đáng tin' và bị drop, tiền buyer mất. Test bắt
> được. AI giúp viết code, nhưng nó không thay được việc kiểm tra."

**"Có điều gì chưa làm được không?"**
> "Ba thứ, tôi ghi rõ trong README. Một: `querydr` của sandbox VNPay trả
> `99` không có checksum, nên **fallback khi IPN bị mất không test được
> live** - chỉ test được với mock. Hai: tôi chưa đăng ký IPN URL trong
> merchant portal nên chạy live thì IPN không về. Ba: chưa có test UI
> tự động."

---

## Phụ lục: dữ liệu cần cho Q&A

| Thứ | Giá trị |
| --- | --- |
| Subtotal 2 vé Standard | 1.800.000 ₫ |
| Phí buyer 10% | 180.000 ₫ |
| Buyer trả | **1.980.000 ₫** |
| Phí seller 5% | 90.000 ₫ |
| Seller nhận | **1.710.000 ₫** |
| Platform giữ | **270.000 ₫** (15%) |
| `vnp_Amount` trên wire | `198000000` (= ×100) |
| Tổng Nợ = Tổng Có | 1.980.000 = 1.980.000 |

### Lệnh để giám khảo tự kiểm chứng

```bash
# sổ cái cân bằng?
curl -s http://localhost:3101/api/ledger/audit
# {"ok":true,"unbalanced":[]}

# sổ cái không cho sửa/xóa?
curl -s http://localhost:3101/api/ledger/integrity

# toàn bộ suite
npm run verify
```
