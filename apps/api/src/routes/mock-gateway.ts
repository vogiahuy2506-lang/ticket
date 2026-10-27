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
 * Local simulator of the gateway payment page (only mounted when
 * MOCK_GATEWAY=true). It renders a fake card form and, on submit, signs the
 * payload the way VNPay does and calls our own IPN endpoint - the same
 * server-to-server call the real gateway makes - then redirects the buyer
 * back to the order page.
 *
 * The page speaks the same wire format as the real gateway:
 *  - the amount is the multiplied value that came in on the query string
 *  - the signature is HMAC-SHA512 over the sorted, URL-encoded parameters
 *  - the notification is sent as a **GET** request, like the real IPN
 */
export async function registerMockGatewayRoutes(app: FastifyInstance): Promise<void> {
  const deps = app as unknown as AppDeps;

  app.get<{ Querystring: Record<string, string> }>('/mock-pay', async (req, reply) => {
    if (!deps.config.mockGateway) {
      return reply.code(404).send({ error: 'MOCK_DISABLED' });
    }
    const q = req.query;
    const e = escapeHtml;

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
for (const id of ['payForm', 'failForm']) {
  document.getElementById(id).addEventListener('submit', function (e) {
    e.preventDefault();
    notify(e.target);
  });
}
`;

    const html = [
      '<!doctype html>',
      '<html lang="vi"><head><meta charset="utf-8"/>',
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
      '<title>Cong thanh toan (gia lap)</title>',
      '<style>',
      ' body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px}',
      ' .card{max-width:420px;margin:24px auto;background:#1e293b;border-radius:16px;padding:20px}',
      ' h1{font-size:18px;margin:0 0 4px} .amount{font-size:28px;font-weight:700;margin:8px 0 16px}',
      ' label{display:block;font-size:13px;margin:12px 0 4px;color:#94a3b8}',
      ' input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px}',
      ' button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:12px;background:#22c55e;color:#052e16;font-weight:700;font-size:16px}',
      ' .hint{font-size:12px;color:#94a3b8;margin-top:12px;line-height:1.5}',
      ' .secondary{background:#ef4444;color:#450a0a;margin-top:10px}',
      '</style></head><body>',
      '<div class="card">',
      '  <h1>VNPay sandbox (gia lap noi bo)</h1>',
      '  <div class="amount">' + e(q.vnp_Amount) + '</div>',
      '  <div class="hint">Don hang: ' + e(q.vnp_TxnRef) + '</div>',
      '  <form id="payForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '    <input type="hidden" name="vnp_TransactionNo" value="MOCK' + Date.now() + '"/>',
      '    <input type="hidden" name="vnp_BankCode" value="NCB"/>',
      '    <input type="hidden" name="vnp_ResponseCode" value="00"/>',
      '    <input type="hidden" name="vnp_TransactionStatus" value="00"/>',
      '    <input type="hidden" name="vnp_ResponseMessage" value="Giao dich thanh cong"/>',
      '    <label>So the</label><input value="4242424242424242" inputmode="numeric"/>',
      '    <label>Ngay het han</label><input value="12/28" inputmode="numeric"/>',
      '    <label>CVV</label><input value="123" inputmode="numeric"/>',
      '    <button type="submit">Thanh toan ' + e(q.vnp_Amount) + '</button>',
      '  </form>',
      '  <form id="failForm" method="post" data-notify="' + e(q.vnp_NotifyUrl) + '">',
      commonFields,
      '    <input type="hidden" name="vnp_TransactionNo" value="MOCKFAIL' + Date.now() + '"/>',
      '    <input type="hidden" name="vnp_ResponseCode" value="99"/>',
      '    <input type="hidden" name="vnp_TransactionStatus" value="99"/>',
      '    <input type="hidden" name="vnp_ResponseMessage" value="Giao dich bi huy"/>',
      '    <button type="submit" class="secondary">Thanh toan that bai (mo phong)</button>',
      '  </form>',
      '  <p class="hint">Day la cong gia lap chi dung cho dev. Khi bam, trang se gui mot IPN',
      '  co chu ky hop le toi chinh endpoint IPN cua ung dung, dung dinh dang voi VNPay that.</p>',
      '</div>',
      '<script>' + script + '</script>',
      '</body></html>',
    ].join('\n');

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
