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
  orderId: string;
  amountVnd: number;
  orderInfo: string;
  clientIp: string;
  returnUrl: string;
  notifyUrl: string;
}

export interface CreatePaymentResult {
  /** URL the buyer is redirected to. */
  redirectUrl: string;
  provider: string;
}

export interface VerifyResult {
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
   */
  queryTransaction?(orderId: string): Promise<VerifyResult | null>;
}
