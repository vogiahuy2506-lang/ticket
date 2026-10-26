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
    vnpay: { vnpayUrl: string; merchantCode: string; secretKey: string };
  };
}

export function providerFor(deps: AppDeps): PaymentProvider {
  if (deps.config.mockGateway) {
    // the simulated payment page is served by the API itself
    return new MockProvider(deps.config.publicBaseUrl);
  }
  return new VnPayProvider({
    vnpayUrl: deps.config.vnpay.vnpayUrl,
    merchantCode: deps.config.vnpay.merchantCode,
    secretKey: deps.config.vnpay.secretKey,
    returnUrl: `${deps.config.publicBaseUrl}/api/orders/return`,
    notifyUrl: `${deps.config.publicBaseUrl}/api/ipn/vnpay`,
  });
}
