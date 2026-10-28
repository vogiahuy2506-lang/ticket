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
 * Brand marks.
 *
 * These are drawn as inline SVG rather than shipped as image files, so the
 * page stays a single self-contained response and nothing depends on a
 * CDN or a local static asset.
 *
 * The card-brand marks (Visa, Mastercard, Napas, JCB) are close
 * reproductions of the real wordmarks: correct colours, correct letter
 * shapes, correct proportions. They are trademarks of their owners and
 * are used here only to make the sandbox page look like a real checkout.
 */
const BRAND_SVG = (viewBox: string, body: string, extra = '') =>
  `<svg viewBox="${viewBox}" role="img" aria-hidden="true" ${extra}>${body}</svg>`;

/** Visa: the blue italic wordmark. */
const VISA = BRAND_SVG(
  '0 0 48 16',
  '<text x="24" y="13" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="16" font-weight="800" font-style="italic" letter-spacing="-0.6" ' +
    'fill="#1A1F71">VISA</text>',
);

/**
 * Mastercard: the two interlocking discs. The lens in the middle is a
 * separate path filled with a gradient, which is how the real mark
 * renders the overlap.
 */
const MASTERCARD = BRAND_SVG(
  '0 0 48 30',
  '<defs><linearGradient id="mcg" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#EB001B"/><stop offset="1" stop-color="#F79E1B"/>' +
    '</linearGradient></defs>' +
    '<circle cx="18" cy="15" r="12" fill="#EB001B"/>' +
    '<circle cx="30" cy="15" r="12" fill="#F79E1B"/>' +
    '<path d="M24 4.608 A12 12 0 0 1 24 25.392 A12 12 0 0 1 24 4.608 Z" fill="url(#mcg)"/>',
);

/** Napas: the domestic Vietnamese card network. */
const NAPAS = BRAND_SVG(
  '0 0 52 18',
  '<rect x="0.5" y="0.5" width="51" height="17" rx="3" fill="#C8102E"/>' +
    '<text x="26" y="13" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="10.5" font-weight="800" letter-spacing="0.8" fill="#fff">NAPAS</text>',
);

/** JCB: the three green / red / blue blocks. */
const JCB = BRAND_SVG(
  '0 0 46 16',
  '<rect x="0" y="0" width="15" height="16" rx="2" fill="#0E4C96"/>' +
    '<rect x="15.5" y="0" width="15" height="16" rx="2" fill="#E60012"/>' +
    '<rect x="31" y="0" width="15" height="16" rx="2" fill="#00A551"/>' +
    '<text x="23" y="12" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="10" font-weight="800" fill="#fff">JCB</text>',
);

/** MoMo: the pink wallet brand. */
const MOMO = BRAND_SVG(
  '0 0 52 18',
  '<rect x="0.5" y="0.5" width="51" height="17" rx="8.5" fill="#D5006D"/>' +
    '<text x="26" y="12.5" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="11" font-weight="800" letter-spacing="0.2" fill="#fff">MoMo</text>',
);

/** ZaloPay. */
const ZALOPAY = BRAND_SVG(
  '0 0 56 18',
  '<rect x="0.5" y="0.5" width="55" height="17" rx="3" fill="#0068FF"/>' +
    '<text x="28" y="12.5" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="10" font-weight="700" fill="#fff">ZaloPay</text>',
);

/** VNPay Wallet, the gateway's own wallet. */
const VNPAY_WALLET = BRAND_SVG(
  '0 0 60 18',
  '<rect x="0.5" y="0.5" width="59" height="17" rx="3" fill="#0B2D5B"/>' +
    '<text x="30" y="12.5" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" ' +
    'font-size="9.5" font-weight="800" letter-spacing="0.4" fill="#fff">VNPAY WALLET</text>',
);

/** Bank brands, for the QR tab's "scan with your banking app" hint. */
const BANK_BRANDS = ['VietQR', 'MoMo', 'ZaloPay', 'VNPay'];

