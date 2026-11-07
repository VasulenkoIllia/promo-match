// Sample comparison of the embedding providers (stage 3, decision 2026-10-29): the same photos and texts of a few
// hundred models of both suppliers go to every provider, and each is scored on finding the model again: its name finds
// its photos, a photo finds the other photos of its model, a photo finds its model's text (src/embeddings/compare.ts).
// Writes nothing to the database; the report goes to output/embeddings-compare/ (outside git).
//   npm run embed:compare -- [--models 200] [--provider voyage|gemini] [--dry-run]
// --dry-run downloads the sample photos and prints the cost at list prices, calling no provider. A run needs the keys
// of the providers and EMBED_BUDGET_USD (src/embeddings/provider.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config, ConfigError } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { Budget, mapSettled } from "../src/embeddings/batch.js";
import { type Doc, type Metrics, type Query, retrievalMetrics } from "../src/embeddings/compare.js";
import { downloadImage, type ImageMimeType } from "../src/embeddings/image.js";
import {
  budgetFromEnv, type EmbeddingProvider, type EmbedResult, isProviderCode, PROVIDER_CODES, providerFromEnv, type TextInput,
} from "../src/embeddings/provider.js";
import { IN_SCOPE, readModelTexts } from "../src/embeddings/store.js";
import { ImportStopped } from "../src/import/errors.js";
import { modelText, textChars } from "../src/embeddings/text.js";
import { scrub } from "../src/suppliers/secrets.js";

const DEFAULT_MODELS = 200;
const PHOTOS_PER_MODEL = 3;
const DOWNLOAD_CONCURRENCY = 8;
const OUTPUT_DIR = "output/embeddings-compare";
const MS_PER_SECOND = 1_000;
// The providers' keys and the database password, scrubbed from everything printed
const secrets: string[] = [];

interface SamplePhoto {
  id: number;
  modelCode: string;
  bytes: Buffer;
  mimeType: ImageMimeType;
  pixels: number;
}

interface SampleModel {
  code: string;
  text: TextInput;
  photos: SamplePhoto[];
}

interface SampleRow {
  source_id: number;
  model_id: number;
  code: string;
  photo_id: number;
  url: string;
}

// Half the models from each source, picked by the hash of their code (the same sample on every run), with up to
// PHOTOS_PER_MODEL photos each, the first ones of their variants first
async function readSample(db: PrismaClient, models: number, log: (line: string) => void, signal: AbortSignal):
  Promise<SampleModel[]> {
  const perSource = Math.ceil(models / 2);
  const rows = await db.$queryRaw<SampleRow[]>`
    WITH picked AS (
      SELECT m.id, m.source_id, m.code, row_number() OVER (PARTITION BY m.source_id ORDER BY md5(m.code)) AS n
      FROM product_model m
      WHERE m.is_active AND EXISTS (SELECT 1 FROM photo p WHERE p.model_id = m.id AND ${IN_SCOPE})
    ), photos AS (
      SELECT p.model_id, p.id, p.url, row_number() OVER (PARTITION BY p.model_id
        ORDER BY (SELECT min(pv.position) FROM photo_variant pv WHERE pv.photo_id = p.id), p.id) AS k
      FROM photo p JOIN product_model m ON m.id = p.model_id JOIN picked ON picked.id = m.id
      WHERE picked.n <= ${perSource} AND ${IN_SCOPE}
    )
    SELECT picked.source_id, picked.id AS model_id, picked.code, photos.id AS photo_id, photos.url
    FROM picked JOIN photos ON photos.model_id = picked.id
    WHERE picked.n <= ${perSource} AND photos.k <= ${PHOTOS_PER_MODEL}
    ORDER BY picked.source_id, picked.id, photos.k`;
  const texts = new Map<number, TextInput | undefined>();
  for (const sourceId of new Set(rows.map((row) => row.source_id))) {
    for (const row of await readModelTexts(db, sourceId, "")) texts.set(row.id, modelText(row));
  }
  const downloads = await mapSettled(rows, DOWNLOAD_CONCURRENCY, (row) => downloadImage(row.url, signal));
  const sample = new Map<number, SampleModel>();
  rows.forEach((row, index) => {
    const result = downloads[index];
    const text = texts.get(row.model_id);
    if (!text) {
      log(`model ${row.code} skipped: no English name`);
      return;
    }
    const model = sample.get(row.model_id) ?? { code: row.code, text, photos: [] };
    sample.set(row.model_id, model);
    if (result?.status !== "fulfilled" || result.value.kind !== "ok") {
      const reason = result?.status === "fulfilled" && result.value.kind !== "ok" ? result.value.error : "not downloaded";
      log(`photo ${row.photo_id} skipped: ${reason}`);
      return;
    }
    const { bytes, info } = result.value;
    model.photos.push({
      id: row.photo_id, modelCode: row.code, bytes, mimeType: info.mimeType, pixels: info.width * info.height,
    });
  });
  const kept = [...sample.values()].filter((model) => model.photos.length > 0);
  if (kept.length < sample.size) log(`${sample.size - kept.length} models skipped: none of their photos downloaded`);
  return kept;
}

