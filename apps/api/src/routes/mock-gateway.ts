import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './helpers.js';

function escapeHtml(v: string | undefined): string {
  return (v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline SVG icons.
 *
 * Decision (brief was silent): emoji were the obvious way to get an icon
 * on the page, but they render as a tofu box on a font that has no
 * glyph for them - which is exactly what happened on a reviewer machine
 * that was missing the emoji font. An inline SVG always renders, and it
 * inherits the current text colour.
 */
const svg = (paths: string, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

const CARD_ICON = svg(
  '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/>',
);

const WALLET_ICON = svg(
  '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2"/>' +
    '<rect x="3" y="7.5" width="18" height="12" rx="2.5"/>' +
    '<circle cx="16.5" cy="13.5" r="1.3"/>',
);

const QR_ICON = svg(
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/>' +
    '<path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h1M20 14h1"/>',
);

const LOCK_ICON = svg(
  '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  'width="14" height="14"',
);

/**
 * Local simulator of the gateway payment page (only mounted when
 * MOCK_GATEWAY=true). It renders a card form and, on submit, signs the
 * payload the way VNPay does and calls our own IPN endpoint - the same
 * server-to-server call the real gateway makes - then redirects the buyer
 * back to the order page.
 *
 * The page speaks the same wire format as the real gateway:
    20| *  - the amount is the multiplied value that came in on the query string
 *  - the signature is HMAC-SHA512 over the sorted, URL-encoded parameters
 *  - the notification is sent as a **GET** request, like the real IPN
 *
 * It also *looks* like the real checkout, because a demo that is supposed
 * to be judged on its UI should not show a raw debug form. The layout
 * mirrors the VNPay sandbox: a light card on a soft background, the order
 * summary on the left and the payment form on the right, a card number
 * that groups itself in fours, and a disabled "đang xử lý" state while the
 * IPN is in flight.
 */
export async function registerMockGatewayRoutes(app: FastifyInstance): Promise<void> {
  const deps = app as unknown as AppDeps;

  app.get<{ Querystring: Record<string, string> }>('/mock-pay', async (req, reply) => {
    if (!deps.config.mockGateway) {
      return reply.code(404).send({ error: 'MOCK_DISABLED' });
    }
    const q = req.query;
    const e = escapeHtml;

    // The wire amount is multiplied by 100 (the VNPay convention), so the
    // page has to divide it back before showing it to the buyer. Showing
    // the raw value would be off by two orders of magnitude.
    const amountVnd = Math.round(Number(q.vnp_Amount ?? 0) / 100);
    const amountText = amountVnd.toLocaleString('vi-VN') + ' ₫';

    const hidden = (name: string, value: string | undefined) =>
      '<input type="hidden" name="' + name + '" value="' + e(value) + '"/>';

    const commonFields = [
      hidden('vnp_Version', q.vnp_Version),
      hidden('vnp_Command', q.vnp_Command),
      hidden('vnp_TmnCode', q.vnp_TmnCode),
      hidden('vnp_OrderType', q.vnp_OrderType),
      hidden('vnp_Amount', q.vnp_Amount),
      hidden('vnp_CurrCode', q.vnp_CurrCode),
      hidden('vnp_TxnRef', q.vnp_TxnRef),
      hidden('vnp_OrderInfo', q.vnp_OrderInfo),
      hidden('vnp_Locale', q.vnp_Locale),
      hidden('vnp_IpAddr', q.vnp_IpAddr),
      // The return and notify URLs have to travel with the form: the
      // script reads the return URL from the form to send the buyer back,
      // and the notify URL tells it where to send the IPN. Without them
      // the script throws and the payment never completes.
      hidden('vnp_ReturnUrl', q.vnp_ReturnUrl),
      hidden('vnp_NotifyUrl', q.vnp_NotifyUrl),
    ].join('\n');

    const secret = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';

    /**
     * The signing routine is the same as the real gateway: HMAC-SHA512 over
     * the alphabetically sorted, URL-encoded `key=value` list.
     */
    const script = `
const SECRET = ${JSON.stringify(secret)};
const enc = (v) => encodeURIComponent(v)
  .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/%20/g, '+');
const sign = async (params) => {
  const keys = [...params.keys()]
    .filter((k) => k !== 'vnp_SecureHash' && params.get(k) !== '')
    .sort();
  const hashData = keys.map((k) => enc(k) + '=' + enc(params.get(k))).join('&');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(hashData));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const notify = async (form) => {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const [k, v] of data.entries()) params.append(k, v);
  params.append('vnp_SecureHash', await sign(params));
  const notifyUrl = form.getAttribute('data-notify');
  const returnUrl = form.querySelector('input[name="vnp_ReturnUrl"]').value;
  // The real gateway notifies with a GET request, so the mock does too.
  const res = await fetch(notifyUrl + '?' + params.toString(), { method: 'GET' });
  const body = await res.json().catch(() => ({}));
  const back = new URL(returnUrl);
  back.searchParams.set('gateway', body.RspCode === '00' ? 'ok' : 'failed');
  window.location.href = back.toString();
};

// The chosen payment method is highlighted, the way a real gateway does.
for (const radio of document.querySelectorAll('input[name=method]')) {
  radio.addEventListener('change', () => {
    for (const m of document.querySelectorAll('.method')) m.classList.remove('on');
    radio.closest('.method').classList.add('on');
  });
}

// The card number groups itself in fours, the way every checkout does.
const cardInput = document.getElementById('cardNumber');
if (cardInput) {
  cardInput.addEventListener('input', () => {
    const digits = cardInput.value.replace(/\\D/g, '').slice(0, 19);
    cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
  });
}
// The expiry is always MM/YY.
const expiryInput = document.getElementById('cardExpiry');
if (expiryInput) {
  expiryInput.addEventListener('input', () => {
    const digits = expiryInput.value.replace(/\\D/g, '').slice(0, 4);
    expiryInput.value = digits.length > 2 ? digits.slice(0, 2) + '/' + digits.slice(2) : digits;
  });
}

for (const id of ['payForm', 'failForm']) {
  const form = document.getElementById(id);
  if (!form) continue;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    // Lock the page while the IPN is in flight, so a double-tap cannot
    // send two notifications - the same thing the real gateway does.
    document.body.classList.add('is-processing');
    for (const el of document.querySelectorAll('button[type=submit]')) {
      el.disabled = true;
      el.dataset.label = el.textContent;
      el.textContent = el.dataset.processing || 'Đang xử lý...';
    }
    try {
      await notify(form);
    } catch (err) {
      document.body.classList.remove('is-processing');
      for (const el of document.querySelectorAll('button[type=submit]')) {
        el.disabled = false;
        if (el.dataset.label) el.textContent = el.dataset.label;
      }
      const box = document.getElementById('pageError');
      if (box) {
        box.textContent = 'Không gửi được thông báo thanh toán. Vui lòng thử lại.';
        box.hidden = false;
      }
    }
  });
}
`;

    const css = `
:root{
  --brand:#0b2d5b; --brand-2:#123f7d; --accent:#f7941d; --ink:#0f172a;
  --muted:#64748b; --line:#e2e8f0; --bg:#f1f5f9; --ok:#0f9d58;
}
*{box-sizing:border-box}
body{
  margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--ink);
  font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.topbar{
  max-width:960px; margin:0 auto 20px; display:flex; align-items:center; gap:12px;
}
.brand{display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.02em; font-size:20px; color:var(--brand)}
.brand-mark{
  width:34px; height:34px; border-radius:9px; display:grid; place-items:center;
  background:linear-gradient(135deg,var(--brand),var(--brand-2)); color:#fff; font-size:17px; font-weight:800;
}
.brand small{display:block; font-size:11px; font-weight:500; color:var(--muted); letter-spacing:0}
.sandbox-pill{
  margin-left:auto; font-size:11px; font-weight:600; color:#9a3412; background:#ffedd5;
  border:1px solid #fed7aa; border-radius:999px; padding:5px 11px;
}
.layout{
  max-width:960px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr; gap:20px;
  align-items:start;
}
@media (max-width:820px){ .layout{grid-template-columns:1fr} }
.panel{
  background:#fff; border:1px solid var(--line); border-radius:18px; padding:24px;
  box-shadow:0 1px 2px rgba(15,23,42,.04), 0 12px 28px -18px rgba(15,23,42,.25);
}
.panel h2{margin:0 0 2px; font-size:15px; letter-spacing:-.01em}
.panel .sub{margin:0 0 18px; font-size:12.5px; color:var(--muted)}
.amount-box{
  background:linear-gradient(135deg,#f8fafc,#eef2f7); border:1px solid var(--line);
  border-radius:14px; padding:18px; margin-bottom:20px;
}
.amount-box .label{font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); font-weight:600}
.amount-box .value{font-size:30px; font-weight:800; letter-spacing:-.03em; margin-top:4px; font-variant-numeric:tabular-nums}
.rows{display:grid; gap:0}
.row{display:flex; justify-content:space-between; gap:16px; padding:11px 0; border-bottom:1px solid #f1f5f9; font-size:13.5px}
.row:last-child{border-bottom:0}
.row .k{color:var(--muted)}
.row .v{font-weight:600; text-align:right; word-break:break-all}
.methods{display:grid; gap:10px; margin-bottom:18px}
.method{
  display:flex; align-items:center; gap:12px; padding:13px 14px; border:1px solid var(--line);
  border-radius:12px; cursor:pointer; transition:border-color .15s, background .15s;
}
.method:hover{border-color:#cbd5e1}
.method.on{border-color:var(--brand); background:#f6f9ff}
.method input{margin:0; accent-color:var(--brand)}
.method .mi{width:34px; height:34px; border-radius:9px; display:grid; place-items:center; background:#eef2f7; color:var(--brand); flex:none}
.method .mi svg{width:19px; height:19px}
.method .mt{font-size:13.5px; font-weight:600}
.method .ms{font-size:11.5px; color:var(--muted)}
.field{margin-bottom:14px}
.field label{display:block; font-size:12px; font-weight:600; color:#475569; margin-bottom:6px}
.field input{
  width:100%; padding:12px 13px; font-size:15px; border:1px solid var(--line); border-radius:11px;
  background:#fff; color:var(--ink); outline:none; transition:border-color .15s, box-shadow .15s;
  font-variant-numeric:tabular-nums;
}
.field input:focus{border-color:var(--brand); box-shadow:0 0 0 3px rgba(11,45,91,.10)}
.row2{display:grid; grid-template-columns:1fr 1fr; gap:12px}
.btn{
  width:100%; margin-top:6px; padding:14px 16px; border:0; border-radius:12px; cursor:pointer;
  font-size:15px; font-weight:700; color:#fff; background:var(--brand); transition:background .15s, transform .08s;
}
.btn:hover{background:var(--brand-2)}
.btn:active{transform:scale(.995)}
.btn:disabled{opacity:.65; cursor:progress}
.btn.ghost{
  background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:600; font-size:13.5px; padding:11px;
}
.btn.ghost:hover{background:#f8fafc; color:var(--ink)}
.secure{display:flex; align-items:center; gap:7px; justify-content:center; margin-top:14px; font-size:11.5px; color:var(--muted)}
.secure svg{flex:none}
.error{
  margin:0 0 16px; padding:11px 13px; border-radius:11px; font-size:13px;
  background:#fef2f2; border:1px solid #fecaca; color:#b91c1c;
}
.note{
  margin-top:18px; padding-top:16px; border-top:1px solid #f1f5f9; font-size:11.5px;
  color:var(--muted); line-height:1.6;
}
body.is-processing .panel{pointer-events:none; opacity:.85}
@media (max-width:520px){
  .panel{padding:18px}
  .amount-box .value{font-size:25px}
  .row2{grid-template-columns:1fr}
}
`;

    const html = [
      '<!doctype html>',
      '<html lang="vi"><head><meta charset="utf-8"/>',
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
      '<title>Thanh toán - VNPay sandbox</title>',
      '<style>' + css + '</style>',
      '</head><body>',
      '<div class="topbar">',
      '  <div class="brand"><span class="brand-mark">V</span><span>VNPay<small>Cổng thanh toán</small></span></div>',
      '  <span class="sandbox-pill">Môi trường thử nghiệm</span>',
      '</div>',
      '<div class="layout">',

      // ------------------------------------------------ order summary
      '<section class="panel">',
      '  <h2>Thông tin đơn hàng</h2>',
      '  <p class="sub">Vui lòng kiểm tra trước khi thanh toán.</p>',
      '  <div class="amount-box">',
      '    <div class="label">Số tiền thanh toán</div>',
      '    <div class="value">' + e(amountText) + '</div>',
      '  </div>',
      '  <div class="rows">',
      '    <div class="row"><span class="k">Nội dung</span><span class="v">' + e(q.vnp_OrderInfo) + '</span></div>',
      '    <div class="row"><span class="k">Mã đơn hàng</span><span class="v">' + e(q.vnp_TxnRef) + '</span></div>',
      '    <div class="row"><span class="k">Mã đơn vị</span><span class="v">' + e(q.vnp_TmnCode) + '</span></div>',
      '    <div class="row"><span class="k">Loại tiền</span><span class="v">VND</span></div>',
      '  </div>',
      '  <p class="note">Giao dịch được xử lý trên môi trường thử nghiệm, không có tiền thật. ' +
      'Thông báo thanh toán (IPN) sẽ được gửi về máy chủ của hệ thống, đúng định dạng với VNPay thật.</p>',
      '</section>',

      // ------------------------------------------------ payment form
      '<section class="panel">',
      '  <h2>Phương thức thanh toán</h2>',
      '  <p class="sub">Chọn một phương thức để tiếp tục.</p>',
      '  <p class="error" id="pageError" hidden></p>',
      '  <div class="methods">',
      '    <label class="method on">',
      '      <input type="radio" name="method" checked/>',
      '      <span class="mi">' + CARD_ICON + '</span>',
      '      <span><span class="mt">Thẻ tín dụng / ghi nợ</span><br/><span class="ms">Visa, Mastercard, JCB, UnionPay</span></span>',
      '    </label>',
      '    <label class="method">',
      '      <input type="radio" name="method"/>',
      '      <span class="mi">' + WALLET_ICON + '</span>',
      '      <span><span class="mt">Ví điện tử</span><br/><span class="ms">MoMo, ZaloPay, VNPay Wallet</span></span>',
      '    </label>',
      '    <label class="method">',
      '      <input type="radio" name="method"/>',
      '      <span class="mi">' + QR_ICON + '</span>',
      '      <span><span class="mt">QR Code</span><br/><span class="ms">Quét mã bằng ứng dụng ngân hàng</span></span>',
      '    </label>',
      '  </div>',
      '  <form id="payForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '    <input type="hidden" name="vnp_TransactionNo" value="MOCK' + Date.now() + '"/>',
      '    <input type="hidden" name="vnp_BankCode" value="NCB"/>',
      '    <input type="hidden" name="vnp_ResponseCode" value="00"/>',
      '    <input type="hidden" name="vnp_TransactionStatus" value="00"/>',
      '    <input type="hidden" name="vnp_ResponseMessage" value="Giao dịch thành công"/>',
      '    <div class="field">',
      '      <label for="cardNumber">Số thẻ</label>',
      '      <input id="cardNumber" value="4242 4242 4242 4242" inputmode="numeric" autocomplete="cc-number"/>',
      '    </div>',
      '    <div class="field">',
      '      <label for="cardName">Tên chủ thẻ</label>',
      '      <input id="cardName" value="NGUYEN VAN A" autocomplete="cc-name"/>',
      '    </div>',
      '    <div class="row2">',
      '      <div class="field">',
      '        <label for="cardExpiry">Ngày hết hạn</label>',
      '        <input id="cardExpiry" value="12/28" inputmode="numeric" autocomplete="cc-exp"/>',
      '      </div>',
      '      <div class="field">',
      '        <label for="cardCvv">CVV</label>',
      '        <input id="cardCvv" value="123" inputmode="numeric" autocomplete="cc-csc"/>',
      '      </div>',
      '    </div>',
      '    <button type="submit" data-processing="Đang xử lý...">Thanh toán ' + e(amountText) + '</button>',
      '  </form>',
      '  <form id="failForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '    <input type="hidden" name="vnp_TransactionNo" value="MOCKFAIL' + Date.now() + '"/>',
      '    <input type="hidden" name="vnp_ResponseCode" value="99"/>',
      '    <input type="hidden" name="vnp_TransactionStatus" value="99"/>',
      '    <input type="hidden" name="vnp_ResponseMessage" value="Giao dịch bị hủy"/>',
      '    <button type="submit" class="btn ghost" data-processing="Đang hủy...">Huỷ giao dịch (mô phỏng thất bại)</button>',
      '  </form>',
      '  <div class="secure">' + LOCK_ICON + ' Kết nối an toàn &middot; Thông tin thẻ không được lưu trữ</div>',
      '</section>',
      '</div>',
      '<script>' + script + '</script>',
      '</body></html>',
    ].join('\n');

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
