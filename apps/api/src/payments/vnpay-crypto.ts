import crypto from 'node:crypto';

/**
 * The VNPay signing algorithm, shared by the real provider, the local mock
 * gateway and the end-to-end test.
 *
 * Keeping it in one place is deliberate: the whole point of the mock is to
 * exercise the same code path as the real gateway, so a second copy of the
 * algorithm would let the mock and the server drift apart and hide a bug.
 *
 * The algorithm, as documented in the official VNPay samples:
 *
 *  1. drop the empty parameters and the hash fields
 *  2. sort the remaining keys alphabetically (`ksort`)
 *  3. build the "hash data": `urlencode(key)=urlencode(value)` joined by `&`
 *  4. `HMAC-SHA512(secretKey, hashData)` -> lowercase hex
 */

/**
 * `urlencode` in the PHP samples encodes a space as `+` and leaves `-`, `_`,
 * `.` and `~` alone. `encodeURIComponent` differs on spaces and on
 * `!'()*`, so the values are encoded to match the samples byte for byte.
 */
export function encodeVnValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/**
 * Drops empty values and sorts the remaining keys alphabetically - exactly
 * what `ksort()` plus the "skip empty values" loop in the VNPay samples do.
 */
export function sortVnParams(obj: Record<string, string>): Record<string, string> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = String(value);
      }
      return acc;
    }, {});
}

/** Builds the "hash data" string that gets signed. */
export function buildHashData(params: Record<string, string>): string {
  const filtered = sortVnParams(params);
  return Object.entries(filtered)
    .map(([k, v]) => `${encodeVnValue(k)}=${encodeVnValue(v)}`)
    .join('&');
}

/** HMAC-SHA512 over the hash data - the VNPay `vnp_SecureHash`. */
export function signVnParams(
  params: Record<string, string>,
  secretKey: string,
): string {
  return crypto
    .createHmac('sha512', secretKey)
    .update(buildHashData(params), 'utf8')
    .digest('hex');
}
