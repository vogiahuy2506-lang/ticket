/**
 * Payment provider abstraction.
 *
 * Two implementations:
 *  - VnPayProvider  - the real sandbox gateway (sandbox.vnpay.vn)
 *  - MockProvider   - a local simulator that mimics the redirect + IPN flow,
 *                     used so the app can be run and demoed without real
 *                     sandbox credentials. NOT production-ready, and clearly
 *                     flagged as such in the README.
 */

export interface CreatePaymentInput {
  /** our own order id (a UUID) */
  orderId: string;
  /**
   * The reference that is sent to the gateway as `vnp_TxnRef`.
   *
   * It has to be alphanumeric, so it is the order id without its dashes.
   * The incoming notification carries this reference, and it is what the
   * order is matched on.
   */
  gatewayRef: string;
  amountVnd: number;
  orderInfo: string;
  /** the buyer's IP address, in the shape the gateway accepts */
  clientIp: string;
  returnUrl: string;
  /**
   * The IPN endpoint.
   *
   * The real gateway does NOT accept this as a request parameter - the IPN
   * URL is registered once in the merchant portal. The field is kept so
   * the local mock can be told where to send its notification, and so the
   * operator can be shown the URL that has to be registered.
   */
  notifyUrl: string;
}

export interface CreatePaymentResult {
  /** URL the buyer is redirected to. */
  redirectUrl: string;
  provider: string;
}

export interface VerifyResult {
  /**
   * True when the gateway's signature matched our secret key.
   *
   * This is deliberately separate from `ok`: `ok` means "the payment
   * succeeded" (VNPay response code 00). A declined payment is a *valid*
   * notification that must still be applied - the order is marked FAILED
   * and the reserved tickets are given back. Only a bad signature means
   * "this notification is not trustworthy, drop it".
   */
  signatureValid: boolean;
  /** true when the payment succeeded (response code 00) */
  ok: boolean;
  code: string;
  message: string;
  transactionId?: string;
  transactionRef?: string;
  amountVnd?: number;
  orderId?: string;
  bankCode?: string;
  /** raw gateway payload, stored on the payment row for audit */
  raw: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Validates the gateway notification (signature + amount + order) */
  verifyNotification(payload: Record<string, string>): Promise<VerifyResult>;
  /**
   * Optional: query the gateway for the authoritative status of a
   * transaction (used by the "re-check" button when the buyer returns
   * before the IPN has arrived).
   *
   * It is the `querydr` API. It matters because an IPN can be lost: the
   * buyer's browser comes back but the server-to-server notification never
   * arrives, and without a second source the order would wait for the
   * reservation to expire even though the buyer had paid.
   */
  queryTransaction?(gatewayRef: string): Promise<VerifyResult | null>;
}
