import { afterEach, describe, expect, it, vi } from "vitest";
import { BluecollectionClient, nextPageUrl, readUrl } from "./api.js";

const credentials = { username: "bluecollection-user", password: "bluecollection-password" };
const BASE = "https://developers.bluecollection.eu/api/";
const FIVE_MINUTES_MS = 300_000;

interface Call {
  url: string;
  method: string;
  body?: string;
  authorization?: string;
}

let calls: Call[] = [];

function serve(answer: (call: Call) => Response): void {
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const call = {
      url: input.href, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined,
      authorization: (init.headers as Record<string, string>).Authorization,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (secrets: string[] = []) => new BluecollectionClient(credentials, secrets, new AbortController().signal);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  calls = [];
});

describe("readUrl and nextPageUrl", () => {
  it("builds the three read lists only", () => {
    expect(readUrl("client-products/").href).toBe(`${BASE}client-products/`);
    for (const path of ["orders/", "client-products/../orders/", "token/", "client-products"]) {
      expect(() => readUrl(path)).toThrow("is not a read list");
    }
  });

  it("follows a next page of the same list only", () => {
    const current = new URL(`${BASE}client-products/`);
    expect(nextPageUrl(`${BASE}client-products/?page=2`, current)?.href).toBe(`${BASE}client-products/?page=2`);
    expect(nextPageUrl("/api/client-products/?page=3", current)?.href).toBe(`${BASE}client-products/?page=3`);
    expect(nextPageUrl(null, current)).toBeNull();
    for (const next of [`${BASE}orders/?page=2`, "https://evil.example/api/client-products/?page=2", 7]) {
      expect(() => nextPageUrl(next, current)).toThrow("not a page of the same list");
    }
  });
});

describe("BluecollectionClient", () => {
  it("logs in once, reads every page with the access token and keeps the tokens among the secrets", async () => {
    serve((call) => {
      if (call.url.endsWith("/token/")) return json({ access: "access-1", refresh: "refresh-1" });
      return call.url.endsWith("?page=2")
        ? json({ count: 3, next: null, results: [{ index: "c" }] })
        : json({ count: 3, next: `${BASE}client-products/?page=2`, results: [{ index: "a" }, { index: "b" }] });
    });
    const secrets: string[] = [];
    const list = await client(secrets).readAll("client-products/");
    expect(list).toMatchObject({ count: 3, pages: 2, records: [{ index: "a" }, { index: "b" }, { index: "c" }] });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET").every((call) => call.authorization === "Bearer access-1")).toBe(true);
    expect(secrets).toEqual(expect.arrayContaining([credentials.password, "access-1", "refresh-1"]));
  });

  it("renews the access token with the refresh token after 4 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve((call) => {
      if (call.url.endsWith("/token/")) return json({ access: "access-1", refresh: "refresh-1" });
      if (call.url.endsWith("/token/refresh/")) return json({ access: "access-2" });
      if (call.url.endsWith("?page=2")) return json({ count: 2, next: null, results: [{}] });
      vi.setSystemTime(Date.now() + FIVE_MINUTES_MS);
      return json({ count: 2, next: `${BASE}client-products/?page=2`, results: [{}] });
    });
    await client().readAll("client-products/");
    expect(calls.find((call) => call.url.endsWith("/token/refresh/"))?.body).toBe(JSON.stringify({ refresh: "refresh-1" }));
    expect(calls.at(-1)?.authorization).toBe("Bearer access-2");
  });

  it("does not repeat a failed login, even on a server error, and keeps the password out of the error", async () => {
    serve(() => json({ detail: "unavailable" }, 503));
    const error = await client().readAll("client-products/").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("login: HTTP 503");
    expect((error as Error).message).not.toContain(credentials.password);
    expect(calls).toHaveLength(1);
  });

  it("stops when the first page gives no count, so a cut list never looks complete", async () => {
    serve((call) => (call.url.endsWith("/token/") ? json({ access: "access-1", refresh: "refresh-1" })
      : json({ next: null, results: [{ index: "a" }] })));
    await expect(client().readAll("client-products/")).rejects.toThrow("client-products/: the first page gives no count");
  });
});
