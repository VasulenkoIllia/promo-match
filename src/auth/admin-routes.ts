// The users API of the «Користувачі» screen and the pages of its one-time links (docs/integrations.md, «Логін»).
// The admin's, in the admin scope of src/app.ts (signed in, then requireAdmin of src/auth/routes.ts):
//   GET  /api/admin/users                  { users, isComplete }
//   POST /api/admin/invites                { role }; 201 { kind, token, expiresAt }
//   POST /api/admin/users/:userId/reset    201 { kind, token, expiresAt, login }, 404
//   PUT  /api/admin/users/:userId/active   { isActive }; 200, 404, 409 for the admin's own account
// Public, the pages of the links, with a limit on attempts per link and per address:
//   POST /api/auth/invite   { token, login, password }; 201 { login }, 400, 409 login taken, 410, 429 with Retry-After
//   POST /api/auth/reset    { token, password }; 200 { login }, 400, 410, 429; ends all the user's sessions
// 410: the link is used, past its end, of the other kind or not there. The token comes in the body, never in a URL, which
// a log or a proxy would keep; the page reads it from the address's #fragment, which the browser does not send.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UsersService } from "./admin.js";
import { attemptAddress } from "./client-ip.js";
import { LinkNotUsable, LoginTaken, OwnAccountChange, UserNotFound } from "./errors.js";
import { longestWait, RateLimiter } from "./rate-limit.js";
import {
  type ActiveBody, activeBodySchema, type InviteBody, inviteBodySchema, loginProblem, type NewInviteBody,
  newInviteBodySchema, passwordProblem, type ResetBody, resetBodySchema, tidiedLogin, type UserParams,
  userParamsSchema,
} from "./request.js";
import { refuseCrossSite, signedInUser } from "./routes.js";
import { tokenHash } from "./session.js";

// The owner's decision (docs/decisions.md, 2026-11-07), as the sign-in's: per link, and above it per address for an
// office behind one address
const MAX_ATTEMPTS_PER_LINK = 5;
const MAX_ATTEMPTS_PER_ADDRESS = 30;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const LINK_BODY_LIMIT_BYTES = 4096;

function sendFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LinkNotUsable) return reply.code(410).send({ error: error.message });
  if (error instanceof LoginTaken || error instanceof OwnAccountChange) return reply.code(409).send({ error: error.message });
  if (error instanceof UserNotFound) return reply.code(404).send({ error: error.message });
  throw error;
}

// Registered in the admin scope
export function registerAdminRoutes(app: FastifyInstance, service: UsersService): void {
  app.get("/api/admin/users", () => service.list());

  app.post<{ Body: NewInviteBody }>("/api/admin/invites", {
    schema: { body: newInviteBodySchema },
  }, async (request, reply) => {
    const admin = signedInUser(request);
    const link = await service.createInvite(admin.id, request.body.role);
    request.log.info({ userId: admin.id, role: request.body.role }, "invite link made");
    return reply.code(201).send(link);
  });

  app.post<{ Params: UserParams }>("/api/admin/users/:userId/reset", {
    schema: { params: userParamsSchema },
  }, async (request, reply) => {
    const admin = signedInUser(request);
    try {
      const link = await service.createReset(admin.id, request.params.userId);
      request.log.info({ userId: admin.id, forUserId: request.params.userId }, "reset link made");
      return await reply.code(201).send(link);
    } catch (error) {
      return sendFailure(reply, error);
    }
  });

  app.put<{ Params: UserParams; Body: ActiveBody }>("/api/admin/users/:userId/active", {
    schema: { params: userParamsSchema, body: activeBodySchema },
  }, async (request, reply) => {
    const admin = signedInUser(request);
    const { userId } = request.params;
    const { isActive } = request.body;
    try {
      await service.setActive(admin.id, userId, isActive);
      request.log.info({ userId: admin.id, forUserId: userId, isActive }, isActive ? "user enabled" : "user disabled");
      return { id: userId, isActive };
    } catch (error) {
      return sendFailure(reply, error);
    }
  });
}

// Next to the sign-in route, outside the signed-in scope
export function registerLinkRoutes(app: FastifyInstance, service: UsersService): void {
  const attemptsOfLink = new RateLimiter(MAX_ATTEMPTS_PER_LINK, ATTEMPT_WINDOW_MS);
  const attemptsOfAddress = new RateLimiter(MAX_ATTEMPTS_PER_ADDRESS, ATTEMPT_WINDOW_MS);

  // Counted before anything is checked, so parallel attempts cannot slip past; true: refused with 429
  function isRefused(request: FastifyRequest, reply: FastifyReply, token: string): boolean {
    // The token's hash, so the memory of the process does not hold the token either
    const waitSeconds = longestWait([
      attemptsOfLink.take(tokenHash(token)),
      attemptsOfAddress.take(attemptAddress(request)),
    ]);
    if (waitSeconds === 0) return false;
    request.log.warn({ waitSeconds }, "link refused: too many attempts");
    void reply.code(429).header("retry-after", waitSeconds).send({ error: "too many attempts" });
    return true;
  }

  // As the signed-in scope's: no browser or proxy cache keeps what a link's page was answered, a refusal included
  const noStore = (_request: FastifyRequest, reply: FastifyReply, _payload: unknown, next: () => void) => {
    void reply.header("cache-control", "no-store");
    next();
  };
  const options = { bodyLimit: LINK_BODY_LIMIT_BYTES, onRequest: refuseCrossSite, onSend: noStore };

  app.post<{ Body: InviteBody }>("/api/auth/invite", {
    ...options, schema: { body: inviteBodySchema },
  }, async (request, reply) => {
    if (isRefused(request, reply, request.body.token)) return reply;
    const login = tidiedLogin(request.body.login);
    const problem = loginProblem(login) ?? passwordProblem(request.body.password);
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const user = await service.acceptInvite(request.body.token, login, request.body.password);
      request.log.info({ userId: user.userId }, "invite link used: user made");
      return await reply.code(201).send({ login: user.login });
    } catch (error) {
      request.log.warn({ reason: error instanceof Error ? error.name : "unknown" }, "invite link refused");
      return sendFailure(reply, error);
    }
  });

  app.post<{ Body: ResetBody }>("/api/auth/reset", {
    ...options, schema: { body: resetBodySchema },
  }, async (request, reply) => {
    if (isRefused(request, reply, request.body.token)) return reply;
    const problem = passwordProblem(request.body.password);
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const user = await service.acceptReset(request.body.token, request.body.password);
      request.log.info({ userId: user.userId }, "reset link used: new password, sessions ended");
      return { login: user.login };
    } catch (error) {
      request.log.warn({ reason: error instanceof Error ? error.name : "unknown" }, "reset link refused");
      return sendFailure(reply, error);
    }
  });
}
