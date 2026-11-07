// The users API of the server (src/auth/admin-routes.ts, docs/integrations.md, «Логін»): the admin's «Користувачі»
// screen and the pages of its one-time links. The shapes are copied from src/auth/admin.ts rather than imported.
import { call, JSON_HEADERS, type Role } from "./api";

const USERS_TIMEOUT_MS = 15_000;

export type LinkKind = "invite" | "reset";

export interface UserEntry {
  id: number;
  login: string;
  role: Role;
  isActive: boolean;
  // ISO time
  createdAt: string;
}

export interface UserList {
  users: UserEntry[];
  // false: more users than the list holds
  isComplete: boolean;
}

export interface CreatedLink {
  kind: LinkKind;
  token: string;
  // ISO time
  expiresAt: string;
}

export interface AcceptedLink {
  login: string;
}

export function fetchUsers(signal: AbortSignal): Promise<UserList> {
  return call<UserList>("/api/admin/users", {}, USERS_TIMEOUT_MS, ["users"], signal);
}

export function createInvite(role: Role): Promise<CreatedLink> {
  return call<CreatedLink>("/api/admin/invites", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ role }),
  }, USERS_TIMEOUT_MS, []);
}

export function createReset(userId: number): Promise<CreatedLink> {
  return call<CreatedLink>(`/api/admin/users/${userId}/reset`, { method: "POST" }, USERS_TIMEOUT_MS, []);
}

export async function setUserActive(userId: number, isActive: boolean): Promise<void> {
  await call(`/api/admin/users/${userId}/active`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ isActive }),
  }, USERS_TIMEOUT_MS, []);
}

export function acceptInvite(token: string, login: string, password: string): Promise<AcceptedLink> {
  return call<AcceptedLink>("/api/auth/invite", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, login, password }),
  }, USERS_TIMEOUT_MS, []);
}

export function acceptReset(token: string, password: string): Promise<AcceptedLink> {
  return call<AcceptedLink>("/api/auth/reset", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, password }),
  }, USERS_TIMEOUT_MS, []);
}
