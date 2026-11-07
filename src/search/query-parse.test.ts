import type Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, AuthenticationError, BadRequestError, InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryEntry } from "../categories/taxonomy.js";
import { ConfigError } from "../config.js";
import { type CreateMessage, type QueryParse, QueryParser, queryParseModelFromEnv, queryParserFromEnv, readingUsd } from "./query-parse.js";
import { memoryReadings, type ReadingKey, sha256 } from "./query-readings.js";
import { DailyBudget } from "./search.js";

// config.ts reads DATABASE_URL on import; the parse does not need it
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, required: () => "" }));

afterEach(() => {
  vi.unstubAllEnvs();
});

const categories: CategoryEntry[] = [
  { code: "drinkware", parent: null, name: { uk: "Посуд для напоїв", en: "Drinkware" }, position: 0 },
  { code: "drinkware.mugs", parent: "drinkware", name: { uk: "Кружки й чашки", en: "Mugs & cups" }, position: 0 },
  { code: "drinkware.bottles", parent: "drinkware", name: { uk: "Пляшки", en: "Bottles" }, position: 1 },
];

function product(phrase: string, fields: Record<string, unknown> = {}) {
  return { phrase, volumeMl: null, materials: [], sizeCm: null, ...fields };
}

const answer = {
  products: [product("  red ceramic   mug ", { materials: ["ceramic", "ceramic"] })],
  sharedCategories: ["drinkware.mugs"],
  colors: ["red"],
  price: { min: null, max: 100, currency: "UAH" },
};

function message(text: string, stopReason: Anthropic.StopReason = "end_turn", category: string | null = null): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_sequence: null,
    stop_reason: stopReason, stop_details: stopReason === "refusal" ? { type: "refusal", category, explanation: null } : null,
    content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text, citations: null }],
    usage: { input_tokens: 2_100, output_tokens: 60 },
  } as unknown as Anthropic.Message;
}

const answered = (fields: Record<string, unknown>) => message(JSON.stringify({ ...answer, ...fields }));

// Records the bodies it was sent and answers each call in turn with what the test gives (the last one again when
// the calls outrun them): an answer, an error, or "hang" / "hang-in-body", a call that waits for its signal and fails
// as the SDK does when it is aborted before the headers (APIUserAbortError) or while it reads the body (a DOMException)
function fakeCreate(...replies: unknown[]) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = (body, signal) => {
    const reply = replies[Math.min(bodies.length, replies.length - 1)];
    bodies.push(body);
    if (reply === "hang" || reply === "hang-in-body") {
      const aborted = () => (reply === "hang" ? new APIUserAbortError() : new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) return Promise.reject(aborted());
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(aborted())));
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { create, bodies };
}

const parser = (create: CreateMessage | undefined, budget = new DailyBudget(1, "QUERY_PARSE_BUDGET_USD"), timeoutMs?: number,
  readings = memoryReadings()) => new QueryParser("claude-haiku-5-5", budget, categories, readings, create, timeoutMs);
const signal = () => AbortSignal.timeout(5_000);
const headers = (fields: Record<string, string> = {}) => new Headers({ "request-id": "req_1", ...fields });
const noWait = { "retry-after-ms": "0" };

