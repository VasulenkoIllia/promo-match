// Runs a frozen set of the independent test (README «Незалежний тест») through the same search as the web screen, every
// embedding model in turn, and writes the numbers per source. The query's vectors and Claude's readings stay in a cache
// on disk, so a repeat pays nothing and differs only by what changed in the search; a changed prompt reads again.
//   pnpm run search:independent --set output/quality/independent/dev --label <name> [--quiet] [--kinds category]
//     [--lists text-text] [--model gemini-embedding-2/1536] [--against 0.8] [--other-material near] [--numbers-only]
//     [--category-lift 1.25] [--condition-pass on|off|0.5] [--pass-materials] [--pass-print] [--tuning '{"textCategoryLift":1.25}']
//     [--hubness 0.5] [--photo-hubness 0.5] [--text-variant gemini-embedding-2-brand-free/1536] [--dry-run]
// --dry-run prices what the cache lacks and runs nothing. --hubness and --photo-hubness: the candidate correction of
// the text and the photo lists by their hubs, with this alpha, for the default model (src/search/hubness.ts).
// --text-variant: the text lists of its model read these vectors of the model texts (src/search/models.ts,
// TEXT_VARIANTS; pnpm run embed:brand-free makes them); a run stops when an active model has none.
// --quiet writes the report and prints nothing of it: the final set's baseline stays unopened until the end. --kinds,
// --lists and --model narrow a run, to see where a number comes from. --against and --other-material set how far a
// model falls for going against what the query asks of it (src/search/conditions.ts); --against 1 is no demotion,
// --numbers-only leaves materials out of it. --category-lift: a text beside a photo that only names a
// category adds no lists and lifts it by this factor (src/search/category-word.ts). --condition-pass: the text lists run
// again over the models that fit the query's numbers, each rank a vote of this weight, --pass-materials and --pass-print
// hold them to its materials and print too (src/search/condition-pass.ts); on is the screen's switch (CONDITION_PASS),
// off or none runs without it, as the screen by default. QUERY_PARSE_DRAW=<n> in the environment reads the
// texts anew: one reading moves a result, so a comparison takes the mean of several.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadTaxonomy } from "../src/categories/taxonomy.js";
import { config, ConfigError } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import { mapSettled } from "../src/embeddings/batch.js";
import { type EmbeddingProvider, providerFromEnv } from "../src/embeddings/provider.js";
import { IN_SCOPE } from "../src/embeddings/store.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { DEFAULT_CATEGORY_LIFT } from "../src/search/category-word.js";
import { CONDITION_PASS, type ConditionPass } from "../src/search/condition-pass.js";
import { DEFAULT_DEMOTION, type Demotion } from "../src/search/conditions.js";
import {
  type Catalog, type CaseRun, type IndependentCase, summarizeIndependent, summaryLines,
} from "../src/search/independent.js";
import {
  DEFAULT_SEARCH_MODEL, isTextVariantName, SEARCH_MODEL_NAMES, SEARCH_MODELS, type SearchModelName, TEXT_VARIANTS,
  type TextVariantName,
} from "../src/search/models.js";
import { systemPrompt } from "../src/search/query-parse-contract.js";
import { isListName, type ListName } from "../src/search/rank.js";
import { type Hubness, readHubness } from "../src/search/hubness.js";
import { type QueryParse, type QueryParser, queryParserFromEnv } from "../src/search/query-parse.js";
import { memoryReadings } from "../src/search/query-readings.js";
import { queryImage, searchInput, type SearchInput } from "../src/search/request.js";
import { createSearchService, type DailyBudget, dailyBudgetFromEnv, QueryEmbedder, type SearchService } from "../src/search/search.js";
import type { SearchTuning } from "../src/search/tuning.js";
import { scrub } from "../src/suppliers/secrets.js";

const PHOTOS_FOLDER = "photos";
const CACHE_FILE = "query-cache.json";
const SEARCHES_AT_ONCE = 4;
const SEARCH_TIMEOUT_MS = 60_000;
const secrets = [process.env.GEMINI_API_KEY, process.env.VOYAGE_API_KEY, process.env.ANTHROPIC_API_KEY,
  databasePassword(config.databaseUrl)].filter((secret): secret is string => Boolean(secret));

