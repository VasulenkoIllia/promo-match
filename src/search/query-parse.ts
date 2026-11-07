// The text of a search read by Claude before it is embedded (docs/integrations.md, «Claude API»): translated into
// English, the language of the catalogue's texts, and the filters it names (shared categories, colours, materials,
// price) returned as suggestions for the client to apply; none of them narrows the search by itself (decision of the
// owner 2026-10-30). When the model cannot be used (no key, the day's budget spent, a timeout, an API or network error,
// a refusal, an answer out of shape) the search goes on with the text as it is: both embedding models read Ukrainian.
// A text read once is not read again (src/search/query-readings.ts): the same text gives the same results, a restart
// included. The prompt, the schema and the check of the answer: src/search/query-parse-contract.ts. Neither the query nor the
// answer is logged: a failure is told in our own words, by its kind, HTTP status and request id (and, for a request
// the API rejected, the API's explanation of it).
import { setTimeout as sleep } from "node:timers/promises";
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { type CategoryEntry, loadTaxonomy } from "../categories/taxonomy.js";
import { ConfigError } from "../config.js";
import { BudgetReached } from "../embeddings/batch.js";
import { isRecord } from "../suppliers/normalize.js";
import {
  answerText, cleanText, outputSchema, ParseFailed, type ParsedQuery, type ParseFailure, readParsedQuery, systemPrompt,
} from "./query-parse-contract.js";
import { type QueryReadings, readingKey, sha256 } from "./query-readings.js";
import type { DailyBudget } from "./search.js";

// List prices in USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10-30); Haiku's are
// for prompts up to 100K tokens, ours are a few thousand. The budget prices each call with them before it goes. Sonnet
// and Opus are here for the quality test (stage 8): whether a larger model reads the queries better.
const QUERY_PARSE_MODELS = {
  "claude-haiku-5-5": { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
  "claude-sonnet-5-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  "claude-opus-5-5": { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
} as const;
export type QueryParseModel = keyof typeof QUERY_PARSE_MODELS;
export const QUERY_PARSE_MODEL_NAMES = Object.keys(QUERY_PARSE_MODELS) as QueryParseModel[];
const DEFAULT_QUERY_PARSE_MODEL: QueryParseModel = "claude-haiku-5-5";

export const API_URL = "https://api.anthropic.com";
// Room for a little thinking at low effort and the JSON of a long query: a need read as three products took 909 tokens
// in the tests and went past 1024 on 2026-11-01, cut short
const MAX_TOKENS = 1_536;
// The cap the kept readings went in with, which stays in a reading's key: a higher cap lets a long reading arrive and
// changes no other, so it must not read every text again
const KEYED_MAX_TOKENS = 1_024;
// An attempt has 8 s, the time of a whole cap (0.8 s, then 244 tokens a second, measured 2026-11-01), the parse 10 s. One
// retry after a 429, a 5xx or a network error, and only when the wait the API asks for (Retry-After) leaves the retry
// 2 s of the deadline: the SDK's own retries are off, since it waits out any Retry-After, however long, and the status
// that explains the wait is lost.
const ATTEMPT_TIMEOUT_MS = 8_000;
const PARSE_TIMEOUT_MS = 10_000;
const RETRY_WAIT_MS = 500;
const MIN_RETRY_ATTEMPT_MS = 2_000;
// Statuses of a request the API will not take, whatever the wait: our parameters, the model's name or the key
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422]);
const MAX_EXPLANATION_CHARS = 200;
// A value a header can carry: a key pasted with a space or a line break would fail every call with the key in the error
const API_KEY_SHAPE = /^[\x21-\x7e]+$/;
// The API's error type and request id are passed on only in their known shapes
const ERROR_TYPE_SHAPE = /^[a-z_]{1,40}$/;
const REQUEST_ID_SHAPE = /^req_[A-Za-z0-9]{1,64}$/;
const CAUSE_CODE_SHAPE = /^[A-Z0-9_]{1,40}$/;
const MAX_CAUSE_DEPTH = 3;
// Tokens counted generously for the budget: Cyrillic and Claude's newer tokenizer take more tokens a character than
// English does
const CHARS_PER_TOKEN = 2;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type QueryParse =
  // usage null: the text was read before, no call was made
  | { status: "ok"; model: QueryParseModel } & ParsedQuery & { usage: Usage | null }
  | { status: "unavailable"; model: QueryParseModel; reason: ParseFailure; message: string };

// A reading at list prices, by the tokens the API counted. A kept reading cost nothing. A failed one counts as nothing
// too, though the API bills an answer we turned down (cut short, refused, out of the contract): this can fall short of
// the bill, unlike the budget, which counts every call in advance.
export function readingUsd(parse: QueryParse | null): number {
  if (parse?.status !== "ok" || !parse.usage) return 0;
  return callUsd(parse.model, parse.usage);
}

