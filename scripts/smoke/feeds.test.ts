import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBluecollection } from "./bluecollection.js";
import { assertReadOnly } from "./feeds.js";
import { runInspirion } from "./inspirion.js";
import { runMakito } from "./makito.js";
import type { Run } from "./run.js";

// The smoke flows of Makito, Inspirion and Blue Collection against a mocked network: what goes where, and that no
// credential or token reaches the saved output
const env = {
  axpolLogin: "", axpolPassword: "", axpolApiKey: "", midoceanApiKey: "",
  makitoClientId: "makito-client-id",
  makitoClientSecret: "makito-client-secret",
  inspirionApiKey: "inspirion-api-key",
  bluecollectionUsername: "bluecollection-user",
  bluecollectionPassword: "bluecollection-password",
};
const jwt = (ttlSeconds: number, tag: string) => {
  const claims = Buffer.from(JSON.stringify({ iat: 1_700_000_000, exp: 1_700_000_000 + ttlSeconds })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${claims}.${tag}-signature`;
};
const ACCESS = jwt(300, "access");
const RENEWED_ACCESS = jwt(300, "renewed");
const REFRESH = jwt(86_400, "refresh");
const MAKITO_TOKEN = jwt(3_600, "makito");
const FIVE_MINUTES_MS = 300_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

interface Call {
  url: URL;
  method: string;
  body?: string;
  authorization?: string;
  apiKey?: string;
}

let dirs: string[] = [];
let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const picture = (type = "image/jpeg") => new Response(JPEG, { headers: { "content-type": type } });
const page = (results: unknown[]) => json({ count: 1911, next: "https://developers.bluecollection.eu/x/?page=2", results });

function serve(answer: (call: Call) => Response): void {
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: input, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined,
      authorization: headers.Authorization, apiKey: headers["X-Gateway-API-Key"],
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  });
}

function newRun(): Run {
  const dir = mkdtempSync(join(tmpdir(), "smoke-feeds-"));
  dirs.push(dir);
  return { env, dir, results: [], secrets: Object.values(env).filter(Boolean) };
}

const files = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
const filesText = (dir: string) =>
  files(dir).map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n");
const outcome = (run: Run) => run.results.map((row) => [row.step, row.isOk]);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  calls = [];
});

describe("assertReadOnly", () => {
  it("lets through reads and logins, and stops order, offer, price and shipping paths before a request", () => {
    expect(() => assertReadOnly(new URL("https://apis.makito.es/catalog/files"), "GET")).not.toThrow();
    expect(() => assertReadOnly(new URL("https://developers.bluecollection.eu/api/token/refresh/"), "POST")).not.toThrow();
    for (const path of ["/orders", "/orders/sales-order", "/api/orders/", "/api/v1/create-order", "/api/v1/offers/create",
      "/api/v1/price-calculation", "/api/v1/shipping-calculation-bulk"]) {
      expect(() => assertReadOnly(new URL(`https://example.com${path}`), "GET")).toThrow("read-only");
    }
    expect(() => assertReadOnly(new URL("https://developers.bluecollection.eu/api/products/"), "POST")).toThrow("only logs in");
  });
});

describe("runBluecollection", () => {
  it("reads the first page of every feed with the access token and keeps the token pair out of the output", async () => {
    serve((call) => {
      if (call.url.pathname === "/api/token/") return json({ access: ACCESS, refresh: REFRESH });
      // A Content-Type that would lead the file name out of the run folder
      if (call.url.host === "bluecollection.eu") return picture("image/../../../escaped");
      if (call.url.pathname === "/api/products-index/") {
        return page([{ index: "02003-03", image: [{ url: "https://bluecollection.eu/assets/img/02003-03.jpg" }] }]);
      }
      return page([{ index: "02003-03", quantity: 1733 }]);
    });
    const run = newRun();
    await runBluecollection(run);
    expect(outcome(run)).toEqual([
      ["token", true], ["products-index", true], ["client-products", true], ["stock-info", true], ["marking-data", true],
      ["last-update", true], ["photo", true],
    ]);
    expect(run.results[1]?.note).toBe("first page only: 1 of 1911 records");
    const apiReads = calls.filter((call) => call.url.host === "developers.bluecollection.eu" && call.method === "GET");
    expect(apiReads.every((call) => call.authorization === `Bearer ${ACCESS}`)).toBe(true);
    expect(calls.find((call) => call.url.host === "bluecollection.eu")?.authorization).toBeUndefined();
    expect(files(run.dir).map((entry) => entry.name)).toContain("photo.jpg");
    const text = filesText(run.dir);
    for (const secret of [ACCESS, REFRESH, env.bluecollectionUsername, env.bluecollectionPassword]) {
      expect(text).not.toContain(secret);
    }
  });

  it("renews the access token after 4 minutes with the refresh token and keeps both out of the output", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve((call) => {
      if (call.url.pathname === "/api/token/") return json({ access: ACCESS, refresh: REFRESH });
      if (call.url.pathname === "/api/token/refresh/") return json({ access: RENEWED_ACCESS });
      // The first read takes five minutes
      if (call.url.pathname === "/api/products-index/") vi.setSystemTime(Date.now() + FIVE_MINUTES_MS);
      return page([{ index: "02003-03" }]);
    });
    const run = newRun();
    await runBluecollection(run);
    const renewal = calls.find((call) => call.url.pathname === "/api/token/refresh/");
    expect(renewal?.body).toBe(JSON.stringify({ refresh: REFRESH }));
    const reads = calls.filter((call) => call.method === "GET" && call.url.host === "developers.bluecollection.eu");
    expect(reads.map((call) => call.authorization)).toEqual([
      `Bearer ${ACCESS}`, ...Array.from({ length: 4 }, () => `Bearer ${RENEWED_ACCESS}`),
    ]);
    const text = filesText(run.dir);
    for (const secret of [ACCESS, RENEWED_ACCESS, REFRESH]) expect(text).not.toContain(secret);
  });

  it("does not repeat a failed login, even on a server error, and skips the feeds", async () => {
    serve(() => json({ detail: "Service unavailable" }, 503));
    const run = newRun();
    await runBluecollection(run);
    expect(calls).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ step: "token", isOk: false, note: "login failed, HTTP 503" });
    expect(run.results.slice(1).every((row) => !row.isOk && row.note === "skipped: login failed")).toBe(true);
  });
});

