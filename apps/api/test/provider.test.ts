import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/payments/mock.js';
import { VnPayProvider, normalizeClientIp } from '../src/payments/vnpay.js';
import { toGatewayRef, toVnSafeText } from '@tce/shared';

/**
 * The redirect request the app sends to the gateway.
 *
 * These tests are checked against the *official parameter table*
 * (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), not
 * against the mock. That distinction is the whole point of this file.
 *
 * The previous version of this file asserted that the real provider and
 * the mock sent "the same parameter set". That was circular: it proved
 * the two agreed with each other, not that either of them matched the
 * gateway. It stayed green while the real provider sent `vnp_NotifyUrl`
 * - a parameter that does not exist in the VNPay specification.
 *
 * So the assertions below are the ones that matter:
 *  - every parameter we send is in the official table
 *  - every parameter respects its documented type and length
 *  - no parameter is sent that the table does not define
 */

const INPUT = {
  orderId: 'c8157c9f-5685-4e4b-952c-052449030545',
  gatewayRef: 'c8157c9f56854e4b952c052449030545',
  amountVnd: 825_000,
  orderInfo: 'Thanh toán đơn hàng c8157c9f',
  clientIp: '203.0.113.7',
  returnUrl: 'http://localhost:3000/orders/c8157c9f-5685-4e4b-952c-052449030545',
  notifyUrl: 'https://tunnel.example/api/ipn/vnpay',
};

const VNPCAY_CONFIG = {
  vnpayUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  vnpayApiUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
  merchantCode: 'TESTMRC',
  secretKey: 'test-secret',
  returnUrl: 'http://localhost:3000/orders/x',
  notifyUrl: 'https://tunnel.example/api/ipn/vnpay',
};

/**
 * The parameters of the `pay` request, exactly as the official table
 * defines them: name -> [type, max length, required].
 */
const OFFICIAL_PAY_PARAMS: Record<string, { max: number; required: boolean }> = {
  vnp_Version: { max: 8, required: true },
  vnp_Command: { max: 16, required: true },
  vnp_TmnCode: { max: 8, required: true },
  vnp_Amount: { max: 12, required: true },
  vnp_CurrCode: { max: 3, required: true },
  vnp_TxnRef: { max: 100, required: true },
  vnp_OrderInfo: { max: 255, required: true },
  vnp_OrderType: { max: 100, required: true },
  vnp_Locale: { max: 5, required: true },
  vnp_ReturnUrl: { max: 255, required: true },
  vnp_IpAddr: { max: 45, required: true },
  vnp_CreateDate: { max: 14, required: true },
  vnp_ExpireDate: { max: 14, required: true },
  vnp_SecureHash: { max: 256, required: true },
};

describe('VnPayProvider.createPayment', () => {
  it('sends only the parameters the official table defines', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    for (const key of url.searchParams.keys()) {
      expect(
        key in OFFICIAL_PAY_PARAMS,
        `"${key}" is not a parameter of the VNPay pay request`,
      ).toBe(true);
    }
  });

  it('does not send vnp_NotifyUrl, which is not part of the specification', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    // The IPN address is registered once in the merchant portal, not sent
    // with every payment. An unknown parameter also lands in the signed
    // hash, so sending one makes our signature disagree with the
    // gateway's.
    expect(url.searchParams.has('vnp_NotifyUrl')).toBe(false);
  });

  it('sends every required parameter', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    for (const [key, spec] of Object.entries(OFFICIAL_PAY_PARAMS)) {
      if (!spec.required) continue;
      expect(url.searchParams.has(key), `missing ${key}`).toBe(true);
    }
  });

  it('respects the documented length of every parameter', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    for (const [key, spec] of Object.entries(OFFICIAL_PAY_PARAMS)) {
      const value = url.searchParams.get(key);
      if (value === null) continue;
      expect(value.length, `${key} is too long`).toBeLessThanOrEqual(spec.max);
    }
  });

  it('sends an alphanumeric transaction reference', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    const ref = url.searchParams.get('vnp_TxnRef')!;
    // `vnp_TxnRef` is Alphanumeric[1,100]. A UUID has dashes, which are
    // not alphanumeric.
    expect(ref).toBe(INPUT.gatewayRef);
    expect(ref).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('sends an unaccented order description without special characters', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    const info = url.searchParams.get('vnp_OrderInfo')!;
    // "Tieng Viet khong dau va khong bao gom cac ky tu dac biet"
    expect(info).toMatch(/^[A-Za-z0-9 ]+$/);
    expect(info).not.toMatch(/[àáảãạăâđêôơư]/i);
  });

  it('sends an IPv4 address in the buyable shape', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    const ip = url.searchParams.get('vnp_IpAddr')!;
    // Alphanumeric[7,45]: `::1` is too short, an IPv6 address is too long.
    expect(ip.length).toBeGreaterThanOrEqual(7);
    expect(ip.length).toBeLessThanOrEqual(45);
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });

  it('sends the buyer return address', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    expect(url.searchParams.get('vnp_ReturnUrl')).toBe(INPUT.returnUrl);
  });

  it('multiplies the amount by 100 and signs the request', async () => {
    const provider = new VnPayProvider(VNPCAY_CONFIG);
    const { redirectUrl } = await provider.createPayment(INPUT);
    const url = new URL(redirectUrl);

    expect(url.searchParams.get('vnp_Amount')).toBe('82500000');
    expect(url.searchParams.get('vnp_SecureHash')).toHaveLength(128);
  });

  it('refuses an amount the gateway cannot accept', async () => {
    // `vnp_Amount` is capped at 12 characters. The wire value is the
    // amount multiplied by 100, so an order above ~10 billion VND would
    // be rejected at the payment page - and the buyer would sit on a
    // page that never works. The order is refused *before* the redirect.
    const provider = new VnPayProvider(VNPCAY_CONFIG);

    await expect(
      provider.createPayment({ ...INPUT, amountVnd: 1_000_000_000_000 }),
    ).rejects.toThrow(/too large/i);

    // The largest accepted amount still works.
    const ok = await provider.createPayment({ ...INPUT, amountVnd: 9_999_999_999 });
    const url = new URL(ok.redirectUrl);
    expect(url.searchParams.get('vnp_Amount')!.length).toBeLessThanOrEqual(12);
  });
});

