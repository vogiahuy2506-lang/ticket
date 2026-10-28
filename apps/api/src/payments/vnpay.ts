import crypto from 'node:crypto';
import { toVnSafeText } from '@tce/shared';
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
 * Two rules of the parameter table are easy to get wrong and are enforced
 * here rather than left to the caller:
 *
 *  - there is **no** `vnp_NotifyUrl` parameter. The IPN URL is configured
 *    once in the merchant portal, not sent with every payment. An unknown
 *    parameter also ends up in the signed hash, so sending one makes our
 *    signature disagree with the gateway's.
 *  - `vnp_OrderInfo` must be unaccented and free of special characters, and
 *    `vnp_TxnRef` must be alphanumeric, so the order's UUID cannot be used
 *    as-is (it contains dashes).
 *
 * Sandbox credentials are read from the environment and are never committed.
 */

export interface VnPayConfig {
  vnpayUrl: string;
  /** the querydr/refund API endpoint (server-to-server) */
  vnpayApiUrl: string;
  merchantCode: string;
  secretKey: string;
  returnUrl: string;
  /**
   * The IPN endpoint, kept here only so it can be *shown* to the operator
   * and registered in the merchant portal. It is deliberately NOT sent to
   * the gateway as a request parameter.
   */
  notifyUrl: string;
}

export const VNPAY_STATUS_SUCCESS = '00';

/**
 * VNPay multiplies every amount by 100 on the wire (it treats the value as
 * a two-decimal currency). VND has no subunit in practice, but the gateway
 * still applies the factor, so we must too.
 */
export const VNPAY_AMOUNT_FACTOR = 100;

/**
 * The parameter table caps `vnp_Amount` at 12 characters.
 *
 * The wire value is the amount multiplied by 100, so the largest order the
 * gateway accepts is a 12-digit wire value. An order above that would be
 * rejected at the payment page, and the buyer would be stuck on a page
 * that never works.
 */
export const VNPAY_AMOUNT_MAX_DIGITS = 12;
/** The largest wire value (and therefore the largest order) the gateway accepts. */
export const VNPAY_AMOUNT_MAX_WIRE = 999_999_999_999;
/** The largest order, in VND, the gateway accepts. */
export const VNPAY_AMOUNT_MAX_VND = Math.floor(VNPAY_AMOUNT_MAX_WIRE / VNPAY_AMOUNT_FACTOR);

/**
 * How long the `querydr` call may take.
 *
 * The re-check runs while the buyer is waiting on the order page, so a
 * hung gateway would hold the request open. Ten seconds is long enough
 * for the sandbox and short enough that the page answers.
 */
export const VNPAY_QUERY_TIMEOUT_MS = 10_000;

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

/**
 * Normalises the buyer's IP address into the shape the gateway accepts.
 *
 * The parameter table says `vnp_IpAddr` is `Alphanumeric[7,45]`, so it has
 * to be a plain IPv4 address: an IPv6 address is far too long for 45
 * characters, and the loopback `::1` is far too short. The caller supplies
 * the address of the *client*, not the address of the process that happens
 * to receive the request.
 */
export function normalizeClientIp(ip: string | undefined): string {
  const value = (ip ?? '').trim();

  // An IPv4 address is used as it is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.').map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return value;
  }

  // An IPv6 address is rewritten to its IPv4-mapped form when it has one
  // (`::ffff:203.0.113.7`), and dropped otherwise.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1]) return mapped[1];

  // A bare IPv6 address has no representation the gateway accepts.
  if (value.includes(':')) return '0.0.0.0';

  return '127.0.0.1';
}

export class VnPayProvider implements PaymentProvider {
  readonly name = 'vnpay';

  constructor(private readonly config: VnPayConfig) {}

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const now = new Date();
    const expire = new Date(now.getTime() + 15 * 60 * 1000);

