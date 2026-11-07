import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import { InputRejected, ProviderError } from "../embeddings/api.js";
import { BudgetReached } from "../embeddings/batch.js";
import { ModelNotConfigured, SearchTimedOut } from "./errors.js";
import type { SearchInput } from "./request.js";
import { loggedSearch, searchFailure } from "./routes.js";
import type { SearchOptions, SearchResponse, SearchService } from "./search.js";

const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(64, 16);
png.writeUInt32BE(48, 20);

const options: SearchOptions = {
  models: [{ name: "gemini-embedding-2/1536", provider: "gemini", isDefault: true, isConfigured: true }],
  sources: [{ code: "axpol", name: "Axpol", hasStock: true }],
  categories: [{ source: "axpol", path: ["DRINKWARE", "mugs"], models: 3 }],
  sharedCategories: [{
    code: "drinkware", name: { uk: "Посуд для напоїв", en: "Drinkware" }, models: 3,
    categories: [{ code: "drinkware.mugs", name: { uk: "Кружки й чашки", en: "Mugs & cups" }, models: 3 }],
  }],
  unmappedCategories: [{ source: "axpol", path: [], models: 2 }],
};

// Records what it was asked and answers with what the test sets
function fakeSearch(answer: () => Promise<SearchResponse>): SearchService & { inputs: SearchInput[] } {
  const inputs: SearchInput[] = [];
  return {
    inputs,
    search: (input) => {
      inputs.push(input);
      return answer();
    },
    options: () => Promise.resolve(options),
  };
}

const empty: SearchResponse = {
  model: "gemini-embedding-2/1536", lists: ["text-photo", "text-text"], isComplete: true, hasCloseMatch: null, queryParse: null, tookMs: 5,
  costUsd: 0, results: [],
};
let app: ReturnType<typeof buildApp> | undefined;

// A session token "u7" is user 7; anything else is no session
const auth: AuthOptions = {
  isCookieSecure: false,
  service: {
    signIn: () => Promise.resolve(null),
    userOfSession: (token) => Promise.resolve(/^u\d+$/.test(token) ? { id: Number(token.slice(1)), login: token, role: "manager" } : null),
    signOut: () => Promise.resolve(),
  },
};
const SIGNED_IN = { cookie: "session=u1" };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function post(service: SearchService, payload: unknown) {
  app = buildApp({ auth, search: service });
  return app.inject({ method: "POST", url: "/api/search", headers: SIGNED_IN, payload: payload as Record<string, unknown> });
}

