# Những câu hỏi giám khảo khó tính sẽ hỏi

Bộ câu hỏi này được viết theo góc nhìn **người chấm khó tính nhất**: không hỏi lại
những gì bài đã làm tốt, mà đi thẳng vào chỗ yếu thật sự. Mỗi câu kèm câu trả
lời ngắn gọn và **bằng chứng cụ thể** để đối chiếu.

Đây là bản chuẩn bị trước, không phải để đọc thuộc - để biết mình có thể trả lời
được và không nói sai.

---

## Nhóm 1 - Bảo mật (chỗ dễ bị gặp nhất)

### Q1. "Ai cũng gọi được API giải ngân escrow thì sao?"

> **Đúng, đây là lỗ hổng thật.** `POST /api/events/:id/complete` không có bất kỳ
> kiểm tra quyền nào ở tầng API - tôi gọi thẳng bằng `curl`, không cookie, không
> token, vẫn nhảy `200` và giải ngân tiền.
>
> Lý do: đề bài nói rõ *"No authentication needed for this test task"*, nên tôi
> đặt kiểm tra role ở **tầng web** (`apps/web/src/app/actions.ts:134` kiểm tra
> `user.role !== 'admin'` trong server action, không phải ẩn nút UI). Với
> server action thì đó là kiểm tra thật, không phải trang trí. Nhưng gọi API
> trực tiếp thì bỏ qua được.
>
> **Cách sửa:** middleware Fastify đọc cookie `tce_uid`, tra role trong DB, và
> `requireRole('admin')` trên mọi route mutating. Sửa ở đây là một file, vì
> `getCurrentUser()` đã là nguồn danh tính duy nhất.

### Q2. "Đọc ví của người khác thì sao?"

> `GET /api/wallet/:userId` cũng mở. Cùng lý do: không có auth. Nhưng có một
> điểm khác biệt đáng nói: `GET /api/orders?userId=X` **không** cho caller tự
> quyền - route đọc `role` từ DB chứ không tin query string
> (`apps/api/src/routes/index.ts:203`), nên không có đường leo thang bằng cách
> sửa tham số.

### Q3. "IPN endpoint thì sao? Ai cũng POST vào được?"

> Signature được verify bằng HMAC-SHA512 với `VNPAY_SECRET_KEY` - không có
> secret thì không tạo được payload hợp lệ. Nhưng **không có rate limit** và
> **không có timestamp/nonce window**, nên một IPN cũ vẫn được chấp nhận. Đã
> ghi trong README §7.

---

## Nhóm 2 - Chính sách kế toán (hỏi sâu, dễ trượt)

### Q4. "Cân bằng double-entry được ép ở tầng nào?"

> **Ở tầng ứng dụng, không phải ở database.** `postTransaction()` tự kiểm
> `debitTotal === creditTotal` trước khi ghi
> (`apps/api/src/services/ledger.ts:71`), và mọi posting đều đi qua đó.
>
> Nhưng tôi đã thử bằng SQL thẳng: `INSERT` một giao dịch chỉ có dòng Nợ
> 999.999, không có dòng Có → **database chấp nhận**. `auditLedger()` vẫn phát
> hiện ra (`ok: false`), nhưng đó là hậu kiểm, không phải rào chắn.
>
> **Cách sửa:** `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`
> trên `ledger_entries`, kiểm tra cân bằng khi COMMIT. Đây là điểm tôi sẽ sửa
> đầu tiên nếu có thêm thời gian.

### Q5. "Ledger append-only thật sự, hay chỉ là trigger dễ gỡ?"

> Trigger chặn `UPDATE`/`DELETE` trên `ledger_entries`, `ledger_transactions`
> và `payments` (`apps/api/src/db/schema.sql:169-183`). Đã test với dữ liệu
> thật: `ERROR: ledger entries are append-only (attempted UPDATE)`.
>
> Nhưng tôi nói thẳng: **đây là append-only, không phải tamper-evident.**
> Người có quyền `ALTER TABLE` vẫn `DROP TRIGGER` rồi sửa lịch sử được.
> README §7 đã nói rõ. Muốn tamper-evident thì cần hash chain: mỗi entry
> chứa hash của entry trước, và một hash kiểm tra cuối chuỗi.

### Q6. "Cột số dư có tồn tại ở đâu không?"

> **Không có.** Tôi đã `\d ledger_entries` - cột nào cũng không phải balance.
> Số dư tính bằng `SUM(...) GROUP BY` mỗi lần đọc
> (`apps/api/src/services/ledger.ts:127`). Đây là điểm đúng yêu cầu đề:
> *"Every balance must be derivable from the ledger."*

### Q7. "Phí làm tròn thế nào, và có khớp không?"

> Cả hai phần trăm đều áp lên **subtotal**, mỗi cái làm tròn half-up độc lập
> về VND nguyên (`packages/shared/src/fees.ts:35`). Bảo đảm bất biến
> `gross === sellerNet + platformFee` cho **mọi** đơn, kể cả số lẻ.
>
> Listing 333.333 ₫ × 2: tổng mua 733.333, bán nhận 633.333, sàn giữ
> 100.000. 633.333 + 100.000 = 733.333 ✓. Seed cố tình có listing giá lẻ để
> chứng minh điều này ngay.