function log(line: string): void {
  console.log(scrub(line, secrets));
}

function sha256(...parts: (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

// Vectors and readings by a hash of what produced them; never the bytes or a key
interface QueryCache {
  vectors: Record<string, number[]>;
  readings: Record<string, QueryParse>;
}

// A query's vector is paid for once; the budget counts the call that really goes, so priceUsd says 0 to the embedder
function cachedProvider(inner: EmbeddingProvider, cache: QueryCache, budget: DailyBudget): EmbeddingProvider {
  const once = async (key: string, priced: number, embed: () => Promise<number[] | undefined>) => {
    const known = cache.vectors[key];
    if (known) return { vectors: [known], usage: {} };
    budget.reserve(priced);
    const vector = await embed();
    if (!vector) throw new Error("the provider gave no vector");
    cache.vectors[key] = vector;
    return { vectors: [vector], usage: {} };
  };
  return {
    ...inner,
    priceUsd: () => 0,
    embedImages: async ([image], role, signal) => {
      if (!image) throw new Error("one image at a time");
      return once(sha256(inner.name, "image", image.bytes), inner.priceUsd({ imagePixels: [1_000_000], textChars: 0 }),
        async () => (await inner.embedImages([image], role, signal)).vectors[0]);
    },
    embedTexts: async ([text], role, signal) => {
      if (!text) throw new Error("one text at a time");
      return once(sha256(inner.name, "text", role, text.text), inner.priceUsd({ imagePixels: [], textChars: text.text.length }),
        async () => (await inner.embedTexts([text], role, signal)).vectors[0]);
    },
  };
}

// A reading goes by the prompt it was made with: a new prompt reads every text again
function readingKeys(parser: QueryParser): (text: string) => string {
  const prompt = sha256(systemPrompt(loadTaxonomy().entries), process.env.QUERY_PARSE_DRAW ?? "");
  return (text) => sha256(parser.model, prompt, text);
}

function cachedParser(parser: QueryParser, cache: QueryCache) {
  const keyOf = readingKeys(parser);
  return {
    parse: async (text: string, signal: AbortSignal): Promise<QueryParse> => {
      const key = keyOf(text);
      const known = cache.readings[key];
      if (known) return known;
      const reading = await parser.parse(text, signal);
      if (reading.status === "ok") cache.readings[key] = reading;
      return reading;
    },
  };
}

async function readCache(file: string): Promise<QueryCache> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  return text ? JSON.parse(text) as QueryCache : { vectors: {}, readings: {} };
}

async function readCatalog(db: PrismaClient): Promise<Catalog> {
  const rows = await db.$queryRaw<{ id: number; source: string; category: string | null; photoVectors: number }[]>`
    SELECT m.id, s.code AS source, c.code AS category,
      (SELECT count(*)::integer FROM photo p JOIN photo_embedding e ON e.photo_id = p.id
        WHERE p.model_id = m.id AND e.embedding_model = ${DEFAULT_SEARCH_MODEL} AND ${IN_SCOPE}) AS "photoVectors"
    FROM product_model m JOIN source s ON s.id = m.source_id
    LEFT JOIN source_category sc ON sc.source_id = m.source_id AND sc.path = m.category->'en'
    LEFT JOIN category c ON c.id = sc.category_id
    WHERE m.is_active AND EXISTS (SELECT 1 FROM variant v WHERE v.model_id = m.id AND v.is_active)`;
  return new Map(rows.map(({ id, ...model }) => [id, model]));
}

interface Ranking {
  lists: ListName[] | undefined;
  demotion: Demotion;
  categoryLift: number | null;
  conditionPass: ConditionPass | null;
  tuning: Partial<SearchTuning>;
}

async function inputOf(kase: IndependentCase, photosDir: string, ranking: Ranking): Promise<SearchInput> {
  const image = kase.photo ? queryImage(await readFile(join(photosDir, kase.photo))) : undefined;
  return searchInput({ text: kase.text, image, filters: {}, matchCodes: false, ...ranking });
}

function categoryLiftFrom(lift: string | undefined): number | null {
  if (lift === undefined) return DEFAULT_CATEGORY_LIFT;
  const factor = Number(lift);
  if (!(factor >= 1)) throw new ConfigError(`--category-lift must be 1 or more, got "${lift}"`);
  return factor;
}

function conditionPassFrom(weight: string | undefined, hasMaterials: boolean, hasPrint: boolean): ConditionPass | null {
  if (weight === undefined || weight === "off") return null;
  if (weight === "on") return CONDITION_PASS;
  const factor = Number(weight);
  if (!(factor > 0)) throw new ConfigError(`--condition-pass must be on, off or a weight above 0, got "${weight}"`);
  return { weight: factor, hasMaterials, hasPrint };
}

function demotionFrom(against: string | undefined, otherMaterial: string | undefined, isNumbersOnly: boolean): Demotion {
  const factor = against === undefined ? DEFAULT_DEMOTION.against : Number(against);
  if (!(factor > 0 && factor <= 1)) throw new ConfigError(`--against must be above 0, up to 1, got "${against}"`);
  const demotion = { ...DEFAULT_DEMOTION, against: factor, hasMaterials: !isNumbersOnly };
  if (otherMaterial === undefined) return demotion;
  if (otherMaterial !== "near" && otherMaterial !== "against") throw new ConfigError("--other-material must be near or against");
  return { ...demotion, otherMaterial };
}

interface HubAlphas {
  text: number;
  photo: number;
}

// The scores read at the start, from the database as it is: a minute for the texts, a few for the photos
async function hubnessOf(db: PrismaClient, alphas: HubAlphas | null): Promise<Hubness | undefined> {
  if (alphas === null) return undefined;
  const started = performance.now();
  const hubness = await readHubness(db, DEFAULT_SEARCH_MODEL, alphas.text, alphas.photo);
  log(`hub scores of ${hubness.texts.toTexts.size} texts and ${hubness.photos.toTexts.size} photos of ${DEFAULT_SEARCH_MODEL}`
    + ` in ${Math.round((performance.now() - started) / 1000)} s, alpha ${alphas.text} for texts, ${alphas.photo} for photos`);
  return hubness;
}

function alphaFrom(flag: string, alpha: string | undefined): number {
  if (alpha === undefined) return 0;
  const factor = Number(alpha);
  if (!(factor > 0)) throw new ConfigError(`${flag} must be above 0, got "${alpha}"`);
  return factor;
}

function hubAlphasFrom(textAlpha: string | undefined, photoAlpha: string | undefined): HubAlphas | null {
  const alphas = { text: alphaFrom("--hubness", textAlpha), photo: alphaFrom("--photo-hubness", photoAlpha) };
  return alphas.text || alphas.photo ? alphas : null;
}

function textVariantFrom(name: string | undefined, hubness: HubAlphas | null): TextVariantName | undefined {
  if (name === undefined) return undefined;
  if (!isTextVariantName(name)) throw new ConfigError(`--text-variant must be one of ${Object.keys(TEXT_VARIANTS).join(", ")}, got "${name}"`);
  // The hub scores are read from the model's own texts
  if (hubness) throw new ConfigError("--text-variant does not go with --hubness or --photo-hubness");
  return name;
}

// A model the variant lacks would drop out of the text lists and lose to the baseline for that alone
async function checkTextVariant(db: PrismaClient, variant: TextVariantName): Promise<void> {
  const { model } = TEXT_VARIANTS[variant];
  const [row] = await db.$queryRaw<{ missing: number }[]>`
    SELECT count(*)::integer AS missing FROM text_embedding t JOIN product_model m ON m.id = t.model_id
    WHERE t.embedding_model = ${model} AND m.is_active
      AND NOT EXISTS (SELECT 1 FROM text_embedding v WHERE v.model_id = t.model_id AND v.embedding_model = ${variant})`;
  const missing = row?.missing ?? 0;
  if (missing) throw new ConfigError(`${missing} active models have texts of ${model} and none of ${variant}: run pnpm run embed:brand-free`);
  log(`text lists of ${model} read ${variant}`);
}

// What a run would pay for, priced as its budgets price a call before it goes: the readings and query vectors the cache
// lacks, per model. A text's vectors follow its reading, so an unread text counts as one, a read one by its products.
function printEstimate(cases: IndependentCase[], inputs: Map<string, SearchInput>, cache: QueryCache, parser: QueryParser,
  modelNames: SearchModelName[]): void {
  const keyOf = readingKeys(parser);
  const unread = cases.filter((kase) => kase.text !== undefined && !cache.readings[keyOf(kase.text)]);
  const readingUsd = unread.reduce((sum, kase) => sum + parser.priceUsd(kase.text ?? ""), 0);
  log(`dry run: ${cases.length} cases, ${unread.length} texts to read, at most $${readingUsd.toFixed(2)}`
    + ` (QUERY_PARSE_BUDGET_USD $${dailyBudgetFromEnv("QUERY_PARSE_BUDGET_USD").limitUsd})`);
  for (const model of modelNames) {
    const { provider } = providerFromEnv(SEARCH_MODELS[model].provider, true);
    const images = cases.filter((kase) => {
      const image = inputs.get(kase.id)?.image;
      return image && !cache.vectors[sha256(provider.name, "image", image.bytes)];
    }).length;
    const phrases = cases.flatMap((kase) => {
      if (kase.text === undefined) return [];
      const reading = cache.readings[keyOf(kase.text)];
      return reading?.status === "ok" && reading.products.length ? reading.products : [kase.text];
    }).filter((phrase) => !cache.vectors[sha256(provider.name, "text", "query", phrase)]);
    const usd = images * provider.priceUsd({ imagePixels: [1_000_000], textChars: 0 })
      + phrases.reduce((sum, phrase) => sum + provider.priceUsd({ imagePixels: [], textChars: phrase.length }), 0);
    log(`${model}: ${images} photo and about ${phrases.length} text vectors to pay, about $${usd.toFixed(2)}`
      + ` (SEARCH_BUDGET_USD $${dailyBudgetFromEnv("SEARCH_BUDGET_USD").limitUsd})`);
  }
}

interface Closeness {
  text: number;
  photo: number;
  hasCategory: boolean;
  hasCloseMatch: boolean | null;
}

async function runModel(cases: IndependentCase[], inputs: Map<string, SearchInput>, model: SearchModelName,
  service: SearchService, stop: AbortSignal, unread: string[], closeness: Map<string, Closeness>): Promise<CaseRun[]> {
  // A failure stays with its case: mapSettled starts nothing after a rejection, and one timeout would end the run
  const results = await mapSettled(cases, SEARCHES_AT_ONCE, async (kase) => {
    const input = inputs.get(kase.id) as SearchInput;
    const signal = AbortSignal.any([stop, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
    try {
      const { results: found, queryParse, hasCloseMatch } = await service.search({ ...input, model }, signal);
      if (queryParse?.status === "unavailable") {
        unread.push(kase.id);
        log(`case ${kase.id}: the text went without Claude: ${queryParse.reason}`);
      }
      const closest = (name: ListName) => Math.max(0, ...found.map((result) => result.lists[name]?.similarity ?? 0));
      closeness.set(kase.id, { text: closest("text-text"), photo: closest("text-photo"), hasCategory: queryParse?.status === "ok" && queryParse.suggestedFilters.sharedCategories.length > 0, hasCloseMatch });
      return found.map((result) => result.modelId);
    } catch (error) {
      log(`case ${kase.id} failed: ${String(error)}`);
      return null;
    }
  });
  return cases.map((kase, index) => {
    const result = results[index];
    return { kase, modelIds: result?.status === "fulfilled" ? result.value : null };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      set: { type: "string" }, label: { type: "string" }, quiet: { type: "boolean", default: false },
      kinds: { type: "string" }, lists: { type: "string" }, model: { type: "string" }, against: { type: "string" },
      "other-material": { type: "string" }, "numbers-only": { type: "boolean", default: false },
      "category-lift": { type: "string" }, "condition-pass": { type: "string" },
      "pass-materials": { type: "boolean", default: false }, "pass-print": { type: "boolean", default: false }, tuning: { type: "string" },
      hubness: { type: "string" }, "photo-hubness": { type: "string" }, "text-variant": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.set || !values.label) throw new ConfigError("give --set <folder> --label <name>");
  const modelNames = SEARCH_MODEL_NAMES.filter((name) => !values.model || name === values.model);
  if (!modelNames.length) throw new ConfigError(`unknown model: ${values.model}`);
  const kinds = values.kinds?.split(",");
  const lists = values.lists?.split(",").filter(isListName);
  const demotion = demotionFrom(values.against, values["other-material"], values["numbers-only"]);
  const categoryLift = categoryLiftFrom(values["category-lift"]);
  const conditionPass = conditionPassFrom(values["condition-pass"], values["pass-materials"], values["pass-print"]);
  const hubness = hubAlphasFrom(values.hubness, values["photo-hubness"]);
  const textVariant = textVariantFrom(values["text-variant"], hubness);
  const frozen = JSON.parse(await readFile(join(values.set, "cases.json"), "utf8")) as { cases: IndependentCase[] };
  const cases = kinds ? frozen.cases.filter((kase) => kinds.includes(kase.kind)) : frozen.cases;
  // The photos of both sets lie in dev/: the drawing writes them there before it splits them
  const photosDir = join(dirname(values.set), "dev", PHOTOS_FOLDER);
  const db = createPrisma(config.databaseUrl, (error) => console.error(scrub(`database pool error: ${error.message}`, secrets)));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("stopped by SIGINT")));
  const cacheFile = join(dirname(values.set), CACHE_FILE);
  try {
    const cache = await readCache(cacheFile);
    const catalog = await readCatalog(db);
    const tuning = JSON.parse(values.tuning ?? "{}") as Partial<SearchTuning>;
    const ranking = { lists, demotion, categoryLift, conditionPass, tuning };
    const inputs = new Map(await Promise.all(cases.map(async (kase) => [kase.id, await inputOf(kase, photosDir, ranking)] as const)));
    const reader = queryParserFromEnv(dailyBudgetFromEnv("QUERY_PARSE_BUDGET_USD"), memoryReadings());
    if (values["dry-run"]) {
      printEstimate(cases, inputs, cache, reader, modelNames);
      return;
    }
    const searchBudget = dailyBudgetFromEnv("SEARCH_BUDGET_USD");
    const embedder = new QueryEmbedder(searchBudget, (model) =>
      cachedProvider(providerFromEnv(SEARCH_MODELS[model].provider).provider, cache, searchBudget));
    if (textVariant) await checkTextVariant(db, textVariant);
    const service = createSearchService(db, embedder, cachedParser(reader, cache), { hubness: await hubnessOf(db, hubness), textVariant });
    const models: Record<string, unknown> = {};
    for (const model of modelNames) {
      log(`${model}: running ${cases.length} cases`);
      // Cases Claude did not read went another way than the screen's: the report says which
      const unread: string[] = [];
      const closeness = new Map<string, Closeness>();
      const runs = await runModel(cases, inputs, model, service, controller.signal, unread, closeness);
      await writeFile(cacheFile, JSON.stringify(cache));
      const summary = summarizeIndependent(runs, catalog);
      models[model] = { summary, unread, runs: runs.map(({ kase, modelIds }) => ({ id: kase.id, modelIds, closeness: closeness.get(kase.id) })) };
      if (!values.quiet) for (const line of summaryLines(summary)) log(`  ${line}`);
    }
    await mkdir(values.set, { recursive: true });
    const report = join(values.set, `report-${values.label}.json`);
    const run = {
      date: new Date().toISOString(), label: values.label, cases: cases.length, demotion, categoryLift, conditionPass, tuning, hubness,
      textVariant: textVariant ?? null,
    };
    await writeFile(report, `${JSON.stringify({ ...run, models }, null, 2)}\n`);
    log(`report: ${report}`);
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(scrub(error instanceof Error ? error.stack ?? error.message : String(error), secrets));
  process.exitCode = 1;
}
