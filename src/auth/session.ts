// The session of a signed-in browser (docs/integrations.md, «Логін»): a random token in a cookie, its sha256 in the
// database. HttpOnly: a page's script never sees it. SameSite=Strict: a request from another site comes without it, and
// the app is a single page, so a link from elsewhere only opens it and the page's own requests carry the cookie.
import { createHash, randomBytes } from "node:crypto";

const COOKIE_NAME = "session";
const TOKEN_BYTES = 32;
const SESSION_DAYS = 7;
const SECONDS_IN_DAY = 86_400;
const MS_IN_SECOND = 1000;
export const SESSION_SECONDS = SESSION_DAYS * SECONDS_IN_DAY;
export const SESSION_MS = SESSION_SECONDS * MS_IN_SECOND;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The token is base64url, so there is nothing to decode
export function sessionTokenOf(cookieHeader: string | undefined): string | undefined {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [name, value] = cookie.trim().split("=", 2);
    if (name === COOKIE_NAME && value) return value;
  }
  return undefined;
}

// Path /api: the web app's files need no session
export function sessionCookie(token: string, maxAgeSeconds: number, isSecure: boolean): string {
  return [
    `${COOKIE_NAME}=${token}`, "Path=/api", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`,
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}
