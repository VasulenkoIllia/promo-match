import { afterEach, describe, expect, it, vi } from "vitest";
import { isMidoceanFileLink, MidoceanClient, MidoceanError, midoceanUrl } from "./api.js";

const API_KEY = "midocean-api-key";
const FILE = "https://midocean-prd-atp-prd.s3.amazonaws.com/atp.json?X-Amz-Security-Token=tok&X-Amz-Signature=sig";
const feed = { name: "stock", path: "stock/2.0", query: {} };

interface Call {
  url: string;
  apiKey?: string;
  range?: string;
}

let calls: Call[] = [];

function serve(answer: (url: URL) => Response): void {
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: input.href, apiKey: headers["x-Gateway-APIKey"], range: headers.Range });
    return Promise.resolve(answer(input));
  });
}

const redirect = (location: string) => new Response(null, { status: 303, headers: { location } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(secrets: string[] = []): MidoceanClient {
  return new MidoceanClient(API_KEY, secrets, new AbortController().signal);
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

describe("midoceanUrl and isMidoceanFileLink", () => {
  it("builds read feeds only", () => {
    expect(midoceanUrl({ name: "products", path: "products/2.0", query: { language: "en" } }).href)
      .toBe("https://api.midocean.com/gateway/products/2.0?language=en");
    expect(() => midoceanUrl({ name: "order", path: "order/2.1/create", query: {} })).toThrow("is not a read feed");
    expect(() => midoceanUrl({ name: "x", path: "../stock/2.0", query: {} })).toThrow("is not a read feed");
  });

  it("accepts https links to Midocean's S3 buckets only", () => {
    expect(isMidoceanFileLink(new URL(FILE))).toBe(true);
    expect(isMidoceanFileLink(new URL("http://midocean-prd-atp-prd.s3.amazonaws.com/atp.json"))).toBe(false);
    expect(isMidoceanFileLink(new URL("https://evil.s3.amazonaws.com/atp.json"))).toBe(false);
    expect(isMidoceanFileLink(new URL("https://u:p@midocean-prd-atp-prd.s3.amazonaws.com/atp.json"))).toBe(false);
  });
});

describe("MidoceanClient.read", () => {
  it("follows the gateway's link to the S3 file without the API key", async () => {
    serve((url) => (url.host === "api.midocean.com" ? redirect(FILE) : json({ modified_at: "x", stock: [{ sku: "A", qty: 1 }] })));
    const secrets: string[] = [];
    const file = await client(secrets).read(feed);
    expect(file.json).toEqual({ modified_at: "x", stock: [{ sku: "A", qty: 1 }] });
    expect(calls).toEqual([
      { url: "https://api.midocean.com/gateway/stock/2.0", apiKey: API_KEY, range: undefined },
      { url: FILE, apiKey: undefined, range: undefined },
    ]);
    // The link's credentials are scrubbed from logs from now on
    expect(secrets).toEqual(expect.arrayContaining([API_KEY, FILE, "tok", "sig"]));
  });

  it("reads a feed the gateway answers itself", async () => {
    serve(() => json({ currency: "EUR", price: [] }));
    expect((await client().read({ name: "pricelist", path: "pricelist/2.0/", query: {} })).json)
      .toEqual({ currency: "EUR", price: [] });
  });

  it("does not follow a link anywhere else", async () => {
    serve(() => redirect("https://example.com/atp.json"));
    await expect(client().read(feed)).rejects.toThrow("not to a Midocean file on S3, not followed");
    expect(calls).toHaveLength(1);
  });

  it("refuses an answer that is not 200 or not JSON", async () => {
    serve(() => new Response("missing", { status: 404 }));
    await expect(client().read(feed)).rejects.toThrow(new MidoceanError("stock: HTTP 404"));
    serve(() => new Response("<html>", { status: 200 }));
    await expect(client().read(feed)).rejects.toThrow("stock: the answer is not JSON");
  });
});

describe("MidoceanClient.peek", () => {
  it("asks the file for its first bytes only", async () => {
    serve((url) => (url.host === "api.midocean.com"
      ? redirect(FILE)
      : new Response("[{", { status: 206, headers: { "content-range": "bytes 0-63/36246203" } })));
    expect(await client().peek(feed, 64)).toEqual({ status: 206, path: "/atp.json", size: "bytes 0-63/36246203" });
    expect(calls[1]?.range).toBe("bytes=0-63");
  });
});
