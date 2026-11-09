import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFor, photoFetchFor } from "./registry.js";

// config.ts reads DATABASE_URL on import; the fetches need only required()
vi.mock("../config.js", () => {
  class ConfigError extends Error {}
  return {
    ConfigError,
    required: (name: string) => {
      const value = process.env[name];
      if (!value) throw new ConfigError(`${name} is not set`);
      return value;
    },
  };
});

describe("adapterFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The addresses name the client, so they live in .env, not in the public repository
  it("takes the feeds of Macma and Easy Gifts from the environment, https only and without a login", () => {
    vi.stubEnv("MACMA_FEED_URL", "");
    expect(() => adapterFor("macma")).toThrow("MACMA_FEED_URL is not set");
    vi.stubEnv("MACMA_FEED_URL", "http://shop.example/import/macma/macma.xml");
    expect(() => adapterFor("macma")).toThrow("MACMA_FEED_URL must be an https address without a login");
    vi.stubEnv("EASYGIFTS_FEED_URL", "https://user:pass@shop.example/import/easygifts/easy.xml");
    expect(() => adapterFor("easygifts")).toThrow("EASYGIFTS_FEED_URL must be an https address without a login");
    vi.stubEnv("EASYGIFTS_FEED_URL", "shop.example/easy.xml");
    expect(() => adapterFor("easygifts")).toThrow("EASYGIFTS_FEED_URL is not a URL");
    vi.stubEnv("MACMA_FEED_URL", "https://shop.example/import/macma/macma.xml");
    expect(adapterFor("macma").source.code).toBe("macma");
  });

  // The token is part of the feed addresses; away from the server the saved files need none
  it("builds Anda Present from its token, or from saved files without one", () => {
    vi.stubEnv("ANDA_FEED_DIR", "");
    vi.stubEnv("ANDA_FEED_TOKEN", "");
    expect(() => adapterFor("anda")).toThrow("ANDA_FEED_TOKEN is not set");
    vi.stubEnv("ANDA_FEED_TOKEN", "a/b");
    expect(() => adapterFor("anda")).toThrow("ANDA_FEED_TOKEN must be letters and digits only");
    vi.stubEnv("ANDA_FEED_TOKEN", "Tok3n");
    expect(adapterFor("anda").source).toEqual({ code: "anda", name: "Anda Present", kind: "supplier" });
    vi.stubEnv("ANDA_FEED_TOKEN", "");
    vi.stubEnv("ANDA_FEED_DIR", "/tmp/anda");
    expect(adapterFor("anda").source.code).toBe("anda");
  });
});

describe("photoFetchFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads Macma and Easy Gifts out of their archives", () => {
    expect(photoFetchFor("macma", [])).toBeTypeOf("function");
    expect(photoFetchFor("easygifts", [])).toBeTypeOf("function");
  });

  it("leaves a public CDN to the plain request", () => {
    for (const code of ["axpol", "midocean", "inspirion", "bluecollection", "anda"]) expect(photoFetchFor(code, [])).toBeUndefined();
  });

  it("needs Makito's keys, and takes them without a login", () => {
    vi.stubEnv("MAKITO_CLIENT_ID", "");
    vi.stubEnv("MAKITO_CLIENT_SECRET", "");
    expect(() => photoFetchFor("makito", [])).toThrow("MAKITO_CLIENT_ID is not set");
    vi.stubEnv("MAKITO_CLIENT_ID", "client");
    vi.stubEnv("MAKITO_CLIENT_SECRET", "secret");
    const secrets: string[] = [];
    expect(photoFetchFor("makito", secrets)).toBeTypeOf("function");
    // Scrubbed from every message of the run from then on
    expect(secrets).toEqual(["client", "secret"]);
  });
});
