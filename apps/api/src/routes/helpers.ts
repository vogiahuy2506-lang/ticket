import type { FastifyInstance } from 'fastify';
import { checkoutSchema, completeEventSchema, computeFees } from '@tce/shared';
import { MockProvider } from '../payments/mock.js';
import { VnPayProvider } from '../payments/vnpay.js';
import type { PaymentProvider } from '../payments/provider.js';
import {
  createOrder,
  getOrderStatus,
  handleIpn,
  OrderError,
  releaseEventEscrow,
} from '../services/orders.js';
import {
  auditLedger,
  computeBalances,
  getUserBalances,
  listTransactions,
} from '../services/ledger.js';

export interface AppDeps {
  sql: import('../db/types.js').Db;
  config: {
    publicBaseUrl: string;
    webBaseUrl: string;
    mockGateway: boolean;
    vnpay: {
      vnpayUrl: string;
      vnpayApiUrl: string;
      merchantCode: string;
      secretKey: string;
    };
  };
}

export function providerFor(deps: AppDeps): PaymentProvider {
  if (deps.config.mockGateway) {
    // the simulated payment page is served by the API itself
    return new MockProvider(deps.config.publicBaseUrl);
  }
  return new VnPayProvider({
    vnpayUrl: deps.config.vnpay.vnpayUrl,
    vnpayApiUrl: deps.config.vnpay.vnpayApiUrl,
    merchantCode: deps.config.vnpay.merchantCode,
    secretKey: deps.config.vnpay.secretKey,
    returnUrl: `${deps.config.publicBaseUrl}/api/orders/return`,
    // The IPN URL is *registered* in the merchant portal, not sent with
    // the payment. It is kept here so the operator can be shown the URL
    // that has to be registered.
    notifyUrl: `${deps.config.publicBaseUrl}/api/ipn/vnpay`,
  });
}