// The inputs every provider gets: catalogue photos and texts as documents, names and first photos as queries
function inputsOf(sample: SampleModel[]) {
  const photos = sample.flatMap((model) => model.photos);
  const queryPhotos = sample.filter((model) => model.photos.length > 1).map((model) => model.photos[0] as SamplePhoto);
  return { photos, queryPhotos, texts: sample.map((model) => model.text), names: sample.map((model) => model.text.text.split("\n", 1)[0] ?? "") };
}

function priceOf(provider: EmbeddingProvider, inputs: ReturnType<typeof inputsOf>): number {
  return provider.priceUsd({
    imagePixels: [...inputs.photos, ...inputs.queryPhotos].map((photo) => photo.pixels),
    textChars: inputs.texts.reduce((sum, text) => sum + textChars(text), 0) + inputs.names.join("").length,
  });
}

// Batches one after another: the timing is the provider's, not our concurrency
async function embedAll<T>(items: T[], size: number, budget: Budget, price: (batch: T[]) => number,
  call: (batch: T[]) => Promise<EmbedResult>, timing: { requests: number; ms: number }): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    budget.reserve(price(batch));
    const started = Date.now();
    vectors.push(...(await call(batch)).vectors);
    timing.requests += 1;
    timing.ms += Date.now() - started;
  }
  return vectors;
}

