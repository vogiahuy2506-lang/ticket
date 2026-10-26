import { cookies } from 'next/headers';
import { api } from './api';

export interface SessionUser {
  id: string;
  name: string;
  role: string;
}

/**
 * "Authentication" for this test task: a cookie holding the selected user id.
 * The brief explicitly allows a user-switcher dropdown instead of real auth.
 */
export const SESSION_COOKIE = 'tce_uid';

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const uid = store.get(SESSION_COOKIE)?.value;

  const { users } = await api.users();
  if (uid) {
    const found = users.find((u) => u.id === uid);
    if (found) return found;
  }
  return users.find((u) => u.role === 'buyer') ?? users[0] ?? null;
}

export async function listUsers(): Promise<SessionUser[]> {
  const { users } = await api.users();
  return users;
}