describe("runMakito", () => {
  it("tries a picture again with the token only on Makito's origin, knows a JPEG sent as octet-stream", async () => {
    const asset = "https://apis.makito.es/catalog/assets/15246/principal/5246-W.jpg";
    serve((call) => {
      if (call.url.pathname === "/access/auth/login") return json({ token: MAKITO_TOKEN });
      if (call.url.pathname.startsWith("/catalog/assets/")) {
        return call.authorization ? picture("application/octet-stream") : new Response("", { status: 401 });
      }
      if (call.url.pathname === "/catalog/files") return json({ products: [{ ref: "15246", image: asset }] });
      return json({ generatedAt: "2026-11-04T00:00:00Z", priceList: [{ material: "15246" }] });
    });
    const run = newRun();
    await runMakito(run);
    const photos = run.results.filter((row) => row.step.startsWith("photo"));
    expect(photos.map((row) => [row.step, row.isOk])).toEqual([["photo", false], ["photo-with-token", true]]);
    expect(run.results.find((row) => row.step === "login")?.note).toBe("token lifetime 60 min");
    expect(files(run.dir).map((entry) => entry.name)).toContain("photo-with-token.jpg");
    expect(filesText(run.dir)).not.toContain(MAKITO_TOKEN);
    expect(filesText(run.dir)).not.toContain(env.makitoClientSecret);
  });

  it("sends the token neither to another host nor over plain http", async () => {
    for (const image of ["https://cdn.example.com/5246-W.jpg", "http://apis.makito.es/catalog/assets/1/principal/a.jpg"]) {
      calls = [];
      serve((call) => {
        if (call.url.pathname === "/access/auth/login") return json({ token: MAKITO_TOKEN });
        if (call.url.host === "cdn.example.com") return new Response("", { status: 403 });
        return json({ products: [{ ref: "15246", image }] });
      });
      await runMakito(newRun());
      const withToken = calls.filter((call) => call.authorization && !call.url.href.startsWith("https://apis.makito.es/"));
      expect(withToken).toEqual([]);
      expect(calls.some((call) => call.url.protocol === "http:")).toBe(false);
    }
  });
});

describe("runInspirion", () => {
  it("sends the key to the API only, not to the picture CDN, and keeps it out of the output", async () => {
    serve((call) => {
      if (call.url.host === "media.inspirion.eu") return picture();
      if (call.url.pathname === "/api/v2/products") {
        return json([{ sku: "3176377", variants: [{ images_300: [{ image_url: "https://media.inspirion.eu/300/a.jpg" }] }] }]);
      }
      // v1 lists without page parameters come as whole arrays
      return json([{ article_id: "56-1101115", stock_dach: 5468 }]);
    });
    const run = newRun();
    await runInspirion(run);
    expect(run.results.filter((row) => !row.isOk)).toEqual([]);
    expect(run.results.at(-1)).toMatchObject({ step: "photo", isOk: true });
    expect(calls.filter((call) => call.url.host === "leoapi.inspirion.eu").every((call) => call.apiKey === env.inspirionApiKey))
      .toBe(true);
    expect(calls.find((call) => call.url.host === "media.inspirion.eu")?.apiKey).toBeUndefined();
    expect(filesText(run.dir)).not.toContain(env.inspirionApiKey);
  });
});
