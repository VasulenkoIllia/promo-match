import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { andaSource, describeFeed, feedUrl, isoTime, readFeed } from "./api.js";

// config.ts reads DATABASE_URL on import; api.ts needs only its ConfigError
vi.mock("../../config.js", () => ({ ConfigError: class ConfigError extends Error {} }));

// A made-up token: the real one is a secret in .env
const TOKEN = "Tok3nForTestsOnly0000";
const signal = new AbortController().signal;

describe("andaSource", () => {
  it("reads saved files when ANDA_FEED_DIR is set, without asking for the token", () => {
    const token = vi.fn(() => TOKEN);
    expect(andaSource("/tmp/anda", token, false)).toEqual({ kind: "directory", directory: "/tmp/anda" });
    expect(token).not.toHaveBeenCalled();
    expect(andaSource(undefined, token, true)).toEqual({ kind: "network", token: TOKEN });
  });

  it("refuses saved files on the server, where they would be an old catalogue read as complete", () => {
    expect(() => andaSource("/tmp/anda", () => TOKEN, true)).toThrow("ANDA_FEED_DIR is set in production");
  });

  it("refuses a token that could change the address, without echoing it", () => {
    for (const bad of ["../products/en", "abc/def", "abc?x=1", "abc def"]) {
      const error = (() => {
        try {
          andaSource(undefined, () => bad, false);
        } catch (caught) {
          return String(caught);
        }
        return "";
      })();
      expect(error).toContain("ANDA_FEED_TOKEN must be letters and digits only");
      expect(error).not.toContain(bad);
    }
  });
});

describe("feedUrl", () => {
  it("puts the token last in the feed's path on Anda's host", () => {
    expect(feedUrl("products", TOKEN).href).toBe(`https://xml.andapresent.com/export/products/en/${TOKEN}`);
    expect(feedUrl("inventories", TOKEN).href).toBe(`https://xml.andapresent.com/export/inventories/${TOKEN}`);
  });
});

describe("readFeed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a saved file by the feed's name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anda-"));
    try {
      await writeFile(join(directory, "labeling-en.xml"), "<labelings/>");
      const file = await readFeed({ kind: "directory", directory }, "labeling", signal);
      expect(file).toMatchObject({ xml: "<labelings/>", bytes: 12, lastModified: null, etag: null });
      expect(Date.parse(file.savedAt ?? "")).toBeGreaterThan(0);
      expect(describeFeed("labeling", file)).toBe(`anda labeling/en: 0.0 MB, a file saved ${file.savedAt ?? ""}`);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("keeps the caching headers of an answer", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("<prices/>", {
      status: 200, headers: { "last-modified": "Sat, 07 Nov 2026 07:22:00 GMT", etag: '"6af-1"' },
    })));
    vi.stubGlobal("fetch", fetch);
    const file = await readFeed({ kind: "network", token: TOKEN }, "prices", signal);
    expect(file).toMatchObject({ xml: "<prices/>", lastModified: "Sat, 07 Nov 2026 07:22:00 GMT", etag: '"6af-1"', savedAt: null });
    expect(describeFeed("prices", file)).toBe('anda prices: 0.0 MB, last-modified Sat, 07 Nov 2026 07:22:00 GMT, etag "6af-1"');
    expect(String(fetch.mock.calls[0]?.at(0))).toBe(`https://xml.andapresent.com/export/prices/${TOKEN}`);
    expect(isoTime(file.lastModified)).toBe("2026-11-07T07:22:00.000Z");
  });

  it("says what a refusal means and never names the address", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("Access Denied!", { status: 403 }))));
    const error = await readFeed({ kind: "network", token: TOKEN }, "products", signal).catch((caught: unknown) => caught);
    expect(String(error)).toContain("anda products/en: HTTP 403, this IP is not on Anda Present's list");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("scrubs the token from a failure that quotes the address", async () => {
    // A TypeError without a cause is not retried (../http.ts), so the test does not wait
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.reject(new TypeError(`invalid request to https://xml.andapresent.com/export/prices/${TOKEN}`))));
    const error = await readFeed({ kind: "network", token: TOKEN }, "prices", signal).catch((caught: unknown) => caught);
    expect(String(error)).toContain("anda prices: invalid request to https://xml.andapresent.com/export/prices/<redacted>");
    expect(String(error)).not.toContain(TOKEN);
  });
});
