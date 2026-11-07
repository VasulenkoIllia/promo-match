import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { UsersService } from "./admin.js";
import { LinkNotUsable, LoginTaken, OwnAccountChange, UserNotFound } from "./errors.js";
import type { AuthService, SessionUser } from "./store.js";

const TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);
const PASSWORD = "correct horse battery";
const EXPIRES_AT = new Date("2026-11-10T10:00:00Z");
const SESSIONS = new Map<string, SessionUser>([
  ["admin", { id: 1, login: "boss", role: "admin" }],
  ["manager", { id: 2, login: "worker", role: "manager" }],
]);

const auth: AuthService = {
  signIn: () => Promise.resolve(null),
  userOfSession: (token) => Promise.resolve(SESSIONS.get(token) ?? null),
  signOut: () => Promise.resolve(),
};

// Says what was asked of it; a test makes one call fail by passing it
function fakeUsers(overrides: Partial<UsersService> = {}) {
  const calls: string[] = [];
  const service: UsersService = {
    list: () => {
      calls.push("list");
      return Promise.resolve({ users: [], isComplete: true });
    },
    createInvite: (adminId, role) => {
      calls.push(`invite by ${adminId} as ${role}`);
      return Promise.resolve({ kind: "invite", token: TOKEN, expiresAt: EXPIRES_AT });
    },
    createReset: (adminId, userId) => {
      calls.push(`reset by ${adminId} of ${userId}`);
      return Promise.resolve({ kind: "reset", token: TOKEN, expiresAt: EXPIRES_AT, login: "worker" });
    },
    setActive: (adminId, userId, isActive) => {
      calls.push(`active by ${adminId} of ${userId}: ${isActive}`);
      return Promise.resolve();
    },
    acceptInvite: (_token, login) => {
      calls.push(`accept invite as ${login}`);
      return Promise.resolve({ userId: 3, login });
    },
    acceptReset: () => {
      calls.push("accept reset");
      return Promise.resolve({ userId: 2, login: "worker" });
    },
    ...overrides,
  };
  return { service, calls };
}

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function appWith(service: UsersService) {
  app = buildApp({ auth: { service: auth, isCookieSecure: true }, users: service });
  return app;
}

function send(method: "GET" | "POST" | "PUT", url: string, session?: string, payload?: object, remoteAddress?: string) {
  return app?.inject({ method, url, headers: session ? { cookie: `session=${session}` } : {}, payload, remoteAddress });
}

const ADMIN_ROUTES: [string, "GET" | "POST" | "PUT", string, object | undefined][] = [
  ["the list", "GET", "/api/admin/users", undefined],
  ["a new invite", "POST", "/api/admin/invites", { role: "admin" }],
  ["a reset link", "POST", "/api/admin/users/2/reset", undefined],
  ["disabling", "PUT", "/api/admin/users/1/active", { isActive: false }],
];

