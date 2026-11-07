// The quality test of stage 8 (README «Тест якості пошуку»): the client's real cases go through the same search as the
// web screen (src/search/: no filters, its default limit, Claude reading the text), and every embedding model gets the
// share of cases with a right model in the top 10. Reads the cases and the database, writes only the report to
// output/quality/ (outside git, like the cases); the report has no prices. Photos go as they are, neither cropped nor
// shrunk as the web screen does.
//   npm run search:quality -- [--cases output/quality/cases.csv] [--condition-pass] [--dry-run]
// Photos lie in photos/ beside the cases file. --dry-run checks the cases and prints the cost at list prices, calling no
// provider. --condition-pass runs with the screen's switch on (src/search/condition-pass.ts), at no extra cost; off by
// default, as the screen's. A run needs the keys of all models and ANTHROPIC_API_KEY, and stays under SEARCH_BUDGET_USD and
// QUERY_PARSE_BUDGET_USD, a run's own counters here. QUERY_PARSE_MODEL picks the Claude model, as for the web screen.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { config, ConfigError } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import { BudgetReached } from "../src/embeddings/batch.js";
import { providerFromEnv } from "../src/embeddings/provider.js";
import { IN_SCOPE, IN_SEARCH } from "../src/embeddings/store.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { CONDITION_PASS, type ConditionPass } from "../src/search/condition-pass.js";
import { ModelNotConfigured, SearchInputError } from "../src/search/errors.js";
import { SEARCH_MODEL_NAMES, SEARCH_MODELS, type SearchModelName } from "../src/search/models.js";
import {
  answeredRun, type CaseRun, checkLimits, decodeCases, type Estimate, type ExpectedModels, isHit, parseCsv, pickModel,
  QUERY_KINDS, queryKind, type QualityCase, type QualitySummary, readCases, type ReadCases, shareText,
  summarize, TOP_K, unreachableIssues, usdText,
} from "../src/search/quality.js";
import { type QueryParser, queryParserFromEnv } from "../src/search/query-parse.js";
import { memoryReadings } from "../src/search/query-readings.js";
import { queryImage, type QueryImage, searchInput, type SearchInput } from "../src/search/request.js";
import { createSearchService, dailyBudgetFromEnv, QueryEmbedder, type SearchService } from "../src/search/search.js";
import { readCodeMatches } from "../src/search/store.js";
import { scrub } from "../src/suppliers/secrets.js";

const DEFAULT_CASES_FILE = "output/quality/cases.csv";
const PHOTOS_FOLDER = "photos";
const OUTPUT_DIR = "output/quality";
// As the search's CLI (scripts/search.ts)
const SEARCH_TIMEOUT_MS = 60_000;
const secrets = [process.env.GEMINI_API_KEY, process.env.VOYAGE_API_KEY, process.env.ANTHROPIC_API_KEY,
  databasePassword(config.databaseUrl)].filter((secret): secret is string => Boolean(secret));

