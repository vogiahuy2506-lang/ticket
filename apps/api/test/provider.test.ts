import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/payments/mock.js';
import { VnPayProvider } from '../src/payments/vnpay.js';

/**
 * The redirect request the app sends to the gateway.
 *
 * These tests exist because a missing parameter here is invisible locally:
 * the mock gateway does not need `vnp_NotifyUrl` (the app tells it where to
 * send the notification through a form attribute), so the whole test suite
 * stayed green while the *real* gateway would never have known where to
 * deliver the IPN - the payment would never be settled.
 */

const INPUT = {
  orderId: 'c8157c9f-5685-4e4b-952c-052449030545',
  amountVnd: 825_000,
  orderInfo: 'Thanh toán đơn hàng c8157c9f',
  clientIp: '127.0.0.1',
  returnUrl: 'http://localhost:3000/orders/c8157c9f-5685-4e4b-952c-052449030545',
  notifyUrl: 'https://tunnel.example/api/ipn/vnpay',
};

const VNPCAY_CONFIG = {
  vnpayUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  merchantCode: 'TESTMERCHANT',
  secretKey: 'test-secret',
  returnUrl: 'http://localhost:3000/orders/x',
  notifyUrl: 'https://tunnel.example/api/ipn/vnpay',
};

describe('VnPayProvider.createPayment', () => {
  it('sends the IPN callback address to the gateway', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    // Without this parameter VNPay has no way to deliver the notification,
    // so the order would stay PENDING_PAYMENT forever.
    expect(url.searchParams.get('vnp_NotifyUrl')).toBe(INPUT.notifyUrl);
  });

  it('sends the buyer return address', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    expect(url.searchParams.get('vnp_ReturnUrl')).toBe(INPUT.returnUrl);
  });

  it('sends every parameter the VNPay sample requires', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    for (const key of [
      'vnp_Version',
      'vnp_Command',
      'vnp_TmnCode',
      'vnp_Amount',
      'vnp_CurrCode',
      'vnp_TxnRef',
      'vnp_OrderInfo',
      'vnp_OrderType',
      'vnp_Locale',
      'vnp_ReturnUrl',
      'vnp_NotifyUrl',
      'vnp_IpAddr',
      'vnp_CreateDate',
      'vnp_ExpireDate',
      'vnp_SecureHash',
    ]) {
      expect(url.searchParams.has(key), `missing ${key}`).toBe(true);
    }
  });

  it('multiplies the amount by 100 and signs the request', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    expect(url.searchParams.get('vnp_Amount')).toBe('82500000');
    expect(url.searchParams.get('vnp_SecureHash')).toHaveLength(128);
    expect(url.searchParams.get('vnp_TxnRef')).toBe(INPUT.orderId);
  });
});

describe('the two providers send the same contract', () => {
  it('both carry the notify url, so the mock cannot hide a missing one', async () => {
    const real = await new VnPayProvider(VNPCAY_CONFIG).createPayment(INPUT);
    const mock = await new MockProvider('http://localhost:3101').createPayment(INPUT);

    const realParams = new URL(real.redirectUrl).searchParams;
    const mockParams = new URL(mock.redirectUrl).searchParams;

    expect(realParams.get('vnp_NotifyUrl')).toBe(mockParams.get('vnp_NotifyUrl'));
    expect(realParams.get('vnp_Amount')).toBe(mockParams.get('vnp_Amount'));
    expect(realParams.get('vnp_ReturnUrl')).toBe(mockParams.get('vnp_ReturnUrl'));
  });
});
