import { cookies } from 'next/headers';

/**
 * The name of the cookie that holds the acting user.
 *
 * It lives in its own module because both the session helper and the API
 * client need it, and the session helper already imports the API client -
 * importing it back would close a cycle.
 */
export const SESSION_COOKIE = 'tce_uid';

/**
 * The id of the acting user, or null when nobody is selected.
 *
 * The cookie holds the *id* only. The role is never stored on the client:
 * the API looks it up in the database, so a caller cannot claim to be the
 * operator by editing a cookie.
 */
export async function actingUserId(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}
