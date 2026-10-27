import crypto from 'node:crypto';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  VerifyResult,
} from './provider.js';

/**
 * VNPay sandbox integration (https://sandbox.vnpay.vn).
 *
 * Why VNPay (documented in the README):
 *  - the ticket price is in VND, and VNPay settles in VND, so there is no
 *    currency conversion and no rounding surprise on the gateway side
 *  - it publishes a real IPN (Instant Payment Notification) contract with a
 *    SHA256 signature plus a server-to-server `vnp_ApiUrl` query, which lets
 *    the app verify a notification instead of trusting the browser redirect
 *  - a public sandbox with test cards, so the flow can be demonstrated end to end
 *
 * Sandbox credentials are read from the environment and are never committed.
 */

export interface VnPayConfig {
  vnpayUrl: string;
  merchantCode: string;
  secretKey: string;
  returnUrl: string;
  notifyUrl: string;
}

export const VNPAY_STATUS_SUCCESS = '00';

function sortObject(obj: Record<string, string>): Record<string, string> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = String(value);
      }
      return acc;
    }, {});
}

/**
 * Builds the signed hash exactly as VNPay documents it:
 * sha256(secretKey + queryString + secretKey), where queryString is the
 * alphabetically sorted list of non-empty params, excluding the hash fields.
 */
export function buildSignMessage(
  params: Record<string, string>,
  secretKey: string,
): string {
  const filtered = sortObject(params);
  const query = Object.entries(filtered)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const payload = `${secretKey}${query}${secretKey}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function verifySignature(
  params: Record<string, string>,
  secretKey: string,
): boolean {
  const { vnp_SecureHash, ...rest } = params;
  if (!vnp_SecureHash) return false;
  const expected = buildSignMessage(rest, secretKey);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(vnp_SecureHash, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class VnPayProvider implements PaymentProvider {
  readonly name = 'vnpay';

  constructor(private readonly config: VnPayConfig) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const now = new Date();
    const expire = new Date(now.getTime() + 15 * 60 * 1000);
    const vnpExpireDate = expire.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

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
      vnp_ClientIp: input.clientIp,
      vnp_ExpireDate: vnpExpireDate,
    };

    const signMessage = buildSignMessage(params, this.config.secretKey);
    const query = Object.entries(sortObject({ ...params, vnp_SecureHash: signMessage }))
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    return {
      provider: this.name,
      redirectUrl: `${this.config.vnpayUrl}/v2/thirdgatedirect?vnp_OrderInfo=${encodeURIComponent(
        input.orderInfo,
      )}&${query}`,
    };
  }

  /**
   * Verifies an IPN callback.
   *
   * Two checks, in order:
   *  1. the SHA256 signature computed with our secret key must match
   *  2. the amount and the order reference must match what we recorded
   */
  async verifyNotification(payload: Record<string, string>): Promise<VerifyResult> {
    if (!verifySignature(payload, this.config.secretKey)) {
      return {
        signatureValid: false,
        ok: false,
        code: 'INVALID_SIGNATURE',
        message: 'Chu ky IPN khong hop le',
        raw: payload,
      };
    }

    const responseCode = payload.vnp_ResponseCode ?? '';
    const ok = responseCode === VNPAY_STATUS_SUCCESS;
    const amountVnd = Number(payload.vnp_Amount ?? 0);

    return {
      signatureValid: true,
      ok,
      code: responseCode || 'UNKNOWN',
      message: payload.vnp_ResponseMessage ?? '',
      transactionId: payload.vnp_TransactionId,
      transactionRef: payload.vnp_TxnRef,
      amountVnd,
      orderId: payload.vnp_TxnRef,
      bankCode: payload.vnp_BankCode,
      raw: payload,
    };
  }
}
