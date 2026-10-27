import './env.js';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  publicBaseUrl: string;
  webBaseUrl: string;
  mockGateway: boolean;
  vnpay: {
    vnpayUrl: string;
    merchantCode: string;
    secretKey: string;
  };
}

export function loadConfig(): AppConfig {
  const publicBaseUrl = required(
    'PUBLIC_BASE_URL',
    'http://localhost:3101',
  ).replace(/\/$/, '');

  return {
    port: Number(process.env.PORT ?? 3101),
    databaseUrl: required(
      'DATABASE_URL',
      'postgres://postgres:postgres@localhost:5432/tickets',
    ),
    publicBaseUrl,
    webBaseUrl: (process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    ),
    mockGateway: process.env.MOCK_GATEWAY === 'true',
    vnpay: {
      // The payment page the buyer is redirected to. This is the endpoint
      // the official VNPay samples use.
      vnpayUrl:
        process.env.VNPAY_URL ??
        'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      merchantCode: process.env.VNPAY_MERCHANT_CODE ?? '',
      secretKey: process.env.VNPAY_SECRET_KEY ?? '',
    },
  };
}