### Q8. "Hai tài khoản của người bán tách bạch thế nào?"

> `liability:user:<id>:pending` và `liability:user:<id>:available`. Mỗi user có
> 3 tài khoản nợ riêng (pending / available / refund), tất cả có
> `owner_user_id` trỏ về `users.id` - nên một người không thể bị gán nhầm tiền
> của người khác.
>
> Vì sao tách? Vì **người bán phải nhìn thấy tiền của mình**, đề yêu cầu
> *"pending balance and available balance should be seen in UI"*. Một tài
> khoản "escrow" gộp chung thì người bán nhìn không ra bao nhiêu là của mình.

### Q9. "Tài khoản hoàn tiền để ở đâu? Vì sao không gộp vào một tài khoản sàn?"

> Tôi đặt **theo từng người mua**: `liability:user:<buyer>:refund`. Lý do ghi
> trong README §6 mục 29: một tài khoản "sàn nợ người mua" gộp chung thì sổ
> vẫn cân bằng, nhưng **người bị nợ không nhìn thấy mình bị nợ bao nhiêu** -
> đó là tiền của họ biến mất khỏi tầm mắt. Tài khoản riêng cho phép ví hiện
> dòng *"Tiền sàn nợ bạn hoàn lại"*.

---

## Nhóm 3 - Concurrency (chỗ hay bị hỏi nhất)

### Q10. "Hai người mua cùng giật vé cuối cùng?"

> Lock `SELECT ... FOR UPDATE` trên dòng `listings`
> (`apps/api/src/services/orders.ts:165`). Người thứ hai chờ, đọc lại
> `quantity_sold` đã cập nhật, và nhận `409`/`400` nếu hết vé.
>
> Test race chạy 8 vòng (`apps/api/test/race.test.ts`).

### Q11. "Checkout đúng lúc sự kiện vừa hoàn tất thì sao? Tiền bị kẹt trong escrow?"

> **Đây là câu hỏi hay nhất, và là chỗ tôi nghĩ lâu nhất.**
>
> Checkout giữ **shared lock** (`FOR SHARE`) trên dòng `events`; escrow release
> giữ **exclusive lock** (`FOR UPDATE`) trên **cùng dòng đó**
> (`orders.ts:149` và `orders.ts:610`). Hai giao dịch serialize.
>
> Timeline nếu **không** có lock:
> 1. Checkout đọc `events.status = 'scheduled'`
> 2. Admin bấm "Hoàn tất sự kiện" → commit, giải ngân hết escrow, `status = 'completed'`
> 3. Checkout tiếp tục → tạo order cho sự kiện đã xong → **tiền nằm trong escrow mà không ai giải ngân được**
>
> Lỗi này không phải 409 (409 chỉ chặn được một nửa cửa sổ). Lock mới chặn
> trọn. Và tôi đã giải thích chính xác cơ chế này trong comment ngay tại chỗ.

### Q12. "Double-tap nút Thanh toán?"

> Client gửi `Idempotency-Key`; unique index `(buyer_id, idempotency_key)`
> (`schema.sql:194`). Key lặp → trả lại **order cũ**, không giữ vé lần hai,
> không tạo payment thứ hai.

### Q13. "IPN gửi lại 5 lần thì sao?"

> Unique constraint `(provider, order_id, provider_txn_id)` trên `payments` +
> order row lock `FOR UPDATE` → chỉ ghi ledger **một lần**. Lần replay trả
> `RspCode: 02`.

---

## Nhóm 4 - IPN & mất thông báo

### Q14. "IPN đến muộn, sau khi vé đã trả lại?"

> Order `PENDING_PAYMENT`/`EXPIRED` + IPN thành công → `REFUND_REQUIRED`. Tiền
> được ghi vào `liability:user:<buyer>:refund`, **không** vào escrow của người
> bán - vì vé đã thuộc về người khác rồi. Người bán không nhận được tiền của
> vé không còn của mình.

### Q15. "Mất IPN thì sao? Người mua đã trả tiền mà đơn vẫn treo."

> Nút "Kiểm tra lại trạng thái" gọi `querydr` của gateway. Chỉ áp dụng khi:
> (a) câu trả lời **được ký đúng**, (b) **số tiền khớp** order.
>
> Quy tắc cố ý hẹp: querydr là nguồn sự thật **thứ hai** và có thể sai theo
> cách IPN không thể sai. Cụ thể - gateway trả về code `91` (chưa biết giao
> dịch) **không phải** là "người mua đã hủy". Nếu coi là hủy, hủy luôn order và
> trả vé lại **trong lúc người mua đang thanh toán** - tiền đến sau sẽ thành
> late payment thay vì một giao dịch mua hàng.
>
> Đây là loại lỗi mà test bình thường không bắt được. Tôi đã đọc tài liệu
> VNPay để xác minh trước khi viết.

