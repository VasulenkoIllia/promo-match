import { afterEach, describe, expect, it, vi } from "vitest";
import { readFeed } from "./adapter.js";
import { AXPOL_BASE, AxpolClient, AxpolError, type AxpolPage, readJwtTtlSeconds } from "./api.js";

const credentials = { login: "b2b-login", password: "b2b-password", apiKey: "axpol-api-key" };
const JWT = `header.${Buffer.from(JSON.stringify({ iat: 1, exp: 601 })).toString("base64url")}.signature`;

interface Call {
  method: string;
  key: string | null;
  authorization?: string;
}

let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const loginOk = () => json({ message: "", success: 1, data: { uid: "86", jwt: JWT } });

// A mocked Axpol: answer(method, nth call of that method)
function serve(answer: (method: string, nth: number) => Response): void {
  const counts = new Map<string, number>();
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const isLogin = init.method === "POST";
    const method = isLogin ? "login" : input.searchParams.get("method") ?? "?";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, key: input.searchParams.get("key"), authorization: headers.Authorization });
    const nth = (counts.get(method) ?? 0) + 1;
    counts.set(method, nth);
    return Promise.resolve(answer(method, nth));
  });
}

function client(secrets: string[] = []): AxpolClient {
  return new AxpolClient(credentials, secrets, new AbortController().signal, AXPOL_BASE, 0);
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

describe("AxpolClient", () => {
  it("logs in once and reads with the key, the uid and the JWT", async () => {
    serve((method) => (method === "login" ? loginOk() : json({ success: 1, data: { count: "10 883" } })));
    const axpol = client();
    expect(await axpol.count("Product")).toBe(10_883);
    expect(await axpol.count("Stock")).toBe(10_883);
    expect(calls.map((call) => call.method)).toEqual(["login", "Product.Count", "Stock.Count"]);
    expect(calls[1]).toMatchObject({ key: "axpol-api-key", authorization: `Bearer ${JWT}` });
  });

  it("logs in again once when a read comes back without success, then gives up", async () => {
    serve((method, nth) => {
      if (method === "login") return loginOk();
      return nth === 1 ? json({ success: 0, message: "Token expired" }) : json({ success: 1, data: { count: "5" } });
    });
    expect(await client().count("Product")).toBe(5);
    expect(calls.map((call) => call.method)).toEqual(["login", "Product.Count", "login", "Product.Count"]);

    calls = [];
    serve((method) => (method === "login" ? loginOk() : json({ success: 0, message: "Bad key axpol-api-key" })));
    const error = await client().count("Product").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AxpolError);
    expect((error as Error).message)
      .toBe("Product.Count: HTTP 200, Bad key <redacted> (before a new login: HTTP 200, Bad key <redacted>)");
    expect(calls.filter((call) => call.method === "login")).toHaveLength(2);
  });

  it("does not log in again after a 5xx the retries did not get past", async () => {
    const unavailable = () => new Response("busy", { status: 503, headers: { "retry-after": "0" } });
    serve((method) => (method === "login" ? loginOk() : unavailable()));
    await expect(client().count("Product")).rejects.toThrow("Product.Count: HTTP 503");
    expect(calls.map((call) => call.method)).toEqual(["login", "Product.Count", "Product.Count", "Product.Count"]);
  });

  it("says what came back when the answer is not JSON", async () => {
    const page = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    serve((method) => (method === "login" ? loginOk() : page()));
    await expect(client().count("Product")).rejects.toThrow("Product.Count: HTTP 200, not JSON (text/html, 6 bytes)");
  });

  it("never repeats a rejected login", async () => {
    serve(() => json({ success: 0, message: "Wrong password" }));
    await expect(client().count("Product")).rejects.toThrow("Customer.Login rejected: HTTP 200, Wrong password");
    expect(calls).toHaveLength(1);
  });

  it("sends the login once, even on a 5xx", async () => {
    serve(() => new Response("busy", { status: 503, headers: { "retry-after": "0" } }));
    await expect(client().count("Product")).rejects.toThrow("Customer.Login");
    expect(calls).toHaveLength(1);
  });

  it("refuses a method that is not a read before any request", async () => {
    serve(() => loginOk());
    const read = (client() as unknown as { read: (method: string, params: object) => Promise<unknown> }).read;
    await expect(read.call(client(), "Order.Add", {})).rejects.toThrow("Order.Add is not a read method");
    expect(calls).toHaveLength(0);
  });

  it("reads a List page keyed by productId, an empty page as [] and refuses a broken one", async () => {
    const pages = [
      { success: 1, data: { "6010": { CodeERP: "P327.102" }, "6051": { CodeERP: "P773.421" } } },
      { success: 1, data: [] },
      { success: 1, data: "nothing" },
      { success: 1, data: { "1": "not a record" } },
      { success: 1, data: [{ CodeERP: "P327.102" }] },
    ];
    serve((method, nth) => (method === "login" ? loginOk() : json(pages[nth - 1])));
    const axpol = client();
    expect([...(await axpol.list("Product", 2, 0)).records.keys()]).toEqual(["6010", "6051"]);
    expect((await axpol.list("Product", 2, 2)).records.size).toBe(0);
    await expect(axpol.list("Product", 2, 4)).rejects.toThrow("data is neither an object nor an empty array");
    await expect(axpol.list("Product", 2, 6)).rejects.toThrow("record 1 is not an object");
    // Records in an array are a format this client does not know: not read as an empty page
    await expect(axpol.list("Product", 2, 8)).rejects.toThrow("data is neither an object nor an empty array");
  });
});

