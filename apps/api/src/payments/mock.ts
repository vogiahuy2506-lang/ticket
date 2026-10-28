import { toVnSafeText } from '@tce/shared';
import { signVnParams, signVnPipe } from './vnpay-crypto.js';
import { formatVnTime, QUERYDR_RESPONSE_HASH_FIELDS } from './vnpay.js';
import { findMockTransaction } from './mock-registry.js';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  QueryTransactionInput,
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
 * It deliberately uses the *same* wire format as the real gateway - the
 * amount is multiplied by 100, the signature is HMAC-SHA512 over the sorted
 * URL-encoded parameters, and the IPN comes in as a GET request - so the
 * application code that talks to the real sandbox is the same code that
 * talks to the mock. A mock with a different contract would hide bugs.
 *
 * The one thing the mock does *not* do is send a parameter the real gateway
 * does not accept. It used to send `vnp_NotifyUrl` in the query string
 * (the real gateway takes the notify address from the merchant portal, not
 * from the request), which is exactly the kind of drift that lets a mock
 * hide a gap. The notify address now travels as a form attribute only.
 *
 * Development aid only - it is not a payment gateway and it is listed in the
 * README under "not production ready".
 */

const MOCK_SECRET = process.env.MOCK_GATEWAY_SECRET ?? 'mock-secret-local-dev';

/** Same factor the real gateway uses on the wire. */
export const MOCK_AMOUNT_FACTOR = 100;

/**
 * HMAC-SHA512 over the alphabetically sorted, URL-encoded parameters -
 * byte for byte the same algorithm as the real gateway.
 */
export function sign(params: Record<string, string>): string {
  return signVnParams(params, MOCK_SECRET);
}

/**
 * The checksum of a `querydr` answer.
 *
 * The server-to-server API signs the *fixed* list of values joined by `|`,
 * not the sorted `key=value` list the `pay` request uses, so the mock has
 * to sign its answers the same way - otherwise the app would reject every
 * answer and the lost-IPN fallback could never work.
 */
export function signQueryResponse(payload: Record<string, string>): string {
  return signVnPipe(
    QUERYDR_RESPONSE_HASH_FIELDS.map((k) => payload[k] ?? ''),
    MOCK_SECRET,
  );
}

/**
 * The signed answer of the mock gateway, with the checksum attached.
 *
 * The checksum is signed the way the server-to-server API signs, so the
 * app verifies the answer with the same routine it uses for the real
 * gateway.
 */
