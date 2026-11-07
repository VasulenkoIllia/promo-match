// The input of signing in, of the users job, of the users API and of its links' pages. The bounds of a login and a
// password hold for all of them.
import { UserRole } from "../generated/prisma/enums.js";
import { LINK_TOKEN_PATTERN } from "./invite.js";

const MAX_LOGIN_CHARS = 64;
const MIN_PASSWORD_CHARS = 12;
const MAX_PASSWORD_CHARS = 128;
const LOGIN_SHAPE = /^[a-z0-9][a-z0-9._-]+$/;
// Postgres text cannot hold it: the lookup would fail with a 500
const NO_NUL = "^[^\\u0000]*$";

export const loginBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["login", "password"],
  properties: {
    login: { type: "string", minLength: 1, maxLength: MAX_LOGIN_CHARS, pattern: NO_NUL },
    password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_CHARS },
  },
} as const;

export interface LoginBody {
  login: string;
  password: string;
}

export function tidiedLogin(login: string): string {
  return login.trim().toLowerCase();
}

// What the users job refuses, or null
export function loginProblem(login: string): string | null {
  if (login.length > MAX_LOGIN_CHARS || !LOGIN_SHAPE.test(login)) {
    return `a login is 2 to ${MAX_LOGIN_CHARS} of a-z, 0-9, dot, dash or underscore, starting with a letter or digit`;
  }
  return null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_CHARS || password.length > MAX_PASSWORD_CHARS) {
    return `a password is ${MIN_PASSWORD_CHARS} to ${MAX_PASSWORD_CHARS} characters`;
  }
  return null;
}

const MAX_ID = 2_147_483_647;
const TOKEN = { type: "string", pattern: LINK_TOKEN_PATTERN } as const;
// The shape of the login and the password's length are checked by loginProblem and passwordProblem, whose words the
// page shows; the schema only bounds them
const NEW_LOGIN = { type: "string", minLength: 1, maxLength: MAX_LOGIN_CHARS, pattern: NO_NUL } as const;
const NEW_PASSWORD = { type: "string", minLength: 1, maxLength: MAX_PASSWORD_CHARS } as const;

export const inviteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "login", "password"],
  properties: { token: TOKEN, login: NEW_LOGIN, password: NEW_PASSWORD },
} as const;

export interface InviteBody {
  token: string;
  login: string;
  password: string;
}

export const resetBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "password"],
  properties: { token: TOKEN, password: NEW_PASSWORD },
} as const;

export interface ResetBody {
  token: string;
  password: string;
}

export const newInviteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["role"],
  properties: { role: { type: "string", enum: Object.values(UserRole) } },
} as const;

export interface NewInviteBody {
  role: UserRole;
}

export const userParamsSchema = {
  type: "object",
  required: ["userId"],
  properties: { userId: { type: "integer", minimum: 1, maximum: MAX_ID } },
} as const;

export interface UserParams {
  userId: number;
}

export const activeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["isActive"],
  properties: { isActive: { type: "boolean" } },
} as const;

export interface ActiveBody {
  isActive: boolean;
}