### Q16. "IPN sai chữ ký?"

> `RspCode: 97`, không ghi gì vào ledger. Có test riêng
> (`apps/api/test/provider.test.ts`).

---

## Nhóm 5 - Quyết định thiết kế (hỏi "tại sao bạn chọn vậy")

### Q17. "Chọn VNPay vì gì? Có cân nhắc Stripe/MoMo không?"

> README §2 liệt kê 4 lý do. Tóm lại: VNPay là gateway phổ biến nhất ở VN
> nên "real payment gateway's sandbox" của đề gần với thị trường thật; sandbox
> miễn phí và không cần business registration; IPN là GET + HMAC-SHA512 đơn
> giản, dễ verify đúng; và tài liệu tiếng Anh đủ rõ.

### Q18. "Tại sao có mock gateway? Không phải đã bảo dùng gateway thật?"

> Mặc định `MOCK_GATEWAY=true` để **repo clone là chạy được ngay**, vì giám
> khảo không có credential của tôi. Nhưng nó **nói thẳng là mock**: tiêu đề
> *"Trang thanh toán MÔ PHỎNG - không phải VNPay"*, không dùng tên thương hiệu
> thật, và dùng **cùng wire format** (amount ×100, HMAC-SHA512, IPN là GET) nên
> code gọi sandbox là code gọi mock.
>
> Tôi cũng chạy thật với sandbox VNPay và ghi lại kết quả trong README §3.

### Q19. "Không có auth thật - vậy 'role' nghĩa là gì?"

> Đề cho phép dropdown. Role tồn tại để **logic nghiệp vụ nhận biết người mua /
> người bán / vận hành** và để UI demo đọc như sàn thật. Tôi nói rõ trong
> README §6 và §7 rằng đây là **authorization ở tầng trình bày, không phải bảo
> mật** - ai cũng chọn được "Ops Admin" trong dropdown. Nói thẳng hơn so với
> giả vờ có auth.

### Q20. "Giữ vé 15 phút là gì? Ai chạy việc quét đơn hết hạn?"

> `ORDER_RESERVATION_MINUTES = 15`. Việc quét là **lazy sweep** - chạy khi app
> chạm vào đơn hàng (`expireStaleOrders`), không phải cron. Ưu điểm: không có
> background job để chết âm thầm. Nhược điểm: không có traffic thì đơn treo
> vẫn nằm trong DB. README §7 ghi rõ, và tôi đã viết test cho cả hai vế.

---

## Nhóm 6 - Câu hỏi về chính quy trình

### Q21. "Bạn dùng AI thế nào?"

> README §8 trả lời chi tiết: dùng cho thiết kế, viết test, review. Điểm
> quan trọng tôi nói thẳng: **AI đã tạo ra bug mà tôi không tự nhìn ra** -
> trang 404 nuốt luôn lỗi 500, biến sự cố hệ thống thành "không tìm thấy
> trang". Đó là lý do tôi nói ở README §8: dùng AI như một người review
> đồng nghiệp, không phải như người thay code.

### Q22. "Mất bao lâu?"

> Có ghi trong README §8, ước tính theo giờ làm việc thực tế.

### Q23. "Có cái gì chưa production-ready?"

> README §7 liệt kê 16 mục thẳng thắn, đầu tiên là: không có auth, mock
> gateway phải tắt, IPN replay protection chỉ một phần, chưa có refund flow,
> chưa có payout thật, migration chưa versioned, ledger append-only nhưng
> không tamper-evident, chưa có audit log, chưa có observability.

---

## Câu hỏi tôi **không** đặt ra (vì bài đã làm tốt)

Để tôi tự nhắc: đừng mất thời gian phòng thủ những chỗ này - hãy khoe.

- Fee split đúng 10%/5%? ✓ có test
- Số dư suy ra từ ledger, không lưu cột riêng? ✓
- Escrow tách pending/available hiện rõ trên UI? ✓
- Order trả về đúng trạng thái **thật** từ DB, không phải từ query string
  redirect? ✓ (đây là điểm hay, đáng nói: redirect có thể bị sửa bởi người
  dùng, IPN thì không)
- Append-only trigger? ✓
- Có `FOR UPDATE` chống race? ✓
- Idempotency key chống double-tap? ✓
- Lost IPN có đường recovery? ✓
- Server action kiểm tra role thật, không chỉ ẩn nút? ✓
- Test suite + CI? ✓
- README đủ 5 mục deliverable? ✓

---

## Ba điều tôi sẽ sửa nếu còn thời gian (xếp theo mức độ rủi ro)

1. **Ràng buộc cân bằng ở tầng DB** (`DEFERRABLE CONSTRAINT TRIGGER`) - hiện chỉ
   có ở tầng app, ai có quyền SQL là phá được kế toán.
2. **Auth thật cho API** - đóng lỗ hổng Q1/Q2.
3. **Timestamp window cho IPN** - chặn IPN cũ, đóng nốt "replay protection
   is partial".