export function signedQueryResponse(payload: Record<string, string>): Record<string, string> {
  return { ...payload, vnp_SecureHash: signQueryResponse(payload) };
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
    const created = input.createdAt ?? new Date();
    const expire = new Date(created.getTime() + 15 * 60 * 1000);

    const params: Record<string, string> = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: 'MOCKMRC',
      vnp_OrderType: 'other',
      vnp_Amount: String(input.amountVnd * MOCK_AMOUNT_FACTOR),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: input.gatewayRef,
      vnp_OrderInfo: toVnSafeText(input.orderInfo),
      vnp_Locale: 'vn',
      vnp_ReturnUrl: input.returnUrl,
      vnp_IpAddr: input.clientIp,
      // The dates are part of the real request, so the mock sends them
      // too: a mock with a smaller parameter set would let a missing
      // parameter slip through unnoticed.
      vnp_CreateDate: formatVnTime(created),
      vnp_ExpireDate: formatVnTime(expire),
    };
    const query = new URLSearchParams({ ...params, vnp_SecureHash: sign(params) });
    const base = new URL('/mock-pay', this.mockPayBaseUrl);
    base.search = query.toString();
    // The notify address travels under its own name, not as `vnp_NotifyUrl`:
    // the real gateway does not accept that parameter (the IPN URL is
    // registered in the merchant portal), and the whole point of the mock
    // is to have the same parameter set as the real thing. Without this the
    // mock would accept a request the real gateway would reject.
    base.searchParams.set('mock_notify', input.notifyUrl);
    return { provider: this.name, redirectUrl: base.toString() };
  }

  async verifyNotification(payload: Record<string, string>): Promise<VerifyResult> {
    const { vnp_SecureHash, ...rest } = payload;
    const expected = sign(rest);
    if (!vnp_SecureHash || expected !== vnp_SecureHash) {
      return {
        signatureValid: false,
        ok: false,
        code: '97',
        message: 'Chữ ký IPN không hợp lệ',
        raw: payload,
      };
    }
    const responseCode = payload.vnp_ResponseCode ?? '';
    const transactionStatus = payload.vnp_TransactionStatus ?? responseCode;
    const ok = responseCode === '00' && transactionStatus === '00';
    return {
      signatureValid: true,
      ok,
      code: responseCode || 'UNKNOWN',
      message: payload.vnp_ResponseMessage ?? '',
      transactionId: payload.vnp_TransactionNo ?? payload.vnp_TransactionId,
      transactionRef: payload.vnp_TxnRef,
      amountVnd: Math.round(Number(payload.vnp_Amount ?? 0) / MOCK_AMOUNT_FACTOR),
      orderId: payload.vnp_TxnRef,
      bankCode: payload.vnp_BankCode,
      raw: payload,
    };
  }

  /**
   * The mock gateway's answer to `querydr`.
   *
   * A real gateway remembers every payment it accepted and can be asked
   * about it later. The mock does the same - the payment page registers
   * the transaction with the gateway before it notifies the app, so if
   * that notification is lost the gateway still knows about the payment.
   *
   * Without this the lost-IPN fallback could not be exercised at all in
   * the default setup: the mock only existed inside the browser tab, so
   * there was nothing to ask, and the "check the status again" button was
   * a dead end.
   *
   * The answer follows the real contract: a payment the gateway does not
   * know is reported with code `91` ("not found"), and a known payment
   * carries its amount and transaction number. The checksum is signed the
   * `|`-joined way the server-to-server API uses, so the app verifies it
   * with the same routine it uses for the real gateway.
   */
  async queryTransaction(input: QueryTransactionInput): Promise<VerifyResult | null> {
    const txn = findMockTransaction(input.gatewayRef);

    if (!txn) {
      // "Không tìm thấy giao dịch yêu cầu" - the same code the real
      // gateway uses. It is *not* a failure: the payment may simply not
      // have reached the gateway yet.
      const payload: Record<string, string> = {
        vnp_ResponseId: `mock-${input.gatewayRef.slice(0, 8)}`,
        vnp_Command: 'querydr',
        vnp_ResponseCode: '91',
        vnp_Message: 'Khong tim thay giao dich yeu cau',
        vnp_TmnCode: 'MOCKMRC',
        vnp_TxnRef: input.gatewayRef,
        vnp_Amount: '0',
        vnp_BankCode: '',
        vnp_PayDate: '',
        vnp_TransactionNo: '',
        vnp_TransactionType: '',
        vnp_TransactionStatus: '',
        vnp_OrderInfo: '',
        vnp_PromotionCode: '',
        vnp_PromotionAmount: '',
      };
      return {
        signatureValid: true,
        ok: false,
        code: '91',
        message: payload.vnp_Message ?? '',
        transactionRef: input.gatewayRef,
        raw: signedQueryResponse(payload),
      };
    }

    const paid = txn.status === '00';
    const payload: Record<string, string> = {
      vnp_ResponseId: `mock-${input.gatewayRef.slice(0, 8)}`,
      vnp_Command: 'querydr',
      vnp_ResponseCode: '00',
      vnp_Message: 'QueryDR Success',
      vnp_TmnCode: 'MOCKMRC',
      vnp_TxnRef: txn.gatewayRef,
      vnp_Amount: String(txn.amountVnd * MOCK_AMOUNT_FACTOR),
      vnp_BankCode: 'NCB',
      vnp_PayDate: formatVnTime(txn.createdAt),
      vnp_TransactionNo: txn.transactionNo,
      vnp_TransactionType: '01',
      vnp_TransactionStatus: txn.status,
      vnp_OrderInfo: '',
      vnp_PromotionCode: '',
      vnp_PromotionAmount: '',
    };

    return {
      signatureValid: true,
      ok: paid,
      code: paid ? '00' : txn.status,
      message: payload.vnp_Message ?? '',
      transactionId: txn.transactionNo,
      transactionRef: txn.gatewayRef,
      amountVnd: txn.amountVnd,
      orderId: txn.gatewayRef,
      bankCode: 'NCB',
      raw: signedQueryResponse(payload),
    };
  }
}