// A call of the model at list prices: by the tokens the API counted, or by a generous count before it goes
export function callUsd(model: QueryParseModel, { inputTokens, outputTokens }: Usage): number {
  const { inputUsdPerMTok, outputUsdPerMTok } = QUERY_PARSE_MODELS[model];
  return (inputTokens * inputUsdPerMTok + outputTokens * outputUsdPerMTok) / 1_000_000;
}

// One call to the Messages API; the SDK's client in production, a fake in the tests. unknown: a proxy's answer that is
// not JSON comes back as a string.
export type CreateMessage = (body: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal) => Promise<unknown>;

export function isQueryParseModel(name: string): name is QueryParseModel {
  return Object.hasOwn(QUERY_PARSE_MODELS, name);
}

// instanceof alone narrows to APIError<any, any, any>
function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function apiStatus(error: APIError): string {
  const type = error.type && ERROR_TYPE_SHAPE.test(error.type) ? ` ${error.type}` : "";
  const request = error.requestID && REQUEST_ID_SHAPE.test(error.requestID) ? `, request ${error.requestID}` : "";
  return `HTTP ${String(error.status)}${type}${request}`;
}

// The API's own words on a request it rejected: they name a parameter of ours, the model or the key, not the query
function apiExplanation(error: APIError): string {
  const body: unknown = error.error;
  const explanation = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
    ? body.error.message : "";
  return cleanText(explanation).slice(0, MAX_EXPLANATION_CHARS);
}

// The code of a network failure a few causes down (ENOTFOUND, ECONNRESET)
function causeCode(error: unknown): string {
  let cause = isRecord(error) ? error.cause : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(cause); depth += 1) {
    if (typeof cause.code === "string" && CAUSE_CODE_SHAPE.test(cause.code)) return ` (${cause.code})`;
    cause = cause.cause;
  }
  return "";
}

// What a failed call to the API comes to. Anything the SDK's call throws is the API's or the network's (a body cut
// short, a proxy's page, a key the headers cannot carry): an error's own message is never used, it may hold the key.
function callFailure(error: unknown, deadline: AbortSignal, timeoutMs: number): ParseFailed {
  if (deadline.aborted) return new ParseFailed("timed-out", `no answer within ${timeoutMs} ms`);
  if (error instanceof APIConnectionTimeoutError) {
    return new ParseFailed("timed-out", `an attempt ran past ${ATTEMPT_TIMEOUT_MS} ms`);
  }
  if (isApiError(error) && error.status !== undefined) {
    if (REJECTED_STATUSES.has(error.status)) {
      return new ParseFailed("rejected", `${apiStatus(error)}: ${apiExplanation(error)}`);
    }
    return new ParseFailed("provider-failed", apiStatus(error));
  }
  const what = error instanceof APIConnectionError
    ? "a network error" : `the client failed (${error instanceof Error ? error.name : typeof error})`;
  return new ParseFailed("provider-failed", `${what}${causeCode(error)}`);
}

// The wait before the one retry, for a failure worth one (429, 5xx, a network error): what the API asks for, or a short
// pause. An attempt that ran out of its own time leaves too little of the deadline for another.
function retryWaitMs(error: unknown): number | undefined {
  if (error instanceof APIConnectionTimeoutError) return undefined;
  if (error instanceof APIConnectionError) return RETRY_WAIT_MS;
  if (!isApiError(error) || error.status === undefined) return undefined;
  if (error.status !== 429 && error.status < 500) return undefined;
  const afterMs = Number(error.headers?.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(afterMs) && afterMs >= 0) return afterMs;
  const after = error.headers?.get("retry-after");
  if (!after) return RETRY_WAIT_MS;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(after);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : RETRY_WAIT_MS;
}

async function callWithRetry(create: CreateMessage, body: Anthropic.MessageCreateParamsNonStreaming,
  deadline: AbortSignal, deadlineAtMs: number): Promise<unknown> {
  try {
    return await create(body, deadline);
  } catch (error) {
    const waitMs = retryWaitMs(error);
    const isTooLate = waitMs === undefined || performance.now() + waitMs + MIN_RETRY_ATTEMPT_MS > deadlineAtMs;
    if (isTooLate || deadline.aborted) throw error;
    await sleep(waitMs, undefined, { signal: deadline });
    return create(body, deadline);
  }
}

export class QueryParser {
  readonly #system: string;
  readonly #schema: Record<string, unknown>;
  readonly #codes: ReadonlySet<string>;
  // All a call sends but the model and the text; a change in any of it but the cap reads every text again
  readonly #request: Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "messages">;
  readonly #promptSha256: string;

