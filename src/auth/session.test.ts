import { describe, expect, it } from "vitest";
import { isLoopbackHostname, newSessionToken, sessionCookie, sessionTokenOf, tokenHash } from "./session.js";

describe("the session token", () => {
  it("is long, random and has only characters a cookie value takes", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(newSessionToken()).not.toBe(token);
  });

  it("is stored as a hash that does not show it", () => {
    expect(tokenHash("t1")).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash("t1")).not.toBe(tokenHash("t2"));
  });
});

describe("sessionTokenOf", () => {
  it("finds the cookie among others", () => {
    expect(sessionTokenOf("session=abc")).toBe("abc");
    expect(sessionTokenOf("theme=dark; session=abc; lang=uk")).toBe("abc");
  });

  it("finds none when it is not there or empty", () => {
    expect(sessionTokenOf(undefined)).toBeUndefined();
    expect(sessionTokenOf("")).toBeUndefined();
    expect(sessionTokenOf("session=")).toBeUndefined();
    expect(sessionTokenOf("mysession=abc")).toBeUndefined();
  });
});

describe("sessionCookie", () => {
  it("is out of a script's reach, stays home, and is Secure when told", () => {
    const cookie = sessionCookie("abc", 60, true);
    expect(cookie.split("; ")).toEqual(["session=abc", "Path=/api", "HttpOnly", "SameSite=Strict", "Max-Age=60", "Secure"]);
    expect(sessionCookie("abc", 60, false)).not.toContain("Secure");
  });
});

describe("isLoopbackHostname", () => {
  it("is true for this machine only, never for all interfaces (HOST in Docker)", () => {
    expect(["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"].map(isLoopbackHostname)).toEqual([true, true, true, true, true]);
    expect(["0.0.0.0", "::", "192.168.1.5", "app.example.com"].map(isLoopbackHostname)).toEqual([false, false, false, false]);
  });
});