describe('the mock and the real provider agree on the parameter set', () => {
  it('sends the same parameters, so the mock cannot hide a gap', async () => {
    const real = await new VnPayProvider(VNPCAY_CONFIG).createPayment(INPUT);
    const mock = await new MockProvider('http://localhost:3101').createPayment(INPUT);

    const realKeys = [...new URL(real.redirectUrl).searchParams.keys()].filter(
      (k) => !k.startsWith('mock_'),
    );
    const mockKeys = [...new URL(mock.redirectUrl).searchParams.keys()].filter(
      (k) => !k.startsWith('mock_'),
    );

    expect(mockKeys.sort()).toEqual(realKeys.sort());
  });

  it('does not smuggle the notify address in as a vnp_ parameter', async () => {
    const mock = await new MockProvider('http://localhost:3101').createPayment(INPUT);
    const params = new URL(mock.redirectUrl).searchParams;

    expect(params.has('vnp_NotifyUrl')).toBe(false);
    // The mock still needs to know where to send its notification, so it
    // travels under its own name.
    expect(params.get('mock_notify')).toBe(INPUT.notifyUrl);
  });
});

describe('normalizeClientIp', () => {
  it('keeps a plain IPv4 address', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('replaces an IPv6 address the gateway cannot accept', () => {
    // `Alphanumeric[7,45]`: `2001:db8::1` is too long, `::1` too short.
    expect(normalizeClientIp('2001:db8::1')).toBe('0.0.0.0');
    expect(normalizeClientIp('::1')).toBe('0.0.0.0');
  });

  it('falls back to the loopback when there is no address', () => {
    expect(normalizeClientIp(undefined)).toBe('127.0.0.1');
    expect(normalizeClientIp('')).toBe('127.0.0.1');
  });
});

describe('toGatewayRef', () => {
  it('strips the dashes of a UUID', () => {
    expect(toGatewayRef('c8157c9f-5685-4e4b-952c-052449030545')).toBe(
      'c8157c9f56854e4b952c052449030545',
    );
  });

  it('is always alphanumeric', () => {
    const ref = toGatewayRef(crypto.randomUUID());
    expect(ref).toMatch(/^[a-z0-9]+$/);
  });
});

describe('toVnSafeText', () => {
  it('removes the Vietnamese diacritics', () => {
    expect(toVnSafeText('Thanh toán đơn hàng')).toBe('Thanh toan don hang');
  });

  it('removes the special characters', () => {
    expect(toVnSafeText('Vé #1 (VIP) - 50%')).toBe('Ve 1 VIP 50');
  });

  it('handles the letters that have no decomposition', () => {
    expect(toVnSafeText('Đặt vé')).toBe('Dat ve');
  });

  it('collapses the whitespace', () => {
    expect(toVnSafeText('  a   b  ')).toBe('a b');
  });
});
