// The vectors of the brand-free model texts (src/embeddings/brand-words.ts), a candidate of the independent test (README
// «Незалежний тест»): every active model of every source, embedded by the search model the variant belongs to and
// written beside that model's own vectors under the variant's name (src/search/models.ts, TEXT_VARIANTS). The screen
// never reads them. A model is embedded again only when its brand-free text changed (text_hash), so a repeat pays for
// what is missing alone. Run one at a time: two at once would both pay for the same texts.
//   pnpm run embed:brand-free [--dry-run]
// --dry-run reads the database and prints per source what would go, its cost at list prices and a few names before and
// after, calling no provider. A run needs GEMINI_API_KEY and EMBED_BUDGET_USD.
import { parseArgs } from "node:util";
import { config, ConfigError } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import { Budget } from "../src/embeddings/batch.js";
import { brandFreeText, brandWords, descriptionWords, withoutWords } from "../src/embeddings/brand-words.js";
import type { EmbedJob } from "../src/embeddings/photos.js";
import { budgetFromEnv, providerFromEnv } from "../src/embeddings/provider.js";
import { type ModelTextRow, readModelTexts } from "../src/embeddings/store.js";
import { textChars } from "../src/embeddings/text.js";
import { embedTexts, emptyTextCounts, planTexts, type TextPlan, type TextShape } from "../src/embeddings/texts.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { ImportStopped } from "../src/import/errors.js";
import { BRAND_FREE_TEXTS, SEARCH_MODELS, TEXT_VARIANTS } from "../src/search/models.js";
import { scrub } from "../src/suppliers/secrets.js";

// Names shown before and after, per source
const EXAMPLES = 4;
const USD_DIGITS = 4;
const secrets: string[] = [];

function log(line: string): void {
  console.log(scrub(line, secrets));
}

interface SourceTexts {
  id: number;
  code: string;
  rows: ModelTextRow[];
}

// Every source's active models with their English fields and the hash of the variant's text, if any
async function readSources(db: PrismaClient): Promise<SourceTexts[]> {
  const sources = await db.source.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } });
  return Promise.all(sources.map(async (source) => ({ ...source, rows: await readModelTexts(db, source.id, BRAND_FREE_TEXTS) })));
}

function planLine(code: string, plan: TextPlan): string {
  return `${code}: ${plan.total} models: new ${plan.created.length}, changed ${plan.changed.length}, unchanged ${plan.unchanged},`
    + ` without an English name ${plan.withoutText.length}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, strict: true });
  const isDryRun = values["dry-run"];
  const password = databasePassword(config.databaseUrl);
  if (password) secrets.push(password);
  const { model } = TEXT_VARIANTS[BRAND_FREE_TEXTS];
  const { provider, apiKey } = providerFromEnv(SEARCH_MODELS[model].provider, isDryRun);
  if (apiKey) secrets.push(apiKey);
  if (provider.name !== model) throw new Error(`the provider makes ${provider.name}, the variant belongs to ${model}`);
  const budget = isDryRun ? undefined : new Budget(budgetFromEnv());
  const db = createPrisma(config.databaseUrl, (error) => log(`database pool error: ${error.message}`));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new ImportStopped("stopped by SIGINT")));
  try {
    const sources = await readSources(db);
    const counts = descriptionWords(sources.flatMap(({ rows }) => rows.map((row) => row.description)));
    const shape: TextShape = (row) => brandFreeText(row, counts);
    log(`${BRAND_FREE_TEXTS}: ${counts.size} words in the descriptions of ${sources.reduce((sum, { rows }) => sum + rows.length, 0)} models`);
    let totalUsd = 0;
    let refused = 0;
    for (const { id, code, rows } of sources) {
      const plan = planTexts(rows, shape);
      const todo = [...plan.created, ...plan.changed];
      const usd = provider.priceUsd({ imagePixels: [], textChars: todo.reduce((sum, text) => sum + textChars(text.input), 0) });
      totalUsd += usd;
      log(`${planLine(code, plan)}; to send ${todo.length}, about $${usd.toFixed(USD_DIGITS)} at list prices`);
      for (const row of rows.slice(0, EXAMPLES)) {
        log(`${code}:   ${row.name ?? ""} -> ${withoutWords(row.name ?? "", brandWords(row, counts)) || "(no name, the description speaks)"}`);
      }
      if (!budget) continue;
      const job: EmbedJob = {
        db, provider, budget, sourceId: id, limit: undefined, isRetryFailed: false, signal: controller.signal, secrets,
        fetchPhoto: undefined,
        beforeBatch: () => {
          controller.signal.throwIfAborted();
          return Promise.resolve();
        },
      };
      const done = emptyTextCounts();
      try {
        await embedTexts(job, done, { name: BRAND_FREE_TEXTS, shape });
      } finally {
        log(`${code}: embedded ${done.embedded}, refused ${done.failed}, calls ${done.calls}; spent $${budget.spentUsd.toFixed(USD_DIGITS)}`
          + ` of $${budget.limitUsd}; usage ${JSON.stringify(done.usage)}`);
        for (const example of done.examples) log(`${code}:   ${example}`);
      }
      refused += done.failed;
    }
    if (!budget) {
      log(`dry run: about $${totalUsd.toFixed(USD_DIGITS)} at list prices, nothing sent or written`);
      return 0;
    }
    // A refused text has no vector: the test stops on it (scripts/independent-test.ts), and a repeat sends it again
    log(`done: spent $${budget.spentUsd.toFixed(USD_DIGITS)} at list prices, ${refused} texts refused`);
    return refused ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

main().then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  const isPlain = error instanceof ConfigError || error instanceof ImportStopped;
  console.error(scrub(error instanceof Error ? (isPlain ? error.message : error.stack ?? error.message) : String(error), secrets));
  process.exitCode = 1;
});