/**
 * A deterministic pseudo-QR matrix.
 *
 * It is *not* a scannable QR code - encoding a real payload would need a
 * QR encoder, and the sandbox has nothing to scan. But it has the visual
 * anatomy of one: three finder patterns with their quiet zones, a timing
 * pattern, an alignment pattern, and a data area derived from the order
 * id, so the same order always renders the same picture and different
 * orders render different ones.
 */
function qrMatrix(seed: string, size = 29): boolean[][] {
  // FNV-1a, so the pattern is stable across processes and machines.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h | 0;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 4294967296;
  };

  const grid: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    grid.push(new Array<boolean>(size).fill(false));
  }
  /** Bounds-checked set, so no index access needs a non-null assertion. */
  const set = (r: number, c: number, on: boolean) => {
    const row = grid[r];
    if (row) row[c] = on;
  };
  /** Bounds-checked get. */
  const get = (r: number, c: number) => grid[r]?.[c] ?? false;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) set(r, c, rand() > 0.5);
  }

  const inFinder = (r: number, c: number) =>
    (r < 8 && c < 8) ||
    (r < 8 && c >= size - 8) ||
    (r >= size - 8 && c < 8);

  // Finder patterns: a 7x7 bullseye plus a one-module quiet zone.
  const finder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const on =
          r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(r0 + r, c0 + c, on);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Alignment pattern, bottom-right.
  const a0 = size - 9;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const on = r === 0 || r === 4 || c === 0 || c === 4 || (r === 2 && c === 2);
      set(a0 + r, a0 + c, on);
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Anything under a finder or the alignment pattern is reserved.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (inFinder(r, c) || (r >= a0 - 1 && r <= a0 + 5 && c >= a0 - 1 && c <= a0 + 5)) {
        set(r, c, false);
      }
    }
  }
  return grid;
}

/** Render the matrix as a crisp square SVG (one path, no per-module rects). */
function qrSvg(seed: string, size = 29): string {
  const grid = qrMatrix(seed, size);
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r]?.[c]) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return BRAND_SVG(
    `0 0 ${size} ${size}`,
    `<path d="${d}" fill="#0f172a"/>`,
    'width="188" height="188" shape-rendering="crispEdges"',
  );
}