function log(line: string): void {
  console.log(scrub(line, secrets));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readCasesFile(file: string): Promise<ReadCases> {
  const bytes = await readFile(file).catch((error: unknown) => {
    if (isMissingFile(error)) throw new ConfigError(`no cases file ${file}: see README, «Тест якості пошуку»`);
    throw error;
  });
  return readCases(parseCsv(decodeCases(bytes)));
}

// A string says why the photo cannot be used, so it is named with the rest of the issues before any paid call
async function readImage(path: string): Promise<QueryImage | string> {
  try {
    return queryImage(await readFile(path));
  } catch (error) {
    if (isMissingFile(error)) return "the file is not there";
    if (error instanceof SearchInputError) return error.message;
    throw error;
  }
}

interface LoadedInputs {
  inputs: Map<string, SearchInput>;
  issues: string[];
}

// No filters and no limit: a limit only cuts the ranking, which the top 10 never reaches. No exact match by a code,
// unlike the screen: a code left in a text must not pass for a hit of the search.
async function loadInputs(cases: QualityCase[], photosDir: string, conditionPass: ConditionPass | null): Promise<LoadedInputs> {
  const inputs = new Map<string, SearchInput>();
  const issues: string[] = [];
  for (const { id, photo, text } of cases) {
    const image = photo ? await readImage(join(photosDir, photo)) : undefined;
    if (typeof image === "string") issues.push(`case ${id}: photo ${String(photo)}: ${image}`);
    // A case with neither is named by readCases already
    else if (image || text) inputs.set(id, searchInput({ text, image, filters: {}, matchCodes: false, conditionPass }));
  }
  return { inputs, issues };
}

function searchableKey(modelId: number, embeddingModel: string): string {
  return `${modelId} ${embeddingModel}`;
}

// What the search reaches with no filters (src/search/store.ts, photoRows and textRows): an active model with an active
// variant and a vector of the embedding model. A model it cannot reach would pass for a miss of the search.
async function readSearchable(db: PrismaClient, modelIds: number[]): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ modelId: number; embeddingModel: string }[]>`
    SELECT m.id AS "modelId", e.name AS "embeddingModel"
    FROM product_model m CROSS JOIN unnest(${SEARCH_MODEL_NAMES}::text[]) AS e(name)
    WHERE m.id = ANY(${modelIds}::integer[]) AND m.is_active
      AND EXISTS (SELECT 1 FROM variant v WHERE v.model_id = m.id AND v.is_active)
      AND (EXISTS (SELECT 1 FROM text_embedding t WHERE t.model_id = m.id AND t.embedding_model = e.name)
        OR EXISTS (SELECT 1 FROM photo p JOIN photo_embedding pe ON pe.photo_id = p.id
          WHERE p.model_id = m.id AND pe.embedding_model = e.name AND ${IN_SCOPE} AND ${IN_SEARCH}))`;
  return new Set(rows.map((row) => searchableKey(row.modelId, row.embeddingModel)));
}

interface ResolvedCases {
  expected: Map<string, ExpectedModels>;
  issues: string[];
}

async function resolveExpected(db: PrismaClient, cases: QualityCase[]): Promise<ResolvedCases> {
  const codes = cases.flatMap((kase) => [...kase.same, ...kase.analogs]);
  const matches = await readCodeMatches(db, [...new Set(codes.map((code) => code.toLowerCase()))]);
  const labels = new Map([...matches.values()].flat().map((match) => [match.modelId, match.label]));
  const issues: string[] = [];
  const modelsOf = (id: string, list: string[]) => list.flatMap((code) => {
    const picked = pickModel(code, matches.get(code.toLowerCase()) ?? []);
    if (typeof picked === "number") return [picked];
    issues.push(`case ${id}: ${picked}`);
    return [];
  });
  const expected = new Map(cases.map(({ id, same, analogs }) => [id, { same: modelsOf(id, same), analogs: modelsOf(id, analogs) }]));
  const modelIds = [...new Set([...expected.values()].flatMap(({ same, analogs }) => [...same, ...analogs]))];
  const searchable = await readSearchable(db, modelIds);
  const isSearchable = (modelId: number) => SEARCH_MODEL_NAMES.every((model) => searchable.has(searchableKey(modelId, model)));
  issues.push(...unreachableIssues(expected, isSearchable, (modelId) => labels.get(modelId) ?? String(modelId)));
  return { expected, issues };
}

// As the search prices a call before it goes (src/search/search.ts, QueryEmbedder.embed); the second model reads the
// text from the parser's memory, so a text is paid for once
function estimateOf(inputs: SearchInput[], parser: QueryParser): Estimate {
  const embeddingUsd = Object.fromEntries(SEARCH_MODEL_NAMES.map((model) => {
    const { provider } = providerFromEnv(SEARCH_MODELS[model].provider, true);
    return [model, inputs.reduce((sum, { text, image }) => sum + provider.priceUsd({
      imagePixels: image ? [image.info.width * image.info.height] : [], textChars: text?.length ?? 0,
    }), 0)];
  }));
  const texts = [...new Set(inputs.flatMap(({ text }) => text ?? []))];
  return { embeddingUsd, parseUsd: texts.reduce((sum, text) => sum + parser.priceUsd(text), 0), texts: texts.length };
}

