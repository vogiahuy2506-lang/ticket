/**
 * Shortening of ledger account codes for display.
 *
 * An escrow account code embeds the owner's user id, so it looks like
 * `liability:user:9babd67a-3607-4505-b42b-b02a6d0eead3:available`. On a
 * phone that is far too long to sit under the account name, and it pushes
 * the layout around, so the UUID is shortened to its first eight
 * characters. The rest of the code - the parts that carry the meaning
 * (`liability`, `user`, `available`) - is kept as is, because that is what
 * a reader actually uses to tell two accounts apart.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// A separate, non-global pattern: `test()` on a global regex keeps a
// `lastIndex` between calls and would answer differently on every other
// invocation.
const UUID_PRESENT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The number of leading UUID characters that are kept. */
export const SHORT_UUID_LENGTH = 8;

/**
 * Shortens every UUID inside an account code.
 *
 * A code without a UUID (`asset:gateway_cash`) is returned unchanged, so
 * the caller does not need to special-case the simple accounts.
 */
export function shortenAccountCode(code: string): string {
  return code.replace(
    UUID_RE,
    (uuid) => `${uuid.slice(0, SHORT_UUID_LENGTH)}…`,
  );
}

/**
 * Whether a code was actually shortened, i.e. whether it contains a UUID.
 * The UI uses this to decide if the code is expandable at all.
 */
export function isShortenableAccountCode(code: string): boolean {
  return UUID_PRESENT_RE.test(code);
}
