/**
 * Helpers for the VNPay wire format.
 *
 * The gateway validates the *shape* of every parameter it receives, so a
 * value that is perfectly fine in our database can still be rejected at the
 * payment page. The rules come from the official parameter table
 * (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html):
 *
 *   `vnp_OrderInfo`  Alphanumeric[1,255], "Tieng Viet khong dau va khong
 *                     bao gom cac ky tu dac biet" - so no diacritics and no
 *                     punctuation.
 *   `vnp_TxnRef`     Alphanumeric[1,100]. A UUID contains dashes, which are
 *                     not alphanumeric, so the reference we send is the UUID
 *                     without them.
 *   `vnp_IpAddr`     Alphanumeric[7,45].
 */

/**
 * Strips Vietnamese diacritics and every character that is not a letter or a
 * digit, collapsing the rest into single spaces.
 *
 * `String.normalize('NFD')` splits the accented characters into their base
 * letter plus a combining mark, so removing the marks leaves the plain
 * letter. Vietnamese `đ`/`Đ` has no decomposition, so it is mapped by hand.
 */
export function toVnSafeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}

/**
 * Builds the reference that is sent to the gateway as `vnp_TxnRef`.
 *
 * The reference must be alphanumeric, so the UUID of the order is sent
 * without its dashes. The order keeps its UUID as its primary key; the
 * gateway reference is stored next to it and is what an incoming
 * notification is matched on.
 */
export function toGatewayRef(orderId: string): string {
  return orderId.replace(/-/g, '').toLowerCase();
}

/**
 * The longest reference the gateway accepts (`Alphanumeric[1,100]`).
 */
export const GATEWAY_REF_MAX_LENGTH = 100;
