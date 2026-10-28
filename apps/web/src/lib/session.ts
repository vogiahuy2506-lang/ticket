import { actingUserId, SESSION_COOKIE } from './session-cookie';
import { listUsers, resolveActingUser, type SessionUser } from './users';

export { SESSION_COOKIE };
export type { SessionUser };

/**
 * "Authentication" for this test task: a cookie holding the selected user id.
 * The brief explicitly allows a user-switcher dropdown instead of real auth.
 *
 * The role is *not* taken from the cookie - it is looked up in the database
 * through the user list, so a caller cannot claim a role by editing a
 * cookie. The API does the same lookup for its own checks.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return resolveActingUser(await actingUserId());
}

/**
 * Role helper.
 *
 * Decision (brief was silent): the brief says "No authentication needed for
 * this test task. A dropdown to switch users is fine", so there is no real
 * login. But the data model still distinguishes buyer / seller / admin, and
 * the role is enforced by the *API*, not only by this UI: the escrow
 * release, the dashboard, the event creation and the raw IPN log check the
 * role, and a wallet or a receipt can only be read by its owner.
 *
 * What this helper does is decide what the *pages* show. The API decides
 * what the *caller* may do.
 *
 * This is still not authentication: anyone can pick "Ops Admin" in the
 * dropdown. It exists so the demo reads like a real marketplace and so the
 * business logic is already role-aware. Adding a real session later means
 * replacing the source of `getCurrentUser()` only.
 */
export async function requireRole(...roles: string[]): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  return user && roles.includes(user.role) ? user : null;
}

export async function hasRole(...roles: string[]): Promise<boolean> {
  return (await requireRole(...roles)) !== null;
}

/**
 * The list of people the demo can act as.
 *
 * The dropdown shows it. It is read straight from the user list module so
 * that a page needing both the list and the acting user reads the list
 * only once per request.
 */
export async function listAllUsers(): Promise<SessionUser[]> {
  return listUsers();
}
