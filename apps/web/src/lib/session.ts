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

/**
 * Role helper.
 *
 * Decision (brief was silent): the brief says "No authentication needed for
 * this test task. A dropdown to switch users is fine", so there is no real
 * login. But the data model still distinguishes buyer / seller / admin, and
 * the UI gates the operator-only actions on that role.
 *
 * This is *presentation-level* authorization, not security: anyone can pick
 * "Ops Admin" in the dropdown. It exists so the demo reads like a real
 * marketplace and so the business logic is already role-aware. Adding a
 * real session later means replacing the source of `getCurrentUser()` only.
 */
export async function requireRole(...roles: string[]): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  return user && roles.includes(user.role) ? user : null;
}

export async function hasRole(...roles: string[]): Promise<boolean> {
  return (await requireRole(...roles)) !== null;
}

export async function listUsers(): Promise<SessionUser[]> {
  const { users } = await api.users();
  return users;
}
