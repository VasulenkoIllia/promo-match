import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { sessionTokenOf } from "./session.js";
import type { AuthOptions } from "./routes.js";
import type { AuthService } from "./store.js";

const PASSWORD = "correct horse battery";

// One user, one token per sign-in
function fakeAuth() {
  const tokens = new Set<string>();
  const signIns: string[] = [];
  const service: AuthService = {
    signIn: (login, password) => {
      signIns.push(login);
      if (login !== "tester" || password !== PASSWORD) return Promise.resolve(null);
      const token = `t${tokens.size + 1}`;
      tokens.add(token);
      return Promise.resolve({ user: { id: 1, login, role: "manager" }, token });
    },
    userOfSession: (token) => Promise.resolve(tokens.has(token) ? { id: 1, login: "tester", role: "manager" } : null),
    signOut: (token) => {
      tokens.delete(token);
      return Promise.resolve();
    },
  };
  return { service, tokens, signIns };
}

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function appWith(service: AuthService, isCookieSecure = true) {
  const auth: AuthOptions = { service, isCookieSecure };
  app = buildApp({ auth });
  return app;
}

function signIn(login: string, password: string, headers: Record<string, string> = {}, remoteAddress?: string) {
  return app?.inject({
    method: "POST", url: "/api/auth/login", headers, remoteAddress, payload: { login, password },
  });
}