function printPlan(loaded: LoadedCase[], estimate: Estimate, parser: QueryParser): void {
  const kinds = QUERY_KINDS.map((kind) => `${kind} ${loaded.filter(({ kase }) => queryKind(kase) === kind).length}`);
  const withSame = loaded.filter(({ expected }) => expected.same.length > 0).length;
  log(`${loaded.length} cases: ${kinds.join(", ")}; ${withSame} name the same product, ${loaded.length - withSame} analogs only`);
  for (const [model, usd] of Object.entries(estimate.embeddingUsd)) log(`${model}: estimate ${usdText(usd)} at list prices`);
  log(`${parser.model}: ${estimate.texts} texts, estimate ${usdText(estimate.parseUsd)} at list prices`);
}

interface LoadedCase {
  kase: QualityCase;
  input: SearchInput;
  expected: ExpectedModels;
}

// What a person needs to look a miss over; prices stay out of the report
interface RunDetails {
  tookMs: number;
  englishText: string | null;
  top: { rank: number; source: string; code: string; name: string | null }[];
}

type ReportedRun = CaseRun & Partial<RunDetails>;

interface ModelRun {
  runs: ReportedRun[];
  // Why the run stopped before its last case
  stopped: string | null;
}

async function runCase({ kase, input, expected }: LoadedCase, model: SearchModelName, service: SearchService, stop: AbortSignal):
  Promise<ReportedRun> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
  const { results, isComplete, queryParse, tookMs } = await service.search({ ...input, model }, signal);
  const textUnreadReason = queryParse?.status === "unavailable" ? queryParse.reason : null;
  const run = answeredRun(kase, expected, results, { isComplete, textUnreadReason });
  return {
    ...run, tookMs, englishText: queryParse?.status === "ok" ? queryParse.englishText : null,
    top: results.slice(0, TOP_K).map(({ rank, source, code, name }) => ({ rank, source: source.code, code, name })),
  };
}

async function runModel(loaded: LoadedCase[], model: SearchModelName, service: SearchService, stop: AbortSignal):
  Promise<ModelRun> {
  const runs: ReportedRun[] = [];
  for (const each of loaded) {
    try {
      runs.push(await runCase(each, model, service, stop));
    } catch (error) {
      const message = scrub(error instanceof Error ? error.message : String(error), secrets);
      // The cases after these would go the same way
      if (stop.aborted || error instanceof BudgetReached || error instanceof ModelNotConfigured) return { runs, stopped: message };
      const { kase, expected } = each;
      runs.push({ status: "failed", caseId: kase.id, kind: queryKind(kase), hasSame: expected.same.length > 0, error: message });
    }
  }
  return { runs, stopped: null };
}

function printSummary(model: string, summary: QualitySummary, { runs, stopped }: ModelRun, cases: number): void {
  log(`${model}: top ${TOP_K}, same product ${shareText(summary.same)}, same or analog ${shareText(summary.sameOrAnalog)}`);
  for (const kind of QUERY_KINDS) {
    const { same, sameOrAnalog } = summary.byKind[kind];
    if (sameOrAnalog.cases) log(`  ${kind}: same product ${shareText(same)}, same or analog ${shareText(sameOrAnalog)}`);
  }
  const missed = runs.flatMap((run) => (run.status === "answered" && !isHit(run.anyRank)
    ? [`${run.caseId} (${run.anyRank === null ? "not in the results" : `rank ${run.anyRank}`})`] : []));
  if (missed.length) log(`  missed: ${missed.join(", ")}`);
  for (const run of runs) if (run.status === "failed") log(`  FAIL case ${run.caseId}: ${run.error}`);
  if (summary.failed) log(`  ${summary.failed} searches failed and count in no share: the number is not final`);
  if (stopped) log(`  STOPPED after ${runs.length} of ${cases} cases: ${stopped}`);
  if (summary.incomplete) log(`  ${summary.incomplete} answers may be incomplete: a list stopped short of its rows`);
  const unread = runs.flatMap((run) => (run.status === "answered" && run.textUnreadReason !== null
    ? [`${run.caseId} (${run.textUnreadReason})`] : []));
  if (unread.length) log(`  ${unread.length} texts went without Claude's reading, the number is not final: ${unread.join(", ")}`);
}