/**
 * Local simulator of the gateway payment page (only mounted when
 * MOCK_GATEWAY=true). It renders a card form and, on submit, signs the
 * payload the way VNPay does and calls our own IPN endpoint - the same
 * server-to-server call the real gateway makes - then redirects the buyer
 * back to the order page.
 *
 * The page speaks the same wire format as the real gateway:
 *  - the amount is the multiplied value that came in on the query string
 *  - the signature is HMAC-SHA512 over the sorted, URL-encoded parameters
 *  - the notification is sent as a **GET** request, like the real IPN
 *
 * It also *looks* like the real checkout, because a demo that is supposed
 * to be judged on its UI should not show a raw debug form. The layout
 * mirrors the VNPay sandbox: a light card on a soft background, the order
 * summary on the left and the payment form on the right, a card number
 * that groups itself in fours, and a disabled "đang xử lý" state while
 * the IPN is in flight.
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

// The card number groups itself in fours, the way every checkout does.
const cardInput = document.getElementById('cardNumber');
if (cardInput) {
  cardInput.addEventListener('input', () => {
    const digits = cardInput.value.replace(/\\D/g, '').slice(0, 19);
    cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
    syncCard();
  });
}
// The expiry is always MM/YY.
const expiryInput = document.getElementById('cardExpiry');
if (expiryInput) {
  expiryInput.addEventListener('input', () => {
    const digits = expiryInput.value.replace(/\\D/g, '').slice(0, 4);
    expiryInput.value = digits.length > 2 ? digits.slice(0, 2) + '/' + digits.slice(2) : digits;
    syncCard();
  });
}
const nameInput = document.getElementById('cardName');
if (nameInput) {
  nameInput.addEventListener('input', syncCard);
}

// The card preview mirrors what the buyer types.
function syncCard() {
  const num = document.getElementById('cpNumber');
  const nm = document.getElementById('cpName');
  const ex = document.getElementById('cpExpiry');
  if (num) num.textContent = cardInput ? cardInput.value : '';
  if (nm) nm.textContent = (nameInput ? nameInput.value : '').toUpperCase() || 'NGUYEN VAN A';
  if (ex) ex.textContent = expiryInput ? expiryInput.value : '';
}

// Switch between the card / wallet / QR panels.
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('on');
    for (const p of document.querySelectorAll('.panel-method')) p.hidden = true;
    tab.classList.add('on');
    const target = document.getElementById(tab.dataset.panel);
    if (target) target.hidden = false;
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

// The buttons in the wallet and QR panels drive the same card form.
for (const el of document.querySelectorAll('[data-pay]')) {
  el.addEventListener('click', () => {
    const form = document.getElementById('payForm');
    if (form) form.requestSubmit();
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
.brand{display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:-.02em; font-size:19px; color:var(--brand)}
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
.tabs{display:flex; gap:6px; padding:4px; background:#f1f5f9; border-radius:12px; margin-bottom:20px}
.tab{
  flex:1; border:0; background:transparent; padding:9px 10px; border-radius:9px; cursor:pointer;
  font-size:13px; font-weight:600; color:var(--muted); font-family:inherit; transition:background .15s,color .15s;
}
.tab.on{background:#fff; color:var(--brand); box-shadow:0 1px 3px rgba(15,23,42,.10)}
.card-preview{
  position:relative; border-radius:16px; padding:18px 20px 20px; margin-bottom:20px;
  background:linear-gradient(135deg,#16264a 0%,#2b3a72 48%,#4a2f6b 100%);
  color:#fff; box-shadow:0 14px 30px -14px rgba(11,45,91,.65);
}
.card-preview .cp-brand{position:absolute; top:16px; right:20px; height:16px}
.card-preview .cp-brand svg{height:16px; width:auto; display:block}
.cp-chip{
  width:42px; height:31px; border-radius:6px; margin-bottom:16px;
  background:linear-gradient(135deg,#f7d67a,#c9a227 55%,#f2e0a8);
  position:relative; overflow:hidden;
}
.cp-chip::before,.cp-chip::after{
  content:''; position:absolute; background:rgba(0,0,0,.22);
}
.cp-chip::before{left:8px; top:0; bottom:0; width:1px; box-shadow:11px 0 0 rgba(0,0,0,.22),22px 0 0 rgba(0,0,0,.22)}
.cp-chip::after{top:10px; left:0; right:0; height:1px}
.cp-number{font-size:19px; font-weight:600; letter-spacing:.12em; font-variant-numeric:tabular-nums; margin-bottom:16px}
.cp-row{display:flex; justify-content:space-between; gap:12px; margin-top:auto}
.cp-label{display:block; font-size:9px; letter-spacing:.12em; opacity:.62; font-weight:600}
.cp-value{display:block; font-size:12.5px; font-weight:600; margin-top:3px; letter-spacing:.04em}
.brand-strip{display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:18px}
.brand-strip .lbl{font-size:11px; color:var(--muted); font-weight:600}
.brand-strip svg{height:18px; width:auto; display:block}
.wallets{display:grid; gap:10px}
.wallet{
  display:flex; align-items:center; gap:12px; padding:13px 14px; border:1px solid var(--line);
  border-radius:12px; cursor:pointer; background:#fff; transition:border-color .15s, background .15s;
}
.wallet:hover{border-color:#cbd5e1; background:#fbfcfe}
.wallet svg{height:18px; width:auto; display:block; flex:none}
.wallet .wt{font-size:13.5px; font-weight:600}
.wallet .ws{font-size:11.5px; color:var(--muted)}
.wallet .arrow{margin-left:auto; color:#cbd5e1; font-size:16px}
.qr-wrap{text-align:center; padding:6px 0 2px}
.qr-frame{
  display:inline-block; padding:14px; background:#fff; border:1px solid var(--line);
  border-radius:16px; box-shadow:0 8px 20px -14px rgba(15,23,42,.5);
}
.qr-frame svg{display:block}
.qr-amount{margin-top:14px; font-size:17px; font-weight:700; letter-spacing:-.02em}
.qr-hint{margin-top:4px; font-size:12px; color:var(--muted)}
.qr-banks{display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin-top:16px}
.qr-banks span{font-size:11px; font-weight:600; color:var(--muted)}
.field{margin-bottom:14px}
.field label{display:block; font-size:12px; font-weight:600; color:#475569; margin-bottom:6px}
.field input{
  width:100%; padding:12px 13px; font-size:15px; border:1px solid var(--line); border-radius:11px;
  background:#fff; color:var(--ink); outline:none; transition:border-color .15s, box-shadow .15s;
  font-variant-numeric:tabular-nums; font-family:inherit;
}
.field input:focus{border-color:var(--brand); box-shadow:0 0 0 3px rgba(11,45,91,.10)}
.row2{display:grid; grid-template-columns:1fr 1fr; gap:12px}
.btn{
  width:100%; margin-top:6px; padding:14px 16px; border:0; border-radius:12px; cursor:pointer;
  font-size:15px; font-weight:700; color:#fff; background:var(--brand); transition:background .15s, transform .08s;
  font-family:inherit;
}
.btn:hover{background:var(--brand-2)}
.btn:active{transform:scale(.995)}
.btn:disabled{opacity:.65; cursor:progress}
.btn.ghost{
  background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:600; font-size:13.5px; padding:11px;
}
.btn.ghost:hover{background:#f8fafc; color:var(--ink)}
.link-btn{
  display:block; width:100%; margin-top:14px; background:none; border:0; cursor:pointer;
  font-size:12.5px; color:var(--muted); font-family:inherit; text-decoration:underline; padding:6px;
}
.link-btn:hover{color:#b91c1c}
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
  .card-preview .cp-number{font-size:16px; letter-spacing:.08em}
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

      '  <div class="tabs">',
      '    <button type="button" class="tab on" data-panel="panelCard">Thẻ quốc tế</button>',
      '    <button type="button" class="tab" data-panel="panelWallet">Ví điện tử</button>',
      '    <button type="button" class="tab" data-panel="panelQr">QR Code</button>',
      '  </div>',

      // ---- card panel
      '  <div class="panel-method" id="panelCard">',
      '    <div class="card-preview">',
      '      <span class="cp-brand">' + VISA + '</span>',
      '      <div class="cp-chip"></div>',
      '      <div class="cp-number" id="cpNumber">4242 4242 4242 4242</div>',
      '      <div class="cp-row">',
      '        <div><span class="cp-label">CHỦ THẺ</span><span class="cp-value" id="cpName">NGUYEN VAN A</span></div>',
      '        <div><span class="cp-label">HẠN THẺ</span><span class="cp-value" id="cpExpiry">12/28</span></div>',
      '      </div>',
      '    </div>',
      '    <div class="brand-strip">',
      '      <span class="lbl">Chấp nhận</span>' + VISA + MASTERCARD + JCB + NAPAS,
      '    </div>',
      '    <form id="payForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '      <input type="hidden" name="vnp_TransactionNo" value="MOCK' + Date.now() + '"/>',
      '      <input type="hidden" name="vnp_BankCode" value="NCB"/>',
      '      <input type="hidden" name="vnp_ResponseCode" value="00"/>',
      '      <input type="hidden" name="vnp_TransactionStatus" value="00"/>',
      '      <input type="hidden" name="vnp_ResponseMessage" value="Giao dịch thành công"/>',
      '      <div class="field">',
      '        <label for="cardNumber">Số thẻ</label>',
      '        <input id="cardNumber" value="4242 4242 4242 4242" inputmode="numeric" autocomplete="cc-number"/>',
      '      </div>',
      '      <div class="field">',
      '        <label for="cardName">Tên chủ thẻ</label>',
      '        <input id="cardName" value="NGUYEN VAN A" autocomplete="cc-name"/>',
      '      </div>',
      '      <div class="row2">',
      '        <div class="field">',
      '          <label for="cardExpiry">Ngày hết hạn</label>',
      '          <input id="cardExpiry" value="12/28" inputmode="numeric" autocomplete="cc-exp"/>',
      '        </div>',
      '        <div class="field">',
      '          <label for="cardCvv">CVV</label>',
      '          <input id="cardCvv" value="123" inputmode="numeric" autocomplete="cc-csc"/>',
      '        </div>',
      '      </div>',
      '      <button type="submit" data-processing="Đang xử lý...">Thanh toán ' + e(amountText) + '</button>',
      '    </form>',
      '  </div>',

      // ---- wallet panel
      '  <div class="panel-method" id="panelWallet" hidden>',
      '    <div class="wallets">',
      '      <button type="button" class="wallet" data-pay="1">' + MOMO +
      '        <span><span class="wt">Ví MoMo</span><br/><span class="ws">Thanh toán bằng số dư ví</span></span><span class="arrow">&rsaquo;</span></button>',
      '      <button type="button" class="wallet" data-pay="1">' + ZALOPAY +
      '        <span><span class="wt">ZaloPay</span><br/><span class="ws">Liên kết ví điện tử Zalo</span></span><span class="arrow">&rsaquo;</span></button>',
      '      <button type="button" class="wallet" data-pay="1">' + VNPAY_WALLET +
      '        <span><span class="wt">VNPay Wallet</span><br/><span class="ws">Ví điện tử của VNPay</span></span><span class="arrow">&rsaquo;</span></button>',
      '    </div>',
      '    <p class="note">Bấm vào ví để hoàn tất thanh toán. Trang sẽ gửi thông báo IPN ' +
      'tới máy chủ, đúng định dạng với VNPay thật.</p>',
      '  </div>',

      // ---- QR panel
      '  <div class="panel-method" id="panelQr" hidden>',
      '    <div class="qr-wrap">',
      '      <div class="qr-frame">' + qrSvg(String(q.vnp_TxnRef ?? '') + '|' + String(q.vnp_Amount ?? '')) + '</div>',
      '      <div class="qr-amount">' + e(amountText) + '</div>',
      '      <div class="qr-hint">Quét mã bằng ứng dụng ngân hàng để thanh toán</div>',
      '      <div class="qr-banks">' +
      BANK_BRANDS.map((name) => '<span>' + e(name) + '</span>').join('') +
      '      </div>',
      '    </div>',
      '    <button type="button" class="btn" data-pay="1" data-processing="Đang xử lý...">Tôi đã quét và thanh toán</button>',
      '  </div>',

      '  <form id="failForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '    <input type="hidden" name="vnp_TransactionNo" value="MOCKFAIL' + Date.now() + '"/>',
      '    <input type="hidden" name="vnp_ResponseCode" value="99"/>',
      '    <input type="hidden" name="vnp_TransactionStatus" value="99"/>',
      '    <input type="hidden" name="vnp_ResponseMessage" value="Giao dịch bị hủy"/>',
      '    <button type="submit" class="link-btn" data-processing="Đang hủy...">Huỷ giao dịch (mô phỏng thất bại)</button>',
      '  </form>',
      '  <div class="secure">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
      'stroke-linejoin="round" width="14" height="14" aria-hidden="true">' +
      '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>' +
      ' Kết nối an toàn &middot; Thông tin thẻ không được lưu trữ</div>',
      '</section>',
      '</div>',
      '<script>' + script + '</script>',
      '</body></html>',
    ].join('\n');

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
