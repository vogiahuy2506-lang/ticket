/**
 * The list of people the demo can act as, and who the acting user is.
 *
 * This module exists to break a cycle. `session.ts` needs the list to
 * resolve the acting user, and `api.ts` needs the acting user to build
 * the header it sends. If the list lived in `api.ts`, the two modules
 * would import each other.
 *
 * The list call itself does *not* carry the "who is acting" header.
 * Resolving the acting user means reading this list, so asking for the
 * list in order to build the header for the list would never end.
 */
import { cache } from 'react';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';

export interface SessionUser {
  id: string;
  name: string;
  role: string;
}

/**
 * The people the demo can act as.
 *
 * `cache` from React memoises the call for the duration of one request, so
 * a page that renders the user list *and* the acting user reads the list
 * once instead of twice. It is a per-request cache, not a global one - a
 * new request re-reads the list, so a user who switched in the dropdown
 * is picked up immediately.
 */
export const listUsers = cache(async (): Promise<SessionUser[]> => {
  const res = await fetch(`${API_BASE_URL}/api/users`, {
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API /api/users failed with ${res.status}: ${body.slice(0, 300)}`);
  }
  const { users } = (await res.json()) as { users: SessionUser[] };
  return users;
});

/**
 * Who the caller is acting as.
 *
 * The cookie holds the *id* only. The role is never taken from the
 * client's word: it is read from the list the database produced, so a
 * caller cannot claim to be the operator by editing a cookie.
 *
 * When no cookie is set the session falls back to the first buyer - that
 * is the same rule the storefront uses, so the API and the pages always
 * agree on who is calling.
 */
export async function resolveActingUser(cookieUserId: string | null): Promise<SessionUser | null> {
  const users = await listUsers();
  if (cookieUserId) {
    const found = users.find((u) => u.id === cookieUserId);
    if (found) return found;
  }
  return users.find((u) => u.role === 'buyer') ?? users[0] ?? null;
}