async function runTest(loaded: LoadedCase[], service: SearchService, file: string, report: Record<string, unknown>, stop: AbortSignal):
  Promise<boolean> {
  const models: Record<string, unknown> = {};
  let isOk = true;
  for (const model of SEARCH_MODEL_NAMES) {
    log(`${model}: running ${loaded.length} cases`);
    const modelRun = await runModel(loaded, model, service, stop);
    const summary = summarize(modelRun.runs);
    models[model] = { summary, ...modelRun };
    // After each model, so a failure of the next does not lose what was paid for
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(file, `${JSON.stringify({ ...report, models }, null, 2)}\n`);
    printSummary(model, summary, modelRun, loaded.length);
    isOk &&= !modelRun.stopped && !summary.failed && !summary.textUnread;
  }
  return isOk;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cases: { type: "string" }, "condition-pass": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const casesFile = values.cases ?? DEFAULT_CASES_FILE;
  const conditionPass = values["condition-pass"] ? CONDITION_PASS : null;
  const read = await readCasesFile(casesFile);
  const db = createPrisma(config.databaseUrl, (error) => console.error(scrub(`database pool error: ${error.message}`, secrets)));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("stopped by SIGINT")));
  try {
    const { inputs, issues: inputIssues } = await loadInputs(read.cases, join(dirname(casesFile), PHOTOS_FOLDER), conditionPass);
    const { expected, issues: codeIssues } = await resolveExpected(db, read.cases);
    const issues = [...read.issues, ...inputIssues, ...codeIssues];
    if (issues.length) {
      for (const issue of issues) log(`ISSUE ${issue}`);
      log(`${issues.length} issues in ${casesFile}: fix them, nothing was paid for`);
      return 1;
    }
    const loaded = read.cases.map((kase) => ({
      kase, input: inputs.get(kase.id) as SearchInput, expected: expected.get(kase.id) as ExpectedModels,
    }));
    const searchBudget = dailyBudgetFromEnv("SEARCH_BUDGET_USD");
    const parseBudget = dailyBudgetFromEnv("QUERY_PARSE_BUDGET_USD");
    const parser = queryParserFromEnv(parseBudget, memoryReadings());
    const estimate = estimateOf(loaded.map(({ input }) => input), parser);
    printPlan(loaded, estimate, parser);
    log(`the pass over the catalogue's facts (--condition-pass): ${conditionPass ? "on" : "off"}`);
    log(`limits of a run: SEARCH_BUDGET_USD $${searchBudget.limitUsd}, QUERY_PARSE_BUDGET_USD $${parseBudget.limitUsd}`);
    checkLimits(estimate, searchBudget.limitUsd, parseBudget.limitUsd);
    if (values["dry-run"]) return 0;
    const embedder = new QueryEmbedder(searchBudget);
    // Every key before the first paid call
    for (const model of SEARCH_MODEL_NAMES) embedder.provider(model);
    if (!parser.isConfigured) throw new ConfigError("ANTHROPIC_API_KEY is not set: the web screen reads the text with Claude");
    const date = new Date().toISOString();
    const file = join(OUTPUT_DIR, `report-${date.replaceAll(":", "-")}.json`);
    const report = { date, casesFile, cases: loaded.length, topK: TOP_K, parseModel: parser.model, conditionPass, estimate };
    const isOk = await runTest(loaded, createSearchService(db, embedder, parser), file, report, controller.signal);
    log(`report: ${file}`);
    return isOk ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Errors that explain themselves: a stack trace would only bury the message
  const isExpected = error instanceof ConfigError || error instanceof ModelNotConfigured
    || (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS"));
  const text = error instanceof Error ? (isExpected ? error.message : error.stack ?? error.message) : String(error);
  console.error(scrub(text, secrets));
  process.exitCode = 1;
}
