// Signing in and out (docs/integrations.md, «Логін»).
//   POST /api/auth/login   { login, password }; 200 { login, role } with the session cookie, 401, 429 with Retry-After
//   POST /api/auth/logout  ends the session, clears the cookie
//   GET  /api/auth/me      { login, role } of this session, 401 without one
// Every other API route lives in the signed-in scope of src/app.ts, whose hook is requireUser: a route added there is
// closed by being there, not by a path check, which a URL spelt another way (/%61pi/search) would pass. The users API
// lives in a scope inside it, whose hook is requireAdmin. The pages of the one-time links are src/auth/admin-routes.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { canManageUsers } from "./invite.js";
import { longestWait, RateLimiter } from "./rate-limit.js";
import { type LoginBody, loginBodySchema, tidiedLogin } from "./request.js";
import { SESSION_SECONDS, sessionCookie, sessionTokenOf } from "./session.js";
import type { AuthService, SessionUser } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AuthOptions {
  service: AuthService;
  // false on loopback only: the dev server is plain HTTP, and a Secure cookie would not come back through it
  isCookieSecure: boolean;
}

const MAX_ATTEMPTS_PER_LOGIN = 5;
// Above a login's bound, for an office behind one address
const MAX_ATTEMPTS_PER_ADDRESS = 30;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const LOGIN_BODY_LIMIT_BYTES = 4096;
// "none" is a request the user made, such as an address typed in
const OWN_SITE = new Set(["same-origin", "none"]);

// SameSite=Strict does not stop a sibling subdomain, which is the same site to the browser; this does. A client that is
// not a browser sends no such header and has no cookie to abuse.
export function refuseCrossSite(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const site = request.headers["sec-fetch-site"];
  if (site === undefined || OWN_SITE.has(site)) {
    done();
    return;
  }
  void reply.code(403).send({ error: "this API takes requests from its own pages only" });
}

export function requireUser(service: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = sessionTokenOf(request.headers.cookie);
    request.user = token ? await service.userOfSession(token) : null;
    if (!request.user) await reply.code(401).send({ error: "sign in first" });
  };
}

// For a route in the signed-in scope, whose hook has set the user
export function signedInUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error(`${request.method} ${request.url.split("?", 1)[0]} is outside the signed-in scope`);
  return request.user;
}

// The hook of the admin scope, inside the signed-in one: a manager gets 403 on every route there. The role is read with
// the session on each request, so a change of it holds at once.
export function requireAdmin(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const user = signedInUser(request);
  if (canManageUsers(user.role)) {
    done();
    return;
  }
  request.log.warn({ userId: user.id }, "admin route refused: not an admin");
  void reply.code(403).send({ error: "this needs the admin role" });
}

export function registerSignInRoute(app: FastifyInstance, { service, isCookieSecure }: AuthOptions): void {
  const attemptsOfLogin = new RateLimiter(MAX_ATTEMPTS_PER_LOGIN, ATTEMPT_WINDOW_MS);
  const attemptsOfAddress = new RateLimiter(MAX_ATTEMPTS_PER_ADDRESS, ATTEMPT_WINDOW_MS);

  app.post<{ Body: LoginBody }>("/api/auth/login", {
    bodyLimit: LOGIN_BODY_LIMIT_BYTES,
    schema: { body: loginBodySchema },
    onRequest: refuseCrossSite,
  }, async (request, reply) => {
    const login = tidiedLogin(request.body.login);
    // Both are counted, whichever refuses
    const waitSeconds = longestWait([attemptsOfLogin.take(login), attemptsOfAddress.take(request.ip)]);
    if (waitSeconds > 0) {
      request.log.warn({ waitSeconds }, "sign-in refused: too many attempts");
      return reply.code(429).header("retry-after", waitSeconds).send({ error: "too many attempts" });
    }
    const signedIn = await service.signIn(login, request.body.password);
    if (!signedIn) {
      // Without the login: people type their password into that field by mistake
      request.log.warn("sign-in failed");
      return reply.code(401).send({ error: "wrong login or password" });
    }
    attemptsOfLogin.reset(login);
    request.log.info({ userId: signedIn.user.id }, "signed in");
    return reply.header("set-cookie", sessionCookie(signedIn.token, SESSION_SECONDS, isCookieSecure))
      .send({ login: signedIn.user.login, role: signedIn.user.role });
  });
}

// Registered in the signed-in scope
export function registerSessionRoutes(app: FastifyInstance, { service, isCookieSecure }: AuthOptions): void {
  app.get("/api/auth/me", (request) => {
    const { login, role } = signedInUser(request);
    return { login, role };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = sessionTokenOf(request.headers.cookie);
    if (token) await service.signOut(token);
    request.log.info({ userId: signedInUser(request).id }, "signed out");
    return reply.header("set-cookie", sessionCookie("", 0, isCookieSecure)).send({ status: "ok" });
  });
}
