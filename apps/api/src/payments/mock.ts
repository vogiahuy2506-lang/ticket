import crypto from 'node:crypto';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  VerifyResult,
} from './provider.js';

/**
 * Local gateway simulator used when no real VNPay sandbox credentials are
 * configured (MOCK_GATEWAY=true).
 *
 * It mimics the VNPay contract closely enough to exercise the real code path
 * of the app: the buyer is redirected to a local payment page, and that page
 * posts back to the same IPN endpoint the real gateway would call, with a
 * correctly signed payload.
 *
 * Development aid only - it is not a payment gateway and it is listed in the
 * README under "not production ready".
 */

const MOCK_SECRET = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';

function sign(params: Record<string, string>): string {
  const filtered = Object.keys(params)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      const v = params[key];
      if (v !== undefined && v !== null && v !== '') acc[key] = String(v);
      return acc;
    }, {});
  const query = Object.entries(filtered)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return crypto
    .createHash('sha256')
    .update(`${MOCK_SECRET}${query}${MOCK_SECRET}`, 'utf8')
    .digest('hex');
}

export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  /**
   * @param mockPayBaseUrl base URL of the API, which serves the simulated
   *   payment page. It is separate from the buyer's return URL because the
   *   payment page lives on the backend, not on the storefront.
   */
  constructor(private readonly mockPayBaseUrl: string) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const params: Record<string, string> = {
      vnp_Version: '2.1',
      vnp_Command: 'pay',
      vnp_OrderType: 'other',
      vnp_Amount: String(input.amountVnd),
      vnp_Currency: 'VND',
      vnp_TxnRef: input.orderId,
      vnp_OrderInfo: input.orderInfo,
      vnp_ReturnUrl: input.returnUrl,
      vnp_NotifyUrl: input.notifyUrl,
    };
    const query = new URLSearchParams({ ...params, vnp_SecureHash: sign(params) });
    const base = new URL('/mock-pay', this.mockPayBaseUrl);
    base.search = query.toString();
    return { provider: this.name, redirectUrl: base.toString() };
  }

  async verifyNotification(payload: Record<string, string>): Promise<VerifyResult> {
    const { vnp_SecureHash, ...rest } = payload;
    const expected = sign(rest);
    if (!vnp_SecureHash || expected !== vnp_SecureHash) {
      return {
        signatureValid: false,
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Chu ky IPN khong hop le',
        raw: payload,
      };
    }
    const ok = payload.vnp_ResponseCode === '00';
    return {
      signatureValid: true,
      ok,
      code: payload.vnp_ResponseCode ?? 'UNKNOWN',
      message: payload.vnp_ResponseMessage ?? '',
      transactionId: payload.vnp_TransactionId,
      transactionRef: payload.vnp_TxnRef,
      amountVnd: Number(payload.vnp_Amount ?? 0),
      orderId: payload.vnp_TxnRef,
      bankCode: payload.vnp_BankCode,
      raw: payload,
    };
  }
}
