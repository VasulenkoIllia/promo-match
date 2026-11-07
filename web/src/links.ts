// The pages of the admin's one-time links (src/auth/admin-routes.ts): /invite#<token> and /reset#<token>. The token is
// after #, which the browser sends to no server, proxy or log and puts in no Referer.
import type { LinkKind } from "./users-api";

const PATHS: Record<LinkKind, string> = { invite: "/invite", reset: "/reset" };
// As the server makes it (src/auth/invite.ts): 32 bytes in base64url
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TRAILING_SLASHES = /\/+$/;

export interface LinkPage {
  kind: LinkKind;
  // null: the page was opened without a whole token, as on a reload after the page took it out of the address
  token: string | null;
}

// The link page of this address, or null for the app itself
export function linkPageOf(pathname: string, hash: string): LinkPage | null {
  const path = pathname.replace(TRAILING_SLASHES, "");
  const kind = (Object.keys(PATHS) as LinkKind[]).find((each) => PATHS[each] === path);
  if (!kind) return null;
  const token = hash.replace(/^#/, "");
  return { kind, token: TOKEN.test(token) ? token : null };
}

export function linkUrl(origin: string, kind: LinkKind, token: string): string {
  return `${origin}${PATHS[kind]}#${token}`;
}