describe("POST /api/auth/login", () => {
  it("answers with the login and sets the session cookie", async () => {
    appWith(fakeAuth().service);
    const response = await signIn("tester", PASSWORD);
    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toEqual({ login: "tester", role: "manager" });
    expect(response?.headers["set-cookie"]).toBe("session=t1; Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800; Secure");
  });

  it("leaves Secure out only where the server was told so, on loopback", async () => {
    appWith(fakeAuth().service, false);
    const response = await signIn("tester", PASSWORD);
    expect(response?.headers["set-cookie"]).toBe("session=t1; Path=/api; HttpOnly; SameSite=Strict; Max-Age=604800");
  });

  it("reads the login in lower case, without spaces around it", async () => {
    const { service, signIns } = fakeAuth();
    appWith(service);
    expect((await signIn("  TesTer ", PASSWORD))?.statusCode).toBe(200);
    expect(signIns).toEqual(["tester"]);
  });

  it("answers one 401 to a wrong login and a wrong password, without a cookie", async () => {
    appWith(fakeAuth().service);
    const wrongPassword = await signIn("tester", "wrong");
    const wrongLogin = await signIn("nobody", PASSWORD);
    expect(wrongPassword?.statusCode).toBe(401);
    expect(wrongLogin?.statusCode).toBe(401);
    expect(wrongPassword?.body).toBe(wrongLogin?.body);
    expect(wrongPassword?.headers["set-cookie"]).toBeUndefined();
  });

  it.each([
    ["no password", { login: "tester" }],
    ["a password past the bound", { login: "tester", password: "p".repeat(129) }],
    ["a login past the bound", { login: "t".repeat(65), password: PASSWORD }],
    ["a NUL in the login, which Postgres text cannot hold", { login: "tes\u0000ter", password: PASSWORD }],
    ["a field the API does not take", { login: "tester", password: PASSWORD, remember: true }],
  ])("answers 400 to %s, without trying it", async (_title, payload) => {
    const { service, signIns } = fakeAuth();
    const response = await appWith(service).inject({ method: "POST", url: "/api/auth/login", payload });
    expect(response.statusCode).toBe(400);
    expect(signIns).toEqual([]);
  });

  it("takes nothing a cross-site form can send", async () => {
    const { service, signIns } = fakeAuth();
    const response = await appWith(service).inject({
      method: "POST", url: "/api/auth/login", headers: { "content-type": "text/plain" }, payload: JSON.stringify({ login: "tester", password: PASSWORD }),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(signIns).toEqual([]);
  });

  it("refuses a request from another site", async () => {
    const { service, signIns } = fakeAuth();
    appWith(service);
    expect((await signIn("tester", PASSWORD, { "sec-fetch-site": "cross-site" }))?.statusCode).toBe(403);
    expect(signIns).toEqual([]);
  });
});

describe("the limit on sign-in attempts", () => {
  it("stops a login after 5 attempts with the wait, without trying the 6th", async () => {
    const { service, signIns } = fakeAuth();
    appWith(service);
    for (let attempt = 0; attempt < 5; attempt += 1) await signIn("tester", "wrong");
    const refused = await signIn("tester", PASSWORD);
    expect(refused?.statusCode).toBe(429);
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThan(0);
    expect(signIns).toHaveLength(5);
  });

  it("forgets a login's failures after it signs in", async () => {
    appWith(fakeAuth().service);
    for (let attempt = 0; attempt < 4; attempt += 1) await signIn("tester", "wrong");
    expect((await signIn("tester", PASSWORD))?.statusCode).toBe(200);
    for (let attempt = 0; attempt < 4; attempt += 1) await signIn("tester", "wrong");
    expect((await signIn("tester", PASSWORD))?.statusCode).toBe(200);
  });

  it("counts the login in the same case as it is read", async () => {
    appWith(fakeAuth().service);
    for (const login of ["tester", "TESTER", "Tester", " tester", "tester ", "tEster"]) await signIn(login, "wrong");
    expect((await signIn("tester", PASSWORD))?.statusCode).toBe(429);
  });

  it("stops an address after 30 attempts on any logins, and not another address", async () => {
    const { service, signIns } = fakeAuth();
    appWith(service);
    for (let attempt = 0; attempt < 30; attempt += 1) await signIn(`login${attempt}`, "wrong", {}, "203.0.113.5");
    expect((await signIn("tester", PASSWORD, {}, "203.0.113.5"))?.statusCode).toBe(429);
    expect(signIns).toHaveLength(30);
    expect((await signIn("tester", PASSWORD, {}, "203.0.113.6"))?.statusCode).toBe(200);
  });

  it("counts the address behind a Cloudflare edge, not the edge, and not the header from anyone else", async () => {
    appWith(fakeAuth().service);
    const edge = "162.158.10.20";
    const behind = { "cf-connecting-ip": "203.0.113.5" };
    for (let attempt = 0; attempt < 30; attempt += 1) await signIn(`login${attempt}`, "wrong", behind, edge);
    expect((await signIn("tester", PASSWORD, behind, edge))?.statusCode).toBe(429);
    expect((await signIn("tester", PASSWORD, { "cf-connecting-ip": "203.0.113.6" }, edge))?.statusCode).toBe(200);
    // Straight to the server with the header of the stopped address: counted by its own, which is free
    expect((await signIn("tester", PASSWORD, behind, "198.51.100.7"))?.statusCode).toBe(200);
  });
});

describe("the signed-in scope", () => {
  const me = (cookie?: string) => app?.inject({ method: "GET", url: "/api/auth/me", headers: cookie ? { cookie } : {} });

  it("answers 401 without a session, and with an unknown one", async () => {
    appWith(fakeAuth().service);
    expect((await me())?.statusCode).toBe(401);
    expect((await me("session=forged"))?.statusCode).toBe(401);
    expect((await me("other=t1"))?.statusCode).toBe(401);
  });

  it("knows who signed in, and tells a cache not to keep the answer", async () => {
    appWith(fakeAuth().service);
    const signedIn = await signIn("tester", PASSWORD);
    const response = await me(String(signedIn?.headers["set-cookie"]).split(";", 1)[0]);
    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toEqual({ login: "tester", role: "manager" });
    expect(response?.headers["cache-control"]).toBe("no-store");
  });

  it("holds for a route spelt another way", async () => {
    appWith(fakeAuth().service);
    const response = await app?.inject({ method: "GET", url: "/%61pi/auth/me" });
    expect(response?.statusCode).toBe(401);
  });

  it("is not there without the login", async () => {
    app = buildApp();
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(404);
  });
});

describe("POST /api/auth/logout", () => {
  it("ends the session on the server and clears the cookie", async () => {
    const { service, tokens } = fakeAuth();
    appWith(service);
    const signedIn = await signIn("tester", PASSWORD);
    const cookie = String(signedIn?.headers["set-cookie"]).split(";", 1)[0] ?? "";
    expect(sessionTokenOf(cookie)).toBe("t1");
    const response = await app?.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(response?.statusCode).toBe(200);
    expect(response?.headers["set-cookie"]).toBe("session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
    expect(tokens.size).toBe(0);
    const after = await app?.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after?.statusCode).toBe(401);
  });

  it("answers 401 without a session, and from another site keeps it", async () => {
    const { service, tokens } = fakeAuth();
    appWith(service);
    expect((await app?.inject({ method: "POST", url: "/api/auth/logout" }))?.statusCode).toBe(401);
    await signIn("tester", PASSWORD);
    const crossSite = await app?.inject({
      method: "POST", url: "/api/auth/logout", headers: { cookie: "session=t1", "sec-fetch-site": "same-site" },
    });
    expect(crossSite?.statusCode).toBe(403);
    expect(tokens.size).toBe(1);
  });
});
