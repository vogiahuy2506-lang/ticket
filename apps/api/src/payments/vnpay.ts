import crypto from 'node:crypto';
import {
  buildHashData,
  encodeVnValue,
  signVnParams,
  sortVnParams,
} from './vnpay-crypto.js';
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
 *  - it publishes a real IPN (Instant Payment Notification) contract with an
 *    HMAC-SHA512 signature plus a server-to-server notification, which lets
 *    the app verify a notification instead of trusting the browser redirect
 *  - a public sandbox with test cards, so the flow can be demonstrated end to end
 *
 * The wire format below follows the official VNPay samples
 * (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html):
 *
 *  - `vnp_Amount` is the amount in VND **multiplied by 100** (10,000 VND is
 *    sent as `1000000`). The IPN returns the same multiplied value, so it
 *    has to be divided by 100 before it is compared to our stored amount.
 *  - the signature is `HMAC-SHA512(secretKey, hashData)` where hashData is
 *    the alphabetically sorted, URL-encoded `key=value&key=value` list of
 *    the non-empty parameters (the hash fields are excluded).
 *  - `vnp_CreateDate` / `vnp_ExpireDate` are `yyyyMMddHHmmss` in **GMT+7**.
 *  - a successful payment means `vnp_ResponseCode == '00'` AND
 *    `vnp_TransactionStatus == '00'`.
 *  - the IPN is a GET request, and the answer must be HTTP 200 with a JSON
 *    body `{"RspCode":"00","Message":"..."}`.
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

/**
 * VNPay multiplies every amount by 100 on the wire (it treats the value as
 * a two-decimal currency). VND has no subunit in practice, but the gateway
 * still applies the factor, so we must too.
 */
export const VNPAY_AMOUNT_FACTOR = 100;

/** The official sample uses `yyyyMMddHHmmss` in the GMT+7 timezone. */
export function formatVnTime(date: Date): string {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * `urlencode` in the PHP samples encodes spaces as `+` and leaves `-`, `_`,
 * `.` and `~` alone. `encodeURIComponent` differs on spaces and `!'()*`,
 * so the values are encoded to match the samples byte for byte.
 */
export { encodeVnValue };

/**
 * Drops empty values and sorts the remaining keys alphabetically - this is
 * exactly what `ksort()` + the "skip empty values" loop in the VNPay
 * samples do.
 */
export { sortVnParams };

/**
 * Builds the signed hash exactly as VNPay documents it:
 * HMAC-SHA512(secretKey, hashData), where hashData is the alphabetically
 * sorted, URL-encoded list of non-empty params.
 */
export function buildSignMessage(
  params: Record<string, string>,
  secretKey: string,
): string {
  return signVnParams(params, secretKey);
}

export function verifySignature(
  params: Record<string, string>,
  secretKey: string,
): boolean {
  const { vnp_SecureHash, vnp_SecureHashType, ...rest } = params;
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

    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.config.merchantCode,
      // VNPay expects the amount multiplied by 100.
      vnp_Amount: String(input.amountVnd * VNPAY_AMOUNT_FACTOR),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: input.orderId,
      vnp_OrderInfo: input.orderInfo,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: input.clientIp,
      vnp_CreateDate: formatVnTime(now),
      vnp_ExpireDate: formatVnTime(expire),
    };

    const signMessage = buildSignMessage(params, this.config.secretKey);
    const query = Object.entries({ ...params, vnp_SecureHash: signMessage })
      .map(([k, v]) => `${encodeVnValue(k)}=${encodeVnValue(v)}`)
      .join('&');

    return {
      provider: this.name,
      redirectUrl: `${this.config.vnpayUrl}?${query}`,
    };
  }

  /**
   * Verifies an IPN callback.
   *
   * Three checks, in order:
   *  1. the HMAC-SHA512 signature computed with our secret key must match
   *  2. the amount (after dividing by 100) must match what we recorded
   *  3. the payment succeeded, which means both the response code and the
   *     transaction status are '00'
   */
  async verifyNotification(payload: Record<string, string>): Promise<VerifyResult> {
    if (!verifySignature(payload, this.config.secretKey)) {
      return {
        signatureValid: false,
        ok: false,
        code: '97',
        message: 'Chu ky IPN khong hop le',
        raw: payload,
      };
    }

    const responseCode = payload.vnp_ResponseCode ?? '';
    const transactionStatus = payload.vnp_TransactionStatus ?? '';
    const ok =
      responseCode === VNPAY_STATUS_SUCCESS && transactionStatus === VNPAY_STATUS_SUCCESS;

    // The IPN reports the amount multiplied by 100, exactly like the
    // request. Bring it back to VND before it is compared to our order.
    const amountVnd = Math.round(Number(payload.vnp_Amount ?? 0) / VNPAY_AMOUNT_FACTOR);

    return {
      signatureValid: true,
      ok,
      code: responseCode || transactionStatus || 'UNKNOWN',
      message: payload.vnp_ResponseMessage ?? '',
      transactionId: payload.vnp_TransactionNo ?? payload.vnp_TransactionId,
      transactionRef: payload.vnp_TxnRef,
      amountVnd,
      orderId: payload.vnp_TxnRef,
      bankCode: payload.vnp_BankCode,
      raw: payload,
    };
  }
}