// A feed of fake pages: the offset picks the records, as Axpol's record offset does
function fakeFeed(count: number, ids: string[]) {
  const offsets: number[] = [];
  return {
    offsets,
    count: () => Promise.resolve(count),
    list: (_feed: string, limit: number, offset: number): Promise<AxpolPage> => {
      offsets.push(offset);
      const records = new Map(ids.slice(offset, offset + limit).map((id) => [id, { CodeERP: id }]));
      return Promise.resolve({ records, bytes: 0, durationMs: 0 });
    },
  };
}

describe("readFeed", () => {
  it("reads every page until a short one and is complete when nothing is missing", async () => {
    const feed = fakeFeed(5, ["1", "2", "3", "4", "5"]);
    const read = await readFeed(feed, "Product", 2);
    expect(feed.offsets).toEqual([0, 2, 4]);
    expect(read).toMatchObject({ count: 5, pages: 3, repeated: 0, isComplete: true });
    expect(read.records.size).toBe(5);
  });

  it("is incomplete when the pages bring fewer records than the count", async () => {
    const read = await readFeed(fakeFeed(6, ["1", "2", "3"]), "Product", 2);
    expect(read).toMatchObject({ isComplete: false, pages: 2 });
  });

  it("keeps a record met twice once and counts it", async () => {
    const read = await readFeed(fakeFeed(3, ["1", "2", "2", "3"]), "Product", 2);
    expect(read).toMatchObject({ repeated: 1, isComplete: true });
    expect(read.records.size).toBe(3);
  });

  it("stops past the count when no page comes short", async () => {
    const endless = {
      count: () => Promise.resolve(2),
      list: (_feed: string, limit: number, offset: number): Promise<AxpolPage> => Promise.resolve({
        records: new Map(Array.from({ length: limit }, (_, index) => [String(offset + index), {}])), bytes: 0, durationMs: 0,
      }),
    };
    const read = await readFeed(endless, "Product", 2);
    expect(read).toMatchObject({ pages: 3, isComplete: false });
  });
});

describe("readJwtTtlSeconds", () => {
  const token = (claims: object): string =>
    `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

  it("reads exp - iat from the claims", () => {
    expect(readJwtTtlSeconds(token({ iat: 1_682_424_454, exp: 1_682_425_054 }))).toBe(600);
  });

  it("gives nothing for a token without readable or sensible claims", () => {
    expect(readJwtTtlSeconds("not-a-jwt")).toBeUndefined();
    expect(readJwtTtlSeconds(token({ exp: 1 }))).toBeUndefined();
    expect(readJwtTtlSeconds(token({ iat: 10, exp: 10 }))).toBeUndefined();
  });
});
