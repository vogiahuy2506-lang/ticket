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

/**
 * The server-to-server APIs (`querydr`, `refund`) sign differently from
 * `pay`: the hash data is a *fixed* list of values joined by `|`, in the
 * order the documentation gives - not the sorted `key=value` list. Signing
 * a query the `pay` way makes the gateway answer `97` (invalid checksum).
 */
export function signVnPipe(values: readonly string[], secretKey: string): string {
  return crypto
    .createHmac('sha512', secretKey)
    .update(values.join('|'), 'utf8')
    .digest('hex');
}

/** Compares two hex signatures without leaking where they differ. */
export function sameSignature(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