async function scoreProvider(provider: EmbeddingProvider, sample: SampleModel[], budget: Budget, signal: AbortSignal) {
  const inputs = inputsOf(sample);
  const timing = { requests: 0, ms: 0 };
  const images = (photos: SamplePhoto[], role: "document" | "query") => embedAll(photos, provider.maxImagesPerRequest, budget,
    (batch) => provider.priceUsd({ imagePixels: batch.map((photo) => photo.pixels), textChars: 0 }),
    (batch) => provider.embedImages(batch, role, signal), timing);
  const texts = (items: TextInput[], role: "document" | "query") => embedAll(items, provider.maxTextsPerRequest, budget,
    (batch) => provider.priceUsd({ imagePixels: [], textChars: batch.reduce((sum, text) => sum + textChars(text), 0) }),
    (batch) => provider.embedTexts(batch, role, signal), timing);
  const photoVectors = await images(inputs.photos, "document");
  const queryPhotoVectors = await images(inputs.queryPhotos, "query");
  const textVectors = await texts(inputs.texts, "document");
  const nameVectors = await texts(inputs.names.map((name) => ({ title: null, text: name })), "query");
  const photoDocs: Doc[] = inputs.photos.map((photo, index) =>
    ({ id: String(photo.id), key: photo.modelCode, vector: photoVectors[index] as number[] }));
  const textDocs: Doc[] = sample.map((model, index) => ({ id: model.code, key: model.code, vector: textVectors[index] as number[] }));
  const photoQueries: Query[] = inputs.queryPhotos.map((photo, index) =>
    ({ selfId: String(photo.id), key: photo.modelCode, vector: queryPhotoVectors[index] as number[] }));
  const nameQueries: Query[] = sample.map((model, index) => ({ key: model.code, vector: nameVectors[index] as number[] }));
  const metrics: Record<string, Metrics> = {
    "name → photos": retrievalMetrics(nameQueries, photoDocs),
    "photo → photos": retrievalMetrics(photoQueries, photoDocs),
    "photo → texts": retrievalMetrics(photoQueries, textDocs),
  };
  return { metrics, requests: timing.requests, seconds: timing.ms / MS_PER_SECOND, estimateUsd: priceOf(provider, inputs) };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { models: { type: "string" }, provider: { type: "string" }, "dry-run": { type: "boolean", default: false } },
    strict: true,
  });
  const models = Number(values.models ?? DEFAULT_MODELS);
  if (!Number.isInteger(models) || models < 2) throw new ConfigError(`--models must be an integer from 2, got "${values.models}"`);
  if (values.provider !== undefined && !isProviderCode(values.provider)) {
    throw new ConfigError(`--provider must be one of ${PROVIDER_CODES.join(", ")}, got "${values.provider}"`);
  }
  const isDryRun = values["dry-run"];
  const log = (line: string) => console.log(scrub(line, secrets));
  const password = databasePassword(config.databaseUrl);
  if (password) secrets.push(password);
  const providers = (values.provider ? [values.provider] : [...PROVIDER_CODES]).map((code) => {
    const { provider, apiKey } = providerFromEnv(code, isDryRun);
    if (apiKey) secrets.push(apiKey);
    return provider;
  });
  const budget = isDryRun ? undefined : new Budget(budgetFromEnv());
  const db = createPrisma(config.databaseUrl, (error) => log(`database pool error: ${error.message}`));
  // Ctrl+C stops the calls under way; the report keeps what was scored before it
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new ImportStopped("stopped by SIGINT")));
  try {
    const sample = await readSample(db, models, log, controller.signal);
    const inputs = inputsOf(sample);
    log(`sample: ${sample.length} models, ${inputs.photos.length} photos, ${inputs.queryPhotos.length} query photos`);
    const report: Record<string, unknown> = { date: new Date().toISOString(), models: sample.map((model) => model.code) };
    const file = join(OUTPUT_DIR, `${new Date().toISOString().replaceAll(":", "-")}.json`);
    let isOk = true;
    for (const provider of providers) {
      log(`${provider.name}: estimate $${priceOf(provider, inputs).toFixed(4)} at list prices`);
      if (!budget || controller.signal.aborted) continue;
      try {
        const result = await scoreProvider(provider, sample, budget, controller.signal);
        report[provider.name] = result;
        log(`${provider.name}: ${result.requests} requests, ${result.seconds.toFixed(1)} s`);
        for (const [name, metric] of Object.entries(result.metrics)) {
          log(`${provider.name}:   ${name.padEnd(15)} queries ${metric.queries}  recall@1 ${metric.recall["@1"]}`
            + `  @5 ${metric.recall["@5"]}  @10 ${metric.recall["@10"]}  MRR ${metric.mrr}`);
        }
      } catch (error) {
        // One provider failing must not lose the other's paid results
        isOk = false;
        const message = scrub(error instanceof Error ? error.message : String(error), secrets);
        report[provider.name] = { error: message };
        log(`FAIL ${provider.name}: ${message}`);
      }
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (budget) log(`report: ${file}; spent $${budget.spentUsd.toFixed(4)} of $${budget.limitUsd} at list prices`);
    return isOk ? 0 : 1;
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
