// The search of stage 4 from the command line, for checks and the quality test of stage 8: the same module as
// POST /api/search (src/search/), against the database of DATABASE_URL. Reads only; the text is read by Claude
// (QUERY_PARSE_MODEL, under QUERY_PARSE_BUDGET_USD) and the query embedded by the paid provider of the model, under
// SEARCH_BUDGET_USD.
//   pnpm run search [--text "<text>"] [--image <file.jpg|png>] [--model <name>|all] [--source axpol|midocean]...
//     [--category "<source>:<level 1>[ > <level 2>...]"]... [--shared-category <code>]... [--min-stock <n>]
//     [--limit <n>] [--lists image-photo,image-text,text-photo,text-text] [--no-parse-query] [--parse-model <name>]
//     [--condition-pass] [--json]
// --shared-category takes a code of the shared list (pnpm run categories:sync, src/categories/taxonomy.json): a group
// ("drinkware") or a category ("drinkware.mugs"). --model all runs the query through every model, one after the
// other, with the text read once. --no-parse-query embeds the text as it is; --parse-model reads it with another
// Claude model than QUERY_PARSE_MODEL. --condition-pass lifts the models whose catalogue confirms what the query asks, as
// the screen's switch does (src/search/condition-pass.ts); off by default, as there. Prices are printed: keep the output
// out of git.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config, ConfigError } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import { InputRejected, ProviderError } from "../src/embeddings/api.js";
import { BudgetReached } from "../src/embeddings/batch.js";
import { CONDITION_PASS } from "../src/search/condition-pass.js";
import {
  DEFAULT_SEARCH_MODEL, isSearchModelName, SEARCH_MODEL_NAMES, type SearchModelName,
} from "../src/search/models.js";
import { isListName, type ListName } from "../src/search/rank.js";
import { ModelNotConfigured, SearchInputError } from "../src/search/errors.js";
import {
  isQueryParseModel, QUERY_PARSE_MODEL_NAMES, type QueryParse, type QueryParseModel, queryParseModelFromEnv,
  queryParserFromEnv,
} from "../src/search/query-parse.js";
import { postgresReadings } from "../src/search/query-readings.js";
import { queryImage, searchInput, type SearchInput } from "../src/search/request.js";
import type { SearchResult } from "../src/search/results.js";
import { createSearchService, dailyBudgetFromEnv, QueryEmbedder, type SearchResponse } from "../src/search/search.js";
import { isSupplierCode } from "../src/suppliers/registry.js";
import { scrub } from "../src/suppliers/secrets.js";
import type { CategoryFilter } from "../src/search/store.js";

const SEARCH_TIMEOUT_MS = 60_000;
const NAME_CHARS = 48;
const secrets = [process.env.GEMINI_API_KEY, process.env.VOYAGE_API_KEY, process.env.ANTHROPIC_API_KEY,
  databasePassword(config.databaseUrl)].filter((secret): secret is string => Boolean(secret));

function parseCategory(text: string): CategoryFilter {
  const colon = text.indexOf(":");
  const source = text.slice(0, colon).trim();
  const path = text.slice(colon + 1).split(">").map((name) => name.trim()).filter(Boolean);
  if (colon < 0 || !isSupplierCode(source) || !path.length) {
    throw new ConfigError(`--category must look like "axpol:BAGS & BACKPACKS > backpacks", got "${text}"`);
  }
  return { source, path };
}

function positiveInteger(name: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`--${name} must be a positive integer, got "${text}"`);
  return value;
}

interface Options {
  inputs: SearchInput[];
  parseModel: QueryParseModel;
  isJson: boolean;
}

async function parseOptions(argv: string[]): Promise<Options> {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      text: { type: "string" },
      image: { type: "string" },
      model: { type: "string" },
      source: { type: "string", multiple: true },
      category: { type: "string", multiple: true },
      "shared-category": { type: "string", multiple: true },
      "min-stock": { type: "string" },
      limit: { type: "string" },
      lists: { type: "string" },
      "parse-query": { type: "boolean", default: true },
      "parse-model": { type: "string" },
      "condition-pass": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const parseModel = values["parse-model"] ?? queryParseModelFromEnv();
  if (!isQueryParseModel(parseModel)) {
    throw new ConfigError(`--parse-model must be one of ${QUERY_PARSE_MODEL_NAMES.join(", ")}, got "${parseModel}"`);
  }
  const model = values.model ?? DEFAULT_SEARCH_MODEL;
  if (model !== "all" && !isSearchModelName(model)) {
    throw new ConfigError(`--model must be all or one of ${SEARCH_MODEL_NAMES.join(", ")}, got "${model}"`);
  }
  const models: SearchModelName[] = model === "all" ? SEARCH_MODEL_NAMES : [model];
  for (const source of values.source ?? []) {
    if (!isSupplierCode(source)) throw new ConfigError(`--source must be a supplier code, got "${source}"`);
  }
  const lists = values.lists?.split(",").map((name) => name.trim());
  if (lists?.some((name) => !isListName(name))) throw new ConfigError(`--lists takes names from image-photo, image-text, text-photo, text-text`);
  const image = values.image === undefined ? undefined : queryImage(await readFile(values.image));
  const filters = {
    sources: values.source, categories: values.category?.map(parseCategory), sharedCategories: values["shared-category"],
    minStock: positiveInteger("min-stock", values["min-stock"]),
  };
  const inputs = models.map((model) => searchInput({
    text: values.text, image, model, filters, limit: positiveInteger("limit", values.limit),
    lists: lists as ListName[] | undefined, parseQuery: values["parse-query"],
    conditionPass: values["condition-pass"] ? CONDITION_PASS : null,
  }));
  return { inputs, parseModel, isJson: values.json };
}

