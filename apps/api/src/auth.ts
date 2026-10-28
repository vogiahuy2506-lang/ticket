import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db/types.js';

/**
 * Who is making the request.
 *
 * Decision (brief was silent): the brief says "No authentication needed for
 * this test task. A dropdown to switch users is fine", so there is no
 * password, no session token and no login page. The *selected user* is
 * still an identity, though, and the identity has to travel from the
 * storefront to the API - otherwise the API cannot know whether the caller
 * is the operator or a random visitor.
 *
 * The identity travels in a header the storefront sets on every call:
 *
 *     x-tce-user-id: <user uuid>
 *
 * The storefront reads it from the session cookie (`tce_uid`) and looks the
 * role up in the database, so the role is never taken from the client's
 * word - a caller cannot claim to be the admin by sending a header.
 *
 * What this is *not*: this is not authentication. Anybody can still pick
 * "Ops Admin" in the dropdown, exactly as the brief allows. What it is:
 * *authorization*, so that the API enforces the same rule the UI already
 * enforces instead of trusting the UI to be the only way in.
 */

export const USER_HEADER = 'x-tce-user-id';

export interface Actor {
  id: string;
  role: string;
}

/**
 * Reads the acting user from the request.
 *
 * The role is looked up in the database, never taken from the header: the
 * header only says *which* user, and the database says what that user may
 * do. A caller who sends somebody else's id is simply that user - there is
 * nothing to forge, because there is no secret in the header.
 */
export async function actorFrom(
  sql: Db,
  req: FastifyRequest,
): Promise<Actor | null> {
  const header = req.headers[USER_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const userId = raw?.trim();
  if (!userId) return null;

  const rows = await sql<{ id: string; role: string }[]>`
    SELECT id, role FROM users WHERE id = ${userId} LIMIT 1
  `;
  const user = rows[0];
  return user ? { id: user.id, role: user.role } : null;
}

/**
 * Requires the caller to be one of the given roles.
 *
 * Answers `403` when the caller is known but has the wrong role, and `401`
 * when the caller is unknown. The two are different answers on purpose:
 * `401` means "I do not know who you are", `403` means "I know, and you may
 * not do this".
 */
export async function requireRole(
  sql: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  ...roles: string[]
): Promise<Actor | null> {
  const actor = await actorFrom(sql, req);
  if (!actor) {
    await reply.code(401).send({ error: 'UNKNOWN_CALLER' });
    return null;
  }
  if (!roles.includes(actor.role)) {
    await reply.code(403).send({
      error: 'FORBIDDEN',
      message: `Endpoint này cần vai trò ${roles.join(' hoặc ')}`,
    });
    return null;
  }
  return actor;
}
