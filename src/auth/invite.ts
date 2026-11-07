// One-time links of the «Користувачі» screen (docs/integrations.md, «Логін»): an invite makes a user, a reset sets a
// new password of one. The admin copies the link and sends it themselves; no email is kept. The token is of a session
// token's kind, 32 random bytes, and the database keeps only its sha256.
import type { UserInviteKind, UserRole } from "../generated/prisma/enums.js";
import { newSessionToken, tokenHash } from "./session.js";

// Both kinds, the owner's decision (docs/decisions.md, 2026-11-07)
export const LINK_HOURS = 72;
const MS_IN_HOUR = 3_600_000;
export const LINK_MS = LINK_HOURS * MS_IN_HOUR;
// The token as newSessionToken makes it: 32 bytes in base64url, no padding
export const LINK_TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";

export type Role = UserRole;
export type LinkKind = UserInviteKind;

export interface NewLink {
  // Goes to the admin's screen and nowhere else: the database keeps its hash
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function newLink(now: Date): NewLink {
  const token = newSessionToken();
  return { token, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + LINK_MS) };
}

export interface LinkRow {
  kind: LinkKind;
  usedAt: Date | null;
  expiresAt: Date;
  // A link stops when the admin who made it is disabled or is no longer an admin
  createdBy: { isActive: boolean; role: Role };
}

// The role of the users API and the «Користувачі» screen; the update that takes a link names it in SQL too
export const ADMIN_ROLE = "admin" satisfies Role;

// The users API and the «Користувачі» screen are the admin's alone; the server checks it on every request
export function canManageUsers(role: Role): boolean {
  return role === ADMIN_ROLE;
}

// One use, before its end, of the kind the page asked for. The update that takes the link checks the same in SQL
// (src/auth/admin.ts), so two parallel uses cannot both pass.
export function isLinkUsable(link: LinkRow, kind: LinkKind, now: Date): boolean {
  return link.kind === kind && link.usedAt === null && link.expiresAt > now && link.createdBy.isActive
    && canManageUsers(link.createdBy.role);
}