describe("the admin scope", () => {
  it.each(ADMIN_ROUTES)("answers %s with 401 without a session and 403 to a manager, asking nothing", async (_t, method, url, body) => {
    const { service, calls } = fakeUsers();
    appWith(service);
    expect((await send(method, url, undefined, body))?.statusCode).toBe(401);
    expect((await send(method, url, "forged", body))?.statusCode).toBe(401);
    const refused = await send(method, url, "manager", body);
    expect(refused?.statusCode).toBe(403);
    expect(refused?.json()).toEqual({ error: "this needs the admin role" });
    expect(calls).toEqual([]);
  });

  it("holds for a route spelt another way", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    expect((await send("GET", "/%61pi/admin/users", "manager"))?.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a request from another site, even an admin's", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    const response = await app?.inject({
      method: "POST", url: "/api/admin/invites", headers: { cookie: "session=admin", "sec-fetch-site": "same-site" },
      payload: { role: "admin" },
    });
    expect(response?.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("lets the admin in, as themselves, and tells a cache not to keep the token", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    expect((await send("GET", "/api/admin/users", "admin"))?.json()).toEqual({ users: [], isComplete: true });
    const invite = await send("POST", "/api/admin/invites", "admin", { role: "manager" });
    expect(invite?.statusCode).toBe(201);
    expect(invite?.json()).toEqual({ kind: "invite", token: TOKEN, expiresAt: EXPIRES_AT.toISOString() });
    expect(invite?.headers["cache-control"]).toBe("no-store");
    expect((await send("POST", "/api/admin/users/2/reset", "admin"))?.statusCode).toBe(201);
    expect((await send("PUT", "/api/admin/users/2/active", "admin", { isActive: false }))?.json())
      .toEqual({ id: 2, isActive: false });
    expect(calls).toEqual(["list", "invite by 1 as manager", "reset by 1 of 2", "active by 1 of 2: false"]);
  });

  it.each([
    ["a role there is not", "POST", "/api/admin/invites", { role: "owner" }],
    ["an invite without a role", "POST", "/api/admin/invites", {}],
    ["a user id that is not one", "POST", "/api/admin/users/0/reset", undefined],
    ["a field the API does not take", "PUT", "/api/admin/users/2/active", { isActive: false, role: "admin" }],
  ] as const)("answers 400 to %s", async (_title, method, url, body) => {
    const { service, calls } = fakeUsers();
    appWith(service);
    expect((await send(method, url, "admin", body))?.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 404 to a user not there and 409 to the admin disabling themselves", async () => {
    appWith(fakeUsers({
      createReset: () => Promise.reject(new UserNotFound("no such user")),
      setActive: () => Promise.reject(new OwnAccountChange("an admin cannot disable their own account")),
    }).service);
    expect((await send("POST", "/api/admin/users/9/reset", "admin"))?.statusCode).toBe(404);
    expect((await send("PUT", "/api/admin/users/1/active", "admin", { isActive: false }))?.statusCode).toBe(409);
  });

  it("is not there without the users service", async () => {
    app = buildApp({ auth: { service: auth, isCookieSecure: true } });
    expect((await send("GET", "/api/admin/users", "admin"))?.statusCode).toBe(404);
    expect((await send("POST", "/api/auth/invite", undefined, { token: TOKEN, login: "new", password: PASSWORD }))?.statusCode)
      .toBe(404);
  });
});

const invite = (token: string, login = "new.one", password = PASSWORD, remoteAddress?: string) =>
  send("POST", "/api/auth/invite", undefined, { token, login, password }, remoteAddress);

describe("the pages of the links", () => {
  it("makes the user of an invite with the login read as the sign-in reads it", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    const response = await invite(TOKEN, "  New.One ");
    expect(response?.statusCode).toBe(201);
    expect(response?.json()).toEqual({ login: "new.one" });
    expect(response?.headers["set-cookie"]).toBeUndefined();
    expect(calls).toEqual(["accept invite as new.one"]);
  });

  it("sets the new password of a reset", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    const response = await send("POST", "/api/auth/reset", undefined, { token: TOKEN, password: PASSWORD });
    expect(response?.json()).toEqual({ login: "worker" });
    expect(calls).toEqual(["accept reset"]);
  });

  it.each([
    ["a short password", { token: TOKEN, login: "new.one", password: "short" }],
    ["a login of another shape", { token: TOKEN, login: "new one", password: PASSWORD }],
    ["a token of another shape", { token: "abc", login: "new.one", password: PASSWORD }],
    ["no token", { login: "new.one", password: PASSWORD }],
  ])("answers 400 to %s, without trying it", async (_title, payload) => {
    const { service, calls } = fakeUsers();
    appWith(service);
    expect((await send("POST", "/api/auth/invite", undefined, payload))?.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 410 to a link not usable and 409 to a login taken", async () => {
    appWith(fakeUsers({
      acceptInvite: () => Promise.reject(new LoginTaken("this login is taken")),
      acceptReset: () => Promise.reject(new LinkNotUsable("this link is used, past its end or not valid")),
    }).service);
    expect((await invite(TOKEN))?.statusCode).toBe(409);
    expect((await send("POST", "/api/auth/reset", undefined, { token: TOKEN, password: PASSWORD }))?.statusCode).toBe(410);
  });

  it("refuses a request from another site", async () => {
    const { service, calls } = fakeUsers();
    appWith(service);
    const response = await app?.inject({
      method: "POST", url: "/api/auth/reset", headers: { "sec-fetch-site": "cross-site" }, payload: { token: TOKEN, password: PASSWORD },
    });
    expect(response?.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("the limit on the links' attempts", () => {
  it("stops a link after 5 attempts with the wait, without trying the 6th, and not another link", async () => {
    const { service, calls } = fakeUsers({ acceptInvite: () => Promise.reject(new LoginTaken("this login is taken")) });
    appWith(service);
    for (let attempt = 0; attempt < 5; attempt += 1) await invite(TOKEN);
    const refused = await send("POST", "/api/auth/reset", undefined, { token: TOKEN, password: PASSWORD });
    expect(refused?.statusCode).toBe(429);
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    expect((await invite(OTHER_TOKEN))?.statusCode).toBe(409);
  });

  it("counts an attempt the checks refuse too", async () => {
    appWith(fakeUsers().service);
    for (let attempt = 0; attempt < 5; attempt += 1) await invite(TOKEN, "new.one", "short");
    expect((await invite(TOKEN))?.statusCode).toBe(429);
  });

  it("stops an address after 30 attempts on any links, and not another address", async () => {
    appWith(fakeUsers().service);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await invite(attempt.toString().padStart(43, "c"), "new.one", "short", "203.0.113.5");
    }
    expect((await invite(TOKEN, "new.one", PASSWORD, "203.0.113.5"))?.statusCode).toBe(429);
    expect((await invite(TOKEN, "new.one", PASSWORD, "203.0.113.6"))?.statusCode).toBe(201);
  });
});