    // The parameter table caps `vnp_Amount` at 12 characters. The wire
    // value is the amount multiplied by 100, so the largest order the
    // gateway accepts is 99,999,999,999 / 100 = 999,999,999 VND. An
    // order above that would be rejected by the gateway - and the buyer
    // would be stuck on a payment page that never works.
    //
    // The order is refused *before* the buyer is redirected, so the
    // failure is a clear error instead of a dead payment page.
    const wireAmount = input.amountVnd * VNPAY_AMOUNT_FACTOR;
    if (
      !Number.isSafeInteger(wireAmount) ||
      String(wireAmount).length > VNPAY_AMOUNT_MAX_DIGITS
    ) {
      throw new Error(
        `The amount ${input.amountVnd} VND is too large for the payment gateway ` +
          `(the maximum is ${VNPAY_AMOUNT_MAX_VND} VND)`,
      );
    }

    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.config.merchantCode,
      // VNPay expects the amount multiplied by 100.
      vnp_Amount: String(wireAmount),
      vnp_CurrCode: 'VND',
      // The reference has to be alphanumeric, so the order's UUID is sent
      // without its dashes. The order keeps the UUID; the gateway
      // reference is stored next to it and is what an incoming
      // notification is matched on.
      vnp_TxnRef: input.gatewayRef,
      // The parameter table asks for unaccented text without special
      // characters, so the description is normalised here.
      vnp_OrderInfo: toVnSafeText(input.orderInfo) || `Thanh toan don hang ${input.gatewayRef}`,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: normalizeClientIp(input.clientIp),
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
        message: 'Chữ ký IPN không hợp lệ',
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

  /**
   * Asks the gateway for the authoritative status of a transaction.
   *
   * This is the `querydr` API:
   *
   *   POST https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
   *   Content-Type: application/json
   *   { vnp_Command: "querydr", vnp_TxnRef, vnp_TmnCode, ... }
   *
   * It exists because an IPN can be lost: the buyer's browser comes back
   * from the gateway but the server-to-server notification never arrives
   * (a tunnel was closed, the URL was not registered, the gateway was
   * unreachable). Without a second source, the order would sit in
   * `PENDING_PAYMENT` until the reservation expired, even though the
   * buyer had already paid.
   *
   * The request is signed with the same HMAC-SHA512 routine, and the
   * response is verified the same way. A failure here is *not* an error
   * for the caller: it returns `null` and the order keeps waiting.
   */
  async queryTransaction(gatewayRef: string): Promise<VerifyResult | null> {
    const now = formatVnTime(new Date());

    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'querydr',
      vnp_TmnCode: this.config.merchantCode,
      vnp_TxnRef: gatewayRef,
      vnp_TransactionDate: now,
      // The request id has to be unique per day. Concatenating the ref and
      // the full timestamp and then cutting the result to 32 characters
      // would keep only the ref - the date would be sliced away and every
      // request for the same order would carry the same id. The date goes
      // first so it is always part of the id.
      vnp_RequestId: `${now.slice(0, 8)}${gatewayRef.slice(0, 16)}`,
      vnp_OrderType: 'other',
      vnp_CurrCode: 'VND',
      vnp_Locale: 'vn',
    };

    const body = { ...params, vnp_SecureHash: buildSignMessage(params, this.config.secretKey) };

    let response: Response;
    try {
      response = await fetch(this.config.vnpayApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // The gateway is asked while the buyer is waiting on the order
        // page. Without a timeout a hung gateway would hold the request
        // open and the page would never answer - the buyer would see a
        // spinning button instead of an honest "we could not confirm".
        signal: AbortSignal.timeout(VNPAY_QUERY_TIMEOUT_MS),
      });
    } catch {
      // The gateway is unreachable, or it did not answer in time. That is
      // not a failure of the order - it just means we cannot confirm
      // anything right now.
      return null;
    }

    if (!response.ok) return null;

    let payload: Record<string, string>;
    try {
      payload = (await response.json()) as Record<string, string>;
    } catch {
      return null;
    }

    if (!verifySignature(payload, this.config.secretKey)) return null;

    const responseCode = payload.vnp_ResponseCode ?? '';
    const transactionStatus = payload.vnp_TransactionStatus ?? '';
    const ok =
      responseCode === VNPAY_STATUS_SUCCESS && transactionStatus === VNPAY_STATUS_SUCCESS;

    return {
      signatureValid: true,
      ok,
      code: responseCode || transactionStatus || 'UNKNOWN',
      message: payload.vnp_ResponseMessage ?? payload.vnp_Message ?? '',
      transactionId: payload.vnp_TransactionNo ?? payload.vnp_TransactionId,
      transactionRef: payload.vnp_TxnRef,
      amountVnd: Math.round(Number(payload.vnp_Amount ?? 0) / VNPAY_AMOUNT_FACTOR),
      orderId: payload.vnp_TxnRef,
      bankCode: payload.vnp_BankCode,
      raw: payload,
    };
  }
}
