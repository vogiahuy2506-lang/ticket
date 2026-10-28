/**
 * The header the API reads to know who is acting.
 *
 * The API checks the role of every mutating endpoint and the ownership of
 * every wallet and receipt. The role is looked up in the database by the
 * API itself, so a test only has to say *which* user it is acting as.
 *
 * The name lives here so the API, the tests and the e2e runner all agree
 * on it without importing each other.
 */
export const USER_HEADER = 'x-tce-user-id';

/** The headers a request from `userId` carries. */
export function asUser(userId: string): Record<string, string> {
  return { [USER_HEADER]: userId };
}
