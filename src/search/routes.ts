// The search API of stage 4 (docs/integrations.md, «Пошук»).
//   POST /api/search          { text?, image?, model?, limit?, parseQuery?, conditionPass?, filters?: { sources?,
//                               categories?, sharedCategories?, minStock? } }
//   GET  /api/search/options  the models the screen offers (and which are configured), sources (and which have stock),
//                             the suppliers' category paths and the shared categories with counts, the paths no shared
//                             category covers
// An answer carries a searchId of its own, kept nowhere: the grades of that search come back with it (src/grades).
// Behind the login, registered in the signed-in scope of src/app.ts. A user's paid searches are limited per minute on top
// of the daily budgets. The body and the reference photo are never logged: Fastify's request line has no body
// (src/app.ts, requestLine), and an error's message is logged without long base64.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { RateLimiter } from "../auth/rate-limit.js";
import { signedInUser } from "../auth/routes.js";
import { InputRejected, ProviderError } from "../embeddings/api.js";
import { BudgetReached } from "../embeddings/batch.js";
import { ModelNotConfigured, SearchInputError, SearchTimedOut } from "./errors.js";
import type { QueryParse } from "./query-parse.js";
import { parseSearchBody, SEARCH_BODY_LIMIT_BYTES, type SearchBody, searchBodySchema, type SearchInput } from "./request.js";
import type { SearchResponse, SearchService } from "./search.js";

// Claude's reading of the text (up to 10 s, src/search/query-parse.ts), then the embedding provider's call with its
// retries (30 s); past this the client gets 504 rather than a hanging request
const SEARCH_TIMEOUT_MS = 40_000;
// A person searches up to about 10 times a minute; a script with a stolen session is held well below the daily budgets
const DEFAULT_RATE_PER_MINUTE = 20;
const MINUTE_MS = 60_000;
// A provider's refusal may quote its input: a base64 run this long is cut from the logged message
const LOGGED_BASE64 = /[A-Za-z0-9+/=]{100,}/g;
const CLIENT_ERROR = 400;

interface Failure {
  statusCode: number;
  message: string;
}

// The errors a client can act on, with messages of our own: a provider's message may quote its answer. 504 only for
// the search's own deadline: any other error after it keeps its own status.
export function searchFailure(error: unknown, signal: AbortSignal): Failure | undefined {
  if (error instanceof SearchInputError) return { statusCode: 400, message: error.message };
  if (error instanceof BudgetReached) return { statusCode: 429, message: "the daily search budget is spent (SEARCH_BUDGET_USD)" };
  if (error instanceof ModelNotConfigured) return { statusCode: 503, message: "this embedding model is not configured" };
  if (signal.aborted && error === signal.reason) {
    return { statusCode: 504, message: "the providers did not answer in time" };
  }
  if (error instanceof SearchTimedOut) return { statusCode: 504, message: "the search took too long" };
  // Google answers a wrong key with 400 too, so a refusal is logged as an error (below), not as the client's mistake
  if (error instanceof InputRejected) return { statusCode: 422, message: "the embedding provider refused the input" };
  if (error instanceof ProviderError) return { statusCode: 502, message: "the embedding provider failed" };
  return undefined;
}

// The parse without the text or its English: the body is never logged
function loggedParse(parse: QueryParse | null): Record<string, unknown> | null {
  if (!parse) return null;
  if (parse.status === "unavailable") return { model: parse.model, status: parse.status, reason: parse.reason, message: parse.message };
  return { model: parse.model, status: parse.status, usage: parse.usage, dropped: parse.dropped };
}

interface LoggedSearch {
  logged: Record<string, unknown>;
  warnings: string[];
  // The API rejected our request (parameters, model, key): every search will be without the parse until it is fixed
  isParseRejected: boolean;
}

export function loggedSearch(response: SearchResponse): LoggedSearch {
  const parse = response.queryParse;
  const logged = { model: response.model, lists: response.lists, results: response.results.length,
    isComplete: response.isComplete, queryParse: loggedParse(parse), tookMs: response.tookMs };
  const warnings = [
    ...(response.isComplete ? [] : ["a list through the index stopped short, the results may be incomplete"]),
    ...(parse?.status === "unavailable" ? ["the text was not parsed and went as it is"] : []),
  ];
  return { logged, warnings, isParseRejected: parse?.status === "unavailable" && parse.reason === "rejected" };
}

function loggedFailure(error: unknown, input: SearchInput | undefined, statusCode: number): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    statusCode, model: input?.model, hasText: Boolean(input?.text), hasImage: Boolean(input?.image),
    error: { type: error instanceof Error ? error.name : typeof error, message: message.replace(LOGGED_BASE64, "<base64>") },
  };
}

export function registerSearchRoutes(app: FastifyInstance, service: SearchService, ratePerMinute = DEFAULT_RATE_PER_MINUTE): void {
  const limiter = new RateLimiter(ratePerMinute, MINUTE_MS);

  app.post<{ Body: SearchBody }>("/api/search", {
    bodyLimit: SEARCH_BODY_LIMIT_BYTES,
    schema: { body: searchBodySchema },
  }, async (request, reply) => {
    const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    let input: SearchInput | undefined;
    try {
      input = parseSearchBody(request.body);
      // After the body's checks: only what would be paid for counts
      const userId = signedInUser(request).id;
      const waitSeconds = limiter.take(String(userId));
      if (waitSeconds !== null) {
        request.log.warn({ userId, waitSeconds }, "search refused: too many in a minute");
        return await reply.code(429).header("retry-after", waitSeconds).send({ error: "too many searches in a minute" });
      }
      const response = await service.search(input, signal);
      const { logged, warnings, isParseRejected } = loggedSearch(response);
      if (isParseRejected) request.log.error(logged, `search: ${warnings.join("; ")}`);
      else if (warnings.length) request.log.warn(logged, `search: ${warnings.join("; ")}`);
      else request.log.info(logged, "search");
      return { searchId: randomUUID(), ...response };
    } catch (error) {
      const failure = searchFailure(error, signal);
      if (!failure) throw error;
      const logged = loggedFailure(error, input, failure.statusCode);
      if (failure.statusCode === CLIENT_ERROR) request.log.warn(logged, "search refused");
      else request.log.error(logged, "search failed");
      return reply.code(failure.statusCode).send({ error: failure.message });
    }
  });

  app.get("/api/search/options", () => service.options());
}