  // createMessage undefined: no key, a text not read before is unavailable and the search runs on the text as it is
  constructor(readonly model: QueryParseModel, private readonly budget: DailyBudget, categories: CategoryEntry[],
    private readonly readings: QueryReadings, private readonly createMessage: CreateMessage | undefined,
    private readonly timeoutMs = PARSE_TIMEOUT_MS) {
    const codes = categories.map((entry) => entry.code);
    this.#system = systemPrompt(categories);
    this.#schema = outputSchema(codes);
    this.#codes = new Set(codes);
    this.#request = {
      max_tokens: MAX_TOKENS,
      system: this.#system,
      // Thinking stays adaptive (it cannot be turned off on Opus 5.5); low effort keeps it short
      output_config: { effort: "low", format: { type: "json_schema", schema: this.#schema } },
    };
    this.#promptSha256 = sha256(JSON.stringify({ ...this.#request, max_tokens: KEYED_MAX_TOKENS }));
  }

  get isConfigured(): boolean {
    return this.createMessage !== undefined;
  }

  // A call at list prices before it goes: the prompt, the schema and the query counted generously, the output at its
  // cap. The retry is counted once, though the API may bill each attempt.
  priceUsd(text: string): number {
    const chars = this.#system.length + JSON.stringify(this.#schema).length + text.length;
    const { inputUsdPerMTok, outputUsdPerMTok } = QUERY_PARSE_MODELS[this.model];
    return (Math.ceil(chars / CHARS_PER_TOKEN) * inputUsdPerMTok + MAX_TOKENS * outputUsdPerMTok) / 1_000_000;
  }

  // Never fails the search for the model's sake, only for a mistake of ours, the database's among them; the search's own
  // deadline or a stop still stops it. A kept answer the check has outgrown is unavailable like any answer out of shape.
  async parse(text: string, signal: AbortSignal): Promise<QueryParse> {
    const key = readingKey(this.model, this.#promptSha256, text);
    try {
      const kept = await this.readings.find(key);
      if (kept !== undefined) return this.#reading(kept, null);
      const { answer, usage } = await this.#ask(text, signal);
      return this.#reading(await this.readings.keep(key, answer), usage);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ParseFailed) {
        return { status: "unavailable", model: this.model, reason: error.reason, message: error.message };
      }
      if (error instanceof BudgetReached) {
        const message = `the day's ${this.budget.limitName} is spent`;
        return { status: "unavailable", model: this.model, reason: "budget-spent", message };
      }
      throw error;
    }
  }

  #reading(answer: string, usage: Usage | null): QueryParse {
    return { status: "ok", model: this.model, ...readParsedQuery(answer, this.#codes), usage };
  }

  // The answer comes back checked: one out of the contract is not kept
  async #ask(text: string, signal: AbortSignal) {
    if (!this.createMessage) throw new ParseFailed("not-configured", "ANTHROPIC_API_KEY is not set");
    signal.throwIfAborted();
    this.budget.reserve(this.priceUsd(text));
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model, ...this.#request, messages: [{ role: "user", content: text }],
    };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let answer: unknown;
    try {
      answer = await callWithRetry(this.createMessage, body, deadline, performance.now() + this.timeoutMs);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw callFailure(error, deadline, this.timeoutMs);
    }
    const json = answerText(answer);
    readParsedQuery(json, this.#codes);
    const { usage } = answer as Anthropic.Message;
    return {
      answer: json, usage: { inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens) },
    };
  }
}

export function queryParseModelFromEnv(): QueryParseModel {
  const raw = process.env.QUERY_PARSE_MODEL;
  if (!raw) return DEFAULT_QUERY_PARSE_MODEL;
  if (!isQueryParseModel(raw)) {
    throw new ConfigError(`QUERY_PARSE_MODEL must be one of ${QUERY_PARSE_MODEL_NAMES.join(", ")}, got "${raw}"`);
  }
  return raw;
}

// The key comes from ANTHROPIC_API_KEY only, never from a login profile of the machine. The address and the log level
// are set here rather than taken from ANTHROPIC_BASE_URL and ANTHROPIC_LOG: a proxy of the shell would get the key and
// the text, and the SDK's debug log prints the request's body. ANTHROPIC_CUSTOM_HEADERS the SDK cannot be told to skip.
export function queryParserFromEnv(budget: DailyBudget, readings: QueryReadings, model = queryParseModelFromEnv()): QueryParser {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && !API_KEY_SHAPE.test(apiKey)) {
    throw new ConfigError("ANTHROPIC_API_KEY has a character a header cannot carry (a space or a line break?)");
  }
  const client = apiKey
    ? new Anthropic({ apiKey, baseURL: API_URL, logLevel: "off", maxRetries: 0, timeout: ATTEMPT_TIMEOUT_MS })
    : undefined;
  const createMessage: CreateMessage | undefined = client && ((body, signal) => client.messages.create(body, { signal }));
  return new QueryParser(model, budget, loadTaxonomy().entries, readings, createMessage);
}