describe("QueryParser", () => {
  it("reads the English text and the suggested filters from a structured answer", async () => {
    const { create, bodies } = fakeCreate(answered({}));
    const parse = await parser(create).parse("червона керамічна чашка до 100 грн", signal());
    expect(parse).toEqual({
      status: "ok", model: "claude-haiku-5-5", englishText: "red ceramic mug", products: ["red ceramic mug"],
      conditions: [{ volumeMl: null, materials: ["ceramic"], sizeCm: null }],
      suggestedFilters: { sharedCategories: ["drinkware.mugs"], colors: ["red"], materials: ["ceramic"],
        price: { min: null, max: 100, currency: "UAH" } },
      dropped: [], usage: { inputTokens: 2_100, outputTokens: 60 },
    });
    const [body] = bodies;
    expect(body?.model).toBe("claude-haiku-5-5");
    expect(body?.messages).toEqual([{ role: "user", content: "червона керамічна чашка до 100 грн" }]);
    expect(body?.output_config?.effort).toBe("low");
    expect(body?.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(body?.output_config?.format?.schema)).toContain('"enum":["drinkware","drinkware.mugs","drinkware.bottles"]');
    expect(body?.system).toContain("  drinkware.mugs: Mugs & cups");
  });

  it("reads a text once and hands out copies, so a caller cannot change what is remembered", async () => {
    const { create, bodies } = fakeCreate(answered({}));
    const reader = parser(create);
    const first = await reader.parse("червона чашка", signal());
    if (first.status === "ok") first.suggestedFilters.colors.push("blue");
    const again = await reader.parse("червона чашка", signal());
    expect(bodies).toHaveLength(1);
    expect(again).toMatchObject({ status: "ok", englishText: "red ceramic mug", usage: null });
    expect(again.status === "ok" && again.suggestedFilters.colors).toEqual(["red"]);
  });

  it("does not remember a failure: the next search with the text asks again", async () => {
    const { create, bodies } = fakeCreate(new BadRequestError(400, {}, "bad", headers()), answered({}));
    const reader = parser(create);
    expect(await reader.parse("чашка", signal())).toMatchObject({ status: "unavailable", reason: "rejected" });
    expect(await reader.parse("чашка", signal())).toMatchObject({ status: "ok" });
    expect(bodies).toHaveLength(2);
  });

  it("reads the same after a restart: a new parser over the kept readings asks nothing, pays nothing and needs no key", async () => {
    const readings = memoryReadings();
    const first = await parser(fakeCreate(answered({})).create, undefined, undefined, readings).parse("чашка", signal());
    const noMoney = new DailyBudget(0, "QUERY_PARSE_BUDGET_USD");
    const again = await parser(undefined, noMoney, undefined, readings).parse("чашка", signal());
    expect(again).toEqual({ ...first, usage: null });
  });

  it("keeps an empty reading: a text that reads as nothing stays that way", async () => {
    const readings = memoryReadings();
    const first = fakeCreate(answered({ products: [] }), answered({}));
    await parser(first.create, undefined, undefined, readings).parse("pendrajw", signal());
    const again = await parser(first.create, undefined, undefined, readings).parse("pendrajw", signal());
    expect(first.bodies).toHaveLength(1);
    expect(again).toMatchObject({ status: "ok", englishText: null, products: [], usage: null });
  });

  it("reads a text again for another model or another prompt, whatever a call sends that is not the text", async () => {
    const readings = memoryReadings();
    const { create, bodies } = fakeCreate(answered({}));
    const budget = new DailyBudget(1, "QUERY_PARSE_BUDGET_USD");
    const haiku = new QueryParser("claude-haiku-5-5", budget, categories, readings, create);
    const sonnet = new QueryParser("claude-sonnet-5-5", budget, categories, readings, create);
    const fewerCategories = new QueryParser("claude-haiku-5-5", budget, categories.slice(0, 2), readings, create);
    for (const reader of [haiku, sonnet, fewerCategories]) await reader.parse("чашка", signal());
    expect(bodies).toHaveLength(3);
  });

  it("lets a reading longer than 1024 tokens arrive", async () => {
    // A need with three products, cut at max_tokens on 2026-11-01: thinking and JSON together passed the old cap
    const tokensNeeded = 1_100;
    const create: CreateMessage = (body) => Promise.resolve(
      body.max_tokens < tokensNeeded ? message('{"products": ["fleece', "max_tokens") : answered({}));
    expect(await parser(create).parse("в офис чтоб сотрудники не мёрзли зимой", signal())).toMatchObject({ status: "ok" });
  });

  it("keeps the readings kept under the old cap: a higher cap reads nothing again", async () => {
    const keys: ReadingKey[] = [];
    const { create, bodies } = fakeCreate(answered({}));
    await parser(create, undefined, undefined, {
      find: (key) => { keys.push(key); return Promise.resolve(undefined); },
      keep: (_key, kept) => Promise.resolve(kept),
    }).parse("чашка", signal());
    const { system, output_config: outputConfig } = bodies[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(keys[0]?.promptSha256).toBe(sha256(JSON.stringify({ max_tokens: 1_024, system, output_config: outputConfig })));
  });

  it("shows the answer kept first when two searches read a text at once, with what this one paid", async () => {
    const readings = memoryReadings();
    const reader = parser(fakeCreate(answered({})).create, undefined, undefined, {
      find: () => Promise.resolve(undefined),
      keep: (key) => readings.keep(key, JSON.stringify({ ...answer, products: [product("blue mug")] })),
    });
    expect(await reader.parse("чашка", signal())).toMatchObject({
      status: "ok", englishText: "blue mug", usage: { inputTokens: 2_100, outputTokens: 60 },
    });
  });

  it("keeps the model's answer under a hash of the text, never the text", async () => {
    const kept: unknown[] = [];
    const readings = memoryReadings();
    const reader = parser(fakeCreate(answered({})).create, undefined, undefined, {
      ...readings, keep: (key, value) => { kept.push(key, value); return readings.keep(key, value); },
    });
    await reader.parse("чашка для пані Олени, +380991234567", signal());
    expect(kept).toHaveLength(2);
    expect(JSON.stringify(kept)).not.toContain("Олени");
    expect(JSON.stringify(kept)).not.toContain("380991234567");
  });

  it("keeps no answer out of the contract, and is unavailable on a kept one the check has outgrown", async () => {
    const readings = memoryReadings();
    const { create, bodies } = fakeCreate(message("not json"), answered({}));
    expect(await parser(create, undefined, undefined, readings).parse("чашка", signal()))
      .toMatchObject({ status: "unavailable", reason: "bad-answer" });
    expect(await parser(create, undefined, undefined, readings).parse("чашка", signal())).toMatchObject({ status: "ok" });
    expect(bodies).toHaveLength(2);
    const outgrown = parser(create, undefined, undefined, {
      find: () => Promise.resolve("not json"), keep: (_key, value) => Promise.resolve(value),
    });
    expect(await outgrown.parse("чашка", signal())).toMatchObject({ status: "unavailable", reason: "bad-answer" });
    expect(bodies).toHaveLength(2);
  });

  it("fails the search when the readings cannot be reached: a mistake of ours, not the model's", async () => {
    const reader = parser(fakeCreate(answered({})).create, undefined, undefined, {
      find: () => Promise.reject(new Error("no database")), keep: (_key, value) => Promise.resolve(value),
    });
    await expect(reader.parse("чашка", signal())).rejects.toThrow("no database");
  });

  it.each([
    ["a refusal", message("", "refusal", "cyber"), "refused", "the model refused (cyber)"],
    ["an answer cut at max_tokens", message('{"products": ["red', "max_tokens"), "bad-answer", "the answer stopped at max_tokens"],
    ["broken JSON", message('{"products": ["red mug"],'), "bad-answer", "the answer is not JSON (25 characters)"],
    ["products that are not products", answered({ products: [5] }), "bad-answer", "products is not a list of products"],
    ["a proxy's page instead of JSON", "<html>bad gateway</html>", "bad-answer", "the answer is not a message (string)"],
  ])("is unavailable after %s, without quoting the answer", async (_title, reply, reason, text) => {
    const parse = await parser(fakeCreate(reply).create).parse("червона чашка", signal());
    expect(parse).toEqual({ status: "unavailable", model: "claude-haiku-5-5", reason, message: text });
  });

  it.each([
    ["a category out of the list", { sharedCategories: ["drinkware.cups"] }, "sharedCategories"],
    ["no colours", { colors: undefined }, "colors"],
    ["eleven materials", { products: [product("red ceramic mug", { materials: Array.from({ length: 11 }, (_, index) => `material ${index}`) })] }, "materials"],
    ["a capacity upside down", { products: [product("red ceramic mug", { volumeMl: { min: 500, max: 100 } })] }, "volumeMl"],
    ["a capacity below 0", { products: [product("red ceramic mug", { volumeMl: { min: -1, max: null } })] }, "volumeMl"],
    ["four sides", { products: [product("red ceramic mug", { sizeCm: { min: [1, 2, 3, 4], max: [] } })] }, "sizeCm"],
    ["a side of 0", { products: [product("red ceramic mug", { sizeCm: { min: [0], max: [] } })] }, "sizeCm"],
    ["a price below 0", { price: { min: -1, max: null, currency: null } }, "price"],
    ["a price range upside down", { price: { min: 50, max: 10, currency: "EUR" } }, "price"],
    ["a currency out of the list", { price: { min: null, max: 10, currency: "GBP" } }, "price"],
  ])("keeps the translation and leaves out a suggestion after %s", async (_title, fields, field) => {
    const parse = await parser(fakeCreate(answered(fields)).create).parse("червона чашка", signal());
    expect(parse).toMatchObject({ status: "ok", englishText: "red ceramic mug", dropped: [field] });
    expect(parse.status === "ok" && parse.suggestedFilters.sharedCategories).toEqual(field === "sharedCategories" ? [] : ["drinkware.mugs"]);
  });

  it("reads several products, each its own phrase, and names those past the most it takes", async () => {
    const parse = await parser(fakeCreate(answered({ products: ["thermo mug", "plastic bottle", "thermo mug"].map((phrase) => product(phrase)) })).create)
      .parse("термочашки й пластикові пляшки", signal());
    expect(parse).toMatchObject({ status: "ok", englishText: "thermo mug; plastic bottle", products: ["thermo mug", "plastic bottle"] });
    const many = await parser(fakeCreate(answered({ products: ["a", "b", "c", "d", "e"].map((phrase) => product(phrase)) })).create).parse("багато", signal());
    expect(many).toMatchObject({ products: ["a", "b", "c", "d"], dropped: ["products"] });
  });

  it("keeps what is asked of each product with that product, in its order", async () => {
    const parse = await parser(fakeCreate(answered({
      products: [
        product("thermo mug", { volumeMl: { min: 300, max: null }, materials: ["stainless-steel"] }),
        product("thermo mug", { volumeMl: { min: 900, max: null } }),
        product("tote bag", { sizeCm: { min: [30, 40], max: [] } }),
      ],
    })).create).parse("термочашки від 300 мл і сумки від 30х40", signal());
    expect(parse).toMatchObject({
      products: ["thermo mug", "tote bag"],
      conditions: [
        { volumeMl: { min: 300, max: null }, materials: ["stainless-steel"], sizeCm: null },
        { volumeMl: null, materials: [], sizeCm: { min: [40, 30], max: [] } },
      ],
    });
    expect(parse.status === "ok" && parse.suggestedFilters.materials).toEqual(["stainless-steel"]);
  });

  it("leaves out a material off the list and a bound of nothing", async () => {
    const parse = await parser(fakeCreate(answered({
      products: [product("bag", { materials: ["unobtainium", "cotton"], volumeMl: { min: 0, max: null }, sizeCm: { min: [], max: [] } })],
    })).create).parse("сумка", signal());
    expect(parse).toMatchObject({ conditions: [{ volumeMl: null, materials: ["cotton"], sizeCm: null }], dropped: [] });
  });

  it("gives no English text for a query of a price only, keeping its suggestion", async () => {
    const parse = await parser(fakeCreate(answered({ products: [product(" ")], sharedCategories: [], colors: [] })).create)
      .parse("до 100 грн", signal());
    expect(parse).toMatchObject({ status: "ok", englishText: null, dropped: [] });
    expect(parse.status === "ok" && parse.suggestedFilters.price).toEqual({ min: null, max: 100, currency: "UAH" });
  });

  it("takes control characters out of what the model wrote", async () => {
    const parse = await parser(fakeCreate(answered({ products: [product("red\u001b[31m mug", { materials: ["glass\u0007"] })] })).create)
      .parse("чашка", signal());
    expect(parse).toMatchObject({ status: "ok", englishText: "red [31m mug" });
    expect(parse.status === "ok" && parse.suggestedFilters.materials).toEqual(["glass"]);
  });

  it.each([
    ["400", new BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "output_config.effort:\nnot supported" } },
      "bad", headers(), "invalid_request_error"), "HTTP 400 invalid_request_error, request req_1: output_config.effort: not supported"],
    ["401", new AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      "bad", headers(), "authentication_error"), "HTTP 401 authentication_error, request req_1: invalid x-api-key"],
  ])("is rejected after %s, once, with the API's explanation of it", async (_title, error, text) => {
    const { create, bodies } = fakeCreate(error);
    expect(await parser(create).parse("чашка", signal())).toEqual({
      status: "unavailable", model: "claude-haiku-5-5", reason: "rejected", message: text,
    });
    expect(bodies).toHaveLength(1);
  });

  it.each([
    ["429", new RateLimitError(429, {}, "rate limited", headers(noWait), "rate_limit_error"), "HTTP 429 rate_limit_error, request req_1"],
    ["500", new InternalServerError(500, {}, "boom", headers(noWait), "api_error"), "HTTP 500 api_error, request req_1"],
    ["529", new InternalServerError(529, {}, "overloaded", headers(noWait), "overloaded_error"), "HTTP 529 overloaded_error, request req_1"],
    ["a network error", new APIConnectionError({ message: "socket hang up", cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }),
      "a network error (ENOTFOUND)"],
  ])("tries again once after %s and is unavailable when that fails too, told by status", async (_title, error, text) => {
    const { create, bodies } = fakeCreate(error);
    expect(await parser(create).parse("чашка", signal())).toEqual({
      status: "unavailable", model: "claude-haiku-5-5", reason: "provider-failed", message: text,
    });
    expect(bodies).toHaveLength(2);
  });

  it("answers from the retry when it succeeds", async () => {
    const { create, bodies } = fakeCreate(new InternalServerError(529, {}, "overloaded", headers(noWait), "overloaded_error"), answered({}));
    expect(await parser(create).parse("чашка", signal())).toMatchObject({ status: "ok", englishText: "red ceramic mug" });
    expect(bodies).toHaveLength(2);
  });

  it("does not wait out a Retry-After the deadline cannot hold, and tells the status at once", async () => {
    const { create, bodies } = fakeCreate(new RateLimitError(429, {}, "slow down", headers({ "retry-after": "30" }), "rate_limit_error"));
    const started = performance.now();
    expect(await parser(create).parse("чашка", signal())).toMatchObject({
      reason: "provider-failed", message: "HTTP 429 rate_limit_error, request req_1",
    });
    expect(bodies).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ["a body cut short", new TypeError("terminated")],
    ["a body that is not JSON", new SyntaxError("Unexpected token < in JSON")],
    ["a key the headers cannot carry", new TypeError('Headers.append: "Bearer sk-ant-KEY\nX" is an invalid header value.')],
  ])("is unavailable after %s, never quoting the error's own message", async (_title, error) => {
    const parse = await parser(fakeCreate(error).create).parse("чашка", signal());
    expect(parse).toEqual({
      status: "unavailable", model: "claude-haiku-5-5", reason: "provider-failed", message: `the client failed (${error.name})`,
    });
  });

  it("is unavailable after an attempt's timeout, without a retry, and after its own deadline, before or in the body", async () => {
    const { create, bodies } = fakeCreate(new APIConnectionTimeoutError());
    expect(await parser(create).parse("чашка", signal())).toMatchObject({
      reason: "timed-out", message: "an attempt ran past 8000 ms",
    });
    expect(bodies).toHaveLength(1);
    for (const reply of ["hang", "hang-in-body"] as const) {
      expect(await parser(fakeCreate(reply).create, undefined, 20).parse("чашка", signal())).toMatchObject({
        reason: "timed-out", message: "no answer within 20 ms",
      });
    }
  });

  it("stops with the search when the search's own signal is aborted, and pays nothing when it already was", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const pending = parser(fakeCreate("hang-in-body").create).parse("чашка", controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const budget = new DailyBudget(1, "QUERY_PARSE_BUDGET_USD");
    const reserve = vi.spyOn(budget, "reserve");
    const { create, bodies } = fakeCreate(answered({}));
    await expect(parser(create, budget).parse("чашка", AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(reserve).not.toHaveBeenCalled();
    expect(bodies).toEqual([]);
  });

  it("makes no call past the day's budget, priced before the call", async () => {
    const { create, bodies } = fakeCreate(answered({}));
    const parse = await parser(create, new DailyBudget(0.000_001, "QUERY_PARSE_BUDGET_USD")).parse("чашка", signal());
    expect(parse).toEqual({
      status: "unavailable", model: "claude-haiku-5-5", reason: "budget-spent", message: "the day's QUERY_PARSE_BUDGET_USD is spent",
    });
    expect(bodies).toEqual([]);
  });

  it("prices a reading by the tokens the API counted, and a kept or failed one at nothing", () => {
    const ok = { status: "ok", model: "claude-haiku-5-5", usage: { inputTokens: 7_346, outputTokens: 154 } } as QueryParse;
    expect(readingUsd(ok)).toBeCloseTo((7_346 * 0.1 + 154 * 0.5) / 1_000_000, 12);
    expect(readingUsd({ ...ok, model: "claude-opus-5-5" })).toBeCloseTo((7_346 * 4 + 154 * 20) / 1_000_000, 12);
    expect(readingUsd({ ...ok, usage: null } as QueryParse)).toBe(0);
    expect(readingUsd({ status: "unavailable", model: "claude-haiku-5-5", reason: "timed-out", message: "" })).toBe(0);
    expect(readingUsd(null)).toBe(0);
  });

  it("prices a call generously at the model's list prices, the output at its cap", () => {
    const reader = parser(undefined);
    // The output cap alone: 1536 tokens at $0.50 per million
    expect(reader.priceUsd("")).toBeGreaterThan(0.000_768);
    expect(reader.priceUsd("x".repeat(2_000)) - reader.priceUsd("")).toBeCloseTo(1_000 * 0.1 / 1_000_000, 12);
    const opus = new QueryParser("claude-opus-5-5", new DailyBudget(1), categories, memoryReadings(), undefined);
    expect(opus.priceUsd("x".repeat(2_000)) - opus.priceUsd("")).toBeCloseTo(1_000 * 4 / 1_000_000, 12);
  });

  it("is unavailable without a key and makes no call", async () => {
    const reader = parser(undefined);
    expect(reader.isConfigured).toBe(false);
    expect(await reader.parse("чашка", signal())).toEqual({
      status: "unavailable", model: "claude-haiku-5-5", reason: "not-configured", message: "ANTHROPIC_API_KEY is not set",
    });
  });

  it("fails the search on a mistake of its own rather than hide it", async () => {
    const reader = parser(fakeCreate(answered({})).create);
    const mistake = new TypeError("cannot read properties of undefined");
    vi.spyOn(reader, "priceUsd").mockImplementation(() => {
      throw mistake;
    });
    await expect(reader.parse("чашка", signal())).rejects.toBe(mistake);
  });
});