describe("POST /api/search", () => {
  it("passes the text, the photo, the model and the filters to the search", async () => {
    const service = fakeSearch(() => Promise.resolve(empty));
    const response = await post(service, {
      text: "red mug", image: png.toString("base64"), model: "voyage-multimodal-3.5/1024", limit: 10, parseQuery: false,
      filters: {
        sources: ["axpol"], categories: [{ source: "axpol", path: ["DRINKWARE"] }], sharedCategories: ["drinkware", "bags.cooler"],
        minStock: 100,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...empty, searchId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string });
    const [input] = service.inputs;
    expect(input?.model).toBe("voyage-multimodal-3.5/1024");
    expect(input?.parseQuery).toBe(false);
    expect(input?.image?.info).toEqual({ mimeType: "image/png", width: 64, height: 48 });
    expect(input?.filters).toEqual({
      sources: ["axpol"], categories: [{ source: "axpol", path: ["DRINKWARE"] }], sharedCategories: ["drinkware", "bags.cooler"],
      minStock: 100,
    });
  });

  it.each([
    ["an unknown model", { text: "mug", model: "clip" }],
    ["a limit over the cap", { text: "mug", limit: 101 }],
    ["a stock below 1", { text: "mug", filters: { minStock: 0 } }],
    ["a category without a path", { text: "mug", filters: { categories: [{ source: "axpol", path: [] }] } }],
    ["an empty list of sources", { text: "mug", filters: { sources: [] } }],
    ["an empty list of shared categories", { text: "mug", filters: { sharedCategories: [] } }],
    ["a shared category code of another shape", { text: "mug", filters: { sharedCategories: ["Drinkware > mugs"] } }],
    ["a shared category three levels deep", { text: "mug", filters: { sharedCategories: ["drinkware.mugs.ceramic"] } }],
    ["a misspelt filter", { text: "mug", filters: { minstock: 5 } }],
    ["a field the API does not take", { text: "mug", lists: ["text-text"] }],
    ["a parse flag that is not a boolean", { text: "mug", parseQuery: "no" }],
  ])("answers 400 to %s, before any search", async (_title, payload) => {
    const service = fakeSearch(() => Promise.resolve(empty));
    const response = await post(service, payload);
    expect(response.statusCode).toBe(400);
    expect(service.inputs).toEqual([]);
  });

  it("answers 400 with its reason to a request without a text or a photo, or with a broken photo", async () => {
    const service = fakeSearch(() => Promise.resolve(empty));
    const noInput = await post(service, { text: " " });
    expect(noInput.json()).toEqual({ error: "give a text, an image or both" });
    await app?.close();
    const broken = await post(service, { image: Buffer.from("<html>").toString("base64") });
    expect(broken.statusCode).toBe(400);
    expect(broken.json<{ error: string }>().error).toMatch(/^the image cannot be used: not a JPEG or PNG/);
    expect(service.inputs).toEqual([]);
  });

  it("answers 200 to a search whose list stopped short, with isComplete false", async () => {
    const response = await post(fakeSearch(() => Promise.resolve({ ...empty, isComplete: false })), { text: "mug" });
    expect(response.statusCode).toBe(200);
    expect(response.json<SearchResponse>().isComplete).toBe(false);
  });

  it("reads the text by default and answers 200 with the parse even when Claude was unavailable", async () => {
    const queryParse = {
      status: "unavailable", model: "claude-haiku-5-5", reason: "timed-out", message: "no answer within 10000 ms",
    } as const;
    const service = fakeSearch(() => Promise.resolve({ ...empty, queryParse }));
    const response = await post(service, { text: "червона чашка" });
    expect(response.statusCode).toBe(200);
    expect(response.json<SearchResponse>().queryParse).toEqual(queryParse);
    expect(service.inputs[0]?.parseQuery).toBe(true);
  });

  it.each([
    [new BudgetReached("budget reached: spent $1.0000"), 429],
    [new ModelNotConfigured("voyage-multimodal-3.5/1024 is not configured: VOYAGE_API_KEY is not set"), 503],
    [new InputRejected("api.test: HTTP 400: image too small"), 422],
    [new ProviderError("api.test: HTTP 500: upstream said key k123 was fine"), 502],
  ])("answers %s with %i and a message of its own", async (error, statusCode) => {
    const response = await post(fakeSearch(() => Promise.reject(error)), { text: "mug" });
    expect(response.statusCode).toBe(statusCode);
    expect(response.body).not.toContain(error.message);
  });

  it("answers 500 to an error it does not know, without its details", async () => {
    const response = await post(fakeSearch(() => Promise.reject(new Error("relation photo does not exist"))), { text: "mug" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("photo");
  });
});

describe("searchFailure", () => {
  it("answers 504 for the search's own deadline only", () => {
    const signal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    expect(searchFailure(signal.reason, signal)?.statusCode).toBe(504);
    // The database failing after the deadline is not the provider's slowness
    expect(searchFailure(new Error("connection terminated"), signal)).toBeUndefined();
    expect(searchFailure(new ProviderError("api.test: HTTP 503"), signal)?.statusCode).toBe(502);
  });

  it("answers 504 for a nearest query past the database's timeout", () => {
    const failure = searchFailure(new SearchTimedOut("a nearest query ran past 4s"), new AbortController().signal);
    expect(failure).toEqual({ statusCode: 504, message: "the search took too long" });
  });
});

describe("loggedSearch", () => {
  it("logs the parse without the text or its English, and flags a request the API rejected", () => {
    const ok = loggedSearch({ ...empty, queryParse: {
      status: "ok", model: "claude-haiku-5-5", englishText: "red mug", products: ["red mug"], conditions: [], dropped: ["price"],
      usage: { inputTokens: 9, outputTokens: 3 },
      suggestedFilters: { sharedCategories: [], colors: ["red"], materials: [], price: null },
    } });
    expect(ok.logged.queryParse).toEqual({ model: "claude-haiku-5-5", status: "ok", usage: { inputTokens: 9, outputTokens: 3 }, dropped: ["price"] });
    expect(JSON.stringify(ok.logged)).not.toContain("red mug");
    expect(ok.warnings).toEqual([]);
    const rejected = loggedSearch({ ...empty, queryParse: {
      status: "unavailable", model: "claude-haiku-5-5", reason: "rejected", message: "HTTP 401 authentication_error",
    } });
    expect(rejected.isParseRejected).toBe(true);
    expect(rejected.warnings).toEqual(["the text was not parsed and went as it is"]);
  });
});

describe("the login", () => {
  it("answers 401 to a request without a session, before any search", async () => {
    const service = fakeSearch(() => Promise.resolve(empty));
    app = buildApp({ auth, search: service });
    for (const headers of [{}, { cookie: "session=stolen" }]) {
      const response = await app.inject({ method: "POST", url: "/api/search", headers, payload: { text: "mug" } });
      expect(response.statusCode).toBe(401);
      const options = await app.inject({ method: "GET", url: "/api/search/options", headers });
      expect(options.statusCode).toBe(401);
    }
    expect(service.inputs).toEqual([]);
  });

  it("has no search at all without the login", async () => {
    app = buildApp({ search: fakeSearch(() => Promise.resolve(empty)) });
    const response = await app.inject({ method: "POST", url: "/api/search", payload: { text: "mug" } });
    expect(response.statusCode).toBe(404);
  });
});

describe("the limit per minute", () => {
  const searchAs = (user: string, payload: Record<string, unknown>) => app?.inject({
    method: "POST", url: "/api/search", headers: { cookie: `session=${user}` }, payload,
  });

  it("answers 429 with the wait past the limit, per user, without searching", async () => {
    const service = fakeSearch(() => Promise.resolve(empty));
    app = buildApp({ auth, search: service, searchRatePerMinute: 2 });
    expect((await searchAs("u1", { text: "mug" }))?.statusCode).toBe(200);
    expect((await searchAs("u1", { text: "mug" }))?.statusCode).toBe(200);
    const refused = await searchAs("u1", { text: "mug" });
    expect(refused?.statusCode).toBe(429);
    expect(Number(refused?.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused?.json()).toEqual({ error: "too many searches in a minute" });
    expect(service.inputs).toHaveLength(2);
    expect((await searchAs("u2", { text: "mug" }))?.statusCode).toBe(200);
  });

  it("counts only what would be paid for: a refused body does not spend the limit", async () => {
    app = buildApp({ auth, search: fakeSearch(() => Promise.resolve(empty)), searchRatePerMinute: 1 });
    expect((await searchAs("u1", { text: " " }))?.statusCode).toBe(400);
    expect((await searchAs("u1", { text: "mug", limit: 101 }))?.statusCode).toBe(400);
    expect((await searchAs("u1", { text: "mug" }))?.statusCode).toBe(200);
  });
});

describe("GET /api/search/options", () => {
  it("lists the models, sources and categories", async () => {
    app = buildApp({ auth, search: fakeSearch(() => Promise.resolve(empty)) });
    const response = await app.inject({ method: "GET", url: "/api/search/options", headers: SIGNED_IN });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(options);
  });

  it("is not there without a search", async () => {
    app = buildApp({ auth });
    const response = await app.inject({ method: "GET", url: "/api/search/options", headers: SIGNED_IN });
    expect(response.statusCode).toBe(404);
  });
});