function stockOf(result: SearchResult): string {
  const known = result.variants.filter((variant) => variant.inStock !== null);
  if (!known.length) return "stock ?";
  return `stock ${known.reduce((sum, variant) => sum + (variant.inStock ?? 0), 0)}`;
}

function priceOf(result: SearchResult): string {
  const prices = result.variants.flatMap((variant) => (variant.price ? [variant.price] : []));
  if (!prices.length) return "price ?";
  const amounts = prices.map((price) => Number(price.amount));
  const [low, high] = [Math.min(...amounts), Math.max(...amounts)];
  return `${low === high ? low : `${low}-${high}`} ${prices[0]?.currency ?? ""}`;
}

function priceText({ min, max, currency }: { min: number | null; max: number | null; currency: string | null }): string {
  const range = min === null ? `up to ${String(max)}` : max === null ? `from ${min}` : `${min}-${max}`;
  return `price ${range}${currency ? ` ${currency}` : ""}`;
}

function parseLine(parse: QueryParse): string {
  if (parse.status === "unavailable") return `text as it is, ${parse.model} unavailable (${parse.reason}): ${parse.message}`;
  const { sharedCategories, colors, materials, price } = parse.suggestedFilters;
  const suggested = [
    sharedCategories.length ? `categories ${sharedCategories.join(", ")}` : "",
    colors.length ? `colours ${colors.join(", ")}` : "",
    materials.length ? `materials ${materials.join(", ")}` : "",
    price ? priceText(price) : "",
  ].filter(Boolean);
  const usage = parse.usage ? `${parse.usage.inputTokens} in, ${parse.usage.outputTokens} out tokens` : "read before";
  const english = parse.englishText === null ? "no product words, text as it is" : `"${parse.englishText}"`;
  const dropped = parse.dropped.length ? ` | dropped: ${parse.dropped.join(", ")}` : "";
  return `${parse.model}: ${english} | suggested: ${suggested.join("; ") || "none"}${dropped} | ${usage}`;
}

function print(response: SearchResponse): void {
  console.log(`\n${response.model}: ${response.results.length} models, lists ${response.lists.join(", ")}, ${response.tookMs} ms`);
  if (response.queryParse) console.log(`  query: ${parseLine(response.queryParse)}`);
  if (!response.isComplete) console.log("  may be incomplete: a list through the index stopped short of its rows");
  for (const result of response.results) {
    const lists = Object.entries(result.lists).map(([name, list]) => `${name} #${list.rank} ${list.similarity.toFixed(3)}`);
    const name = (result.name ?? "").slice(0, NAME_CHARS);
    const shared = (result.matchedCodeModels ?? 1) > 1 ? `, ${String(result.matchedCodeModels)} models` : "";
    const code = result.matchedCode ? ` [code ${result.matchedCode}${shared}]` : "";
    console.log(`${String(result.rank).padStart(3)}. ${result.source.code} ${result.code} ${name}${code}`);
    console.log(`     ${result.category.join(" > ")} | ${result.variants.length} variants, ${stockOf(result)}, ${priceOf(result)}`);
    console.log(`     score ${result.score.toFixed(4)}: ${lists.join("; ")}`);
    console.log(`     ${result.photos[0]?.url ?? "no photo"}`);
  }
}

async function main(): Promise<number> {
  const { inputs, parseModel, isJson } = await parseOptions(process.argv.slice(2));
  const db = createPrisma(config.databaseUrl, (error) => console.error(scrub(`database pool error: ${error.message}`, secrets)));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("stopped by SIGINT")));
  try {
    const embedder = new QueryEmbedder(dailyBudgetFromEnv("SEARCH_BUDGET_USD"));
    // Every model's key before the first paid call, so --model all does not stop after paying for the first
    for (const input of inputs) embedder.provider(input.model);
    const parser = queryParserFromEnv(dailyBudgetFromEnv("QUERY_PARSE_BUDGET_USD"), postgresReadings(db), parseModel);
    const service = createSearchService(db, embedder, parser);
    const responses: SearchResponse[] = [];
    for (const input of inputs) {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
      const response = await service.search(input, signal);
      responses.push(response);
      if (!isJson) print(response);
    }
    if (isJson) console.log(JSON.stringify(responses, null, 2));
    return 0;
  } finally {
    await db.$disconnect();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Errors that explain themselves: a stack trace would only bury the message
  const isExpected = [ConfigError, SearchInputError, ModelNotConfigured, BudgetReached, InputRejected, ProviderError]
    .some((type) => error instanceof type)
    || (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS"));
  const text = error instanceof Error ? (isExpected ? error.message : error.stack ?? error.message) : String(error);
  console.error(scrub(text, secrets));
  process.exitCode = 1;
}