describe("the parse from the environment", () => {
  it("takes the model from QUERY_PARSE_MODEL, Haiku when it is empty, and refuses another", () => {
    vi.stubEnv("QUERY_PARSE_MODEL", "");
    expect(queryParseModelFromEnv()).toBe("claude-haiku-5-5");
    vi.stubEnv("QUERY_PARSE_MODEL", "claude-sonnet-5-5");
    expect(queryParseModelFromEnv()).toBe("claude-sonnet-5-5");
    vi.stubEnv("QUERY_PARSE_MODEL", "claude-haiku-4-5");
    expect(() => queryParseModelFromEnv()).toThrow(ConfigError);
  });

  it("is off without a key and refuses a key a header cannot carry, without quoting it", () => {
    const budget = new DailyBudget(1, "QUERY_PARSE_BUDGET_USD");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(queryParserFromEnv(budget, memoryReadings(), "claude-haiku-5-5").isConfigured).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-KEY\n");
    expect(() => queryParserFromEnv(budget, memoryReadings(), "claude-haiku-5-5")).toThrow(ConfigError);
    expect(() => queryParserFromEnv(budget, memoryReadings(), "claude-haiku-5-5")).not.toThrow(/sk-ant/);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-KEY");
    expect(queryParserFromEnv(budget, memoryReadings(), "claude-haiku-5-5").isConfigured).toBe(true);
  });
});
