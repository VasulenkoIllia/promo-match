// The embeddings run of each source in turn (docs/integrations.md, «Ембедінги каталогу»): texts, then photos, under a
// lease and a spending limit, logged in sync_run (kind embed). A dry run reads the database and a few photos for their
// size, prints what a run would send and what it would cost at list prices, and writes nothing.
import type { PrismaClient } from "../generated/prisma/client.js";
import { ImportStopped } from "../import/errors.js";
import { findSource, finishRun, startRun } from "../import/lock.js";
import { checkDatabase, describeError } from "../import/run.js";
import type { UrlFetch } from "../suppliers/http.js";
import { photoFetchFor } from "../suppliers/registry.js";
import { scrub } from "../suppliers/secrets.js";
import type { FetchContext } from "../suppliers/types.js";
import { ProviderError } from "./api.js";
import { type Budget, BudgetReached } from "./batch.js";
import { downloadImage } from "./image.js";
import { leaseName, releaseWorkerLease, renewWorkerLease, takeWorkerLease } from "./lease.js";
import { embedPhotos, type EmbedJob, emptyPhotoCounts, type PhotoCounts } from "./photos.js";
import type { EmbeddingProvider } from "./provider.js";
import { nextPhotos, photoTotals, refreshSearchRanks } from "./store.js";
import { textChars } from "./text.js";
import { embedTexts, emptyTextCounts, readTextPlan, type TextCounts, type TextPlan } from "./texts.js";

export interface EmbedOptions {
  codes: string[];
  isDryRun: boolean;
  limit: number | undefined;
  isRetryFailed: boolean;
  // The provider of a run; a dry run prices with each of these
  providers: EmbeddingProvider[];
  // Required for a run, unused by a dry run
  budget: Budget | undefined;
  context: FetchContext;
}

// Photos a dry run downloads per source to learn their size (Voyage prices by pixels)
const SIZE_SAMPLE = 8;
// The size priced when no photo of the sample could be read: the most Voyage bills for one image
const UNKNOWN_PIXELS = 2_000_000;
const USD_DIGITS = 2;
const MEGA = 1_000_000;

function usd(value: number): string {
  return `$${value.toFixed(USD_DIGITS)}`;
}

function textLine(code: string, plan: TextPlan, counts?: TextCounts): string {
  const done = counts ? `embedded ${counts.embedded}, refused ${counts.failed}; ` : "";
  return `${code}: texts of ${plan.total} models: ${done}new ${plan.created.length}, changed ${plan.changed.length},`
    + ` unchanged ${plan.unchanged}, without an English name ${plan.withoutText.length}`;
}

function photoLine(code: string, counts: PhotoCounts): string {
  return `${code}: photos: embedded ${counts.embedded}, reused ${counts.reused}, failed ${counts.failed},`
    + ` deferred ${counts.deferred}; calls ${counts.calls}`;
}

// The mean size of a few photos still to embed (the first ones by id, of any provider); undefined when none was read
async function meanPixels(db: PrismaClient, sourceId: number, model: string, options: EmbedOptions,
  fetchPhoto: UrlFetch | undefined): Promise<number | undefined> {
  const photos = await nextPhotos(db, sourceId, model, 0, SIZE_SAMPLE, options.isRetryFailed);
  const sizes: number[] = [];
  for (const photo of photos) {
    const download = await downloadImage(photo.url, options.context.signal, fetchPhoto);
    if (download.kind === "ok") sizes.push(download.info.width * download.info.height);
  }
  options.context.log(`size sample: ${sizes.length} of ${photos.length} photos read`);
  return sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : undefined;
}

async function planSource(db: PrismaClient, code: string, sourceId: number, options: EmbedOptions): Promise<void> {
  const { log } = options.context;
  const fetchPhoto = photoFetchFor(code, options.context.secrets);
  let pixels: number | undefined;
  for (const provider of options.providers) {
    const totals = await photoTotals(db, sourceId, provider.name);
    const plan = await readTextPlan({ db, sourceId }, provider.name);
    const texts = [...plan.created, ...plan.changed].slice(0, options.limit);
    const photos = Math.min(totals.pending + (options.isRetryFailed ? totals.failed : 0), options.limit ?? Infinity);
    if (pixels === undefined && photos) {
      pixels = await meanPixels(db, sourceId, provider.name, options, fetchPhoto);
      if (pixels === undefined) {
        log(`${code}: WARNING no photo of the size sample could be read; priced at ${UNKNOWN_PIXELS / MEGA} Mpx each`);
        pixels = UNKNOWN_PIXELS;
      }
    }
    const price = provider.priceUsd({
      imagePixels: new Array<number>(photos).fill(pixels ?? 0),
      textChars: texts.reduce((sum, text) => sum + textChars(text.input), 0),
    });
    log(`${code}: ${provider.name}: photos in scope ${totals.inScope}: ready ${totals.ready}, failed ${totals.failed},`
      + ` pending ${totals.pending}; to send ${photos}`);
    log(textLine(code, plan));
    log(`${code}: ${provider.name}: estimate ${usd(price)} at list prices for ${photos} photos`
      + ` (about ${((pixels ?? 0) / MEGA).toFixed(2)} Mpx each) and ${texts.length} texts`);
  }
}

async function runSource(db: PrismaClient, code: string, sourceId: number, options: EmbedOptions): Promise<void> {
  const { log, signal, secrets } = options.context;
  const [provider] = options.providers;
  const { budget } = options;
  if (!provider || !budget) throw new ImportStopped("a run needs EMBED_PROVIDER and EMBED_BUDGET_USD");
  const runId = await startRun(db, sourceId, "embed");
  const name = leaseName(code);
  const spentBefore = budget.spentUsd;
  const texts = emptyTextCounts();
  const photos = emptyPhotoCounts();
  const counts: Record<string, unknown> = { provider: provider.name, limitUsd: budget.limitUsd, texts, photos };
  try {
    const holder = await takeWorkerLease(db, name, sourceId, runId);
    if (holder) throw new ImportStopped(`${code}: ${holder}`);
    const job: EmbedJob = {
      db, provider, budget, sourceId, limit: options.limit, isRetryFailed: options.isRetryFailed, signal, secrets,
      fetchPhoto: photoFetchFor(code, secrets),
      beforeBatch: async () => {
        signal.throwIfAborted();
        await renewWorkerLease(db, name, runId);
      },
    };
    try {
      log(textLine(code, await embedTexts(job, texts), texts));
      await embedPhotos(job, photos);
      log(`${code}: search ranks changed for ${await refreshSearchRanks(db, sourceId)} photos`);
    } finally {
      counts.spentUsd = budget.spentUsd - spentBefore;
      log(photoLine(code, photos));
      log(`${code}: spent ${usd(budget.spentUsd - spentBefore)} at list prices (run ${usd(budget.spentUsd)}`
        + ` of ${usd(budget.limitUsd)}); provider usage ${JSON.stringify({ texts: texts.usage, photos: photos.usage })}`);
      for (const example of [...texts.examples, ...photos.examples]) log(`${code}:   ${example}`);
    }
    const totals = await photoTotals(db, sourceId, provider.name);
    const plan = await readTextPlan(job, provider.name);
    counts.totals = { photos: totals, texts: { models: plan.total, ready: plan.unchanged } };
    log(`${code}: in the database (${provider.name}): photos in scope ${totals.inScope}: ready ${totals.ready},`
      + ` failed ${totals.failed}, pending ${totals.pending}; texts of ${plan.total} models: ready ${plan.unchanged}`);
    // A full run that leaves photos pending (the CDN deferred them) or texts refused is not done: the exit code says so
    const textsLeft = plan.created.length + plan.changed.length;
    if (options.limit === undefined && (totals.pending > 0 || textsLeft > 0)) {
      throw new ImportStopped(`${code}: ${totals.pending} photos still pending and ${textsLeft} texts without a`
        + ` vector; run again (photo.error says why a photo was deferred)`);
    }
    await finishRun(db, runId, counts);
    log(`${code}: done, sync_run ${runId}`);
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), secrets);
    await finishRun(db, runId, counts, message).catch((closeError: unknown) =>
      log(`${code}: sync_run ${runId} not closed: ${scrub(String(closeError), secrets)}`));
    throw error;
  } finally {
    await releaseWorkerLease(db, name, runId).catch((releaseError: unknown) =>
      log(`${code}: lease ${name} not released, it runs out by itself: ${scrub(String(releaseError), secrets)}`));
  }
}

// A failure of the provider or the budget would only repeat for the next source
function isRunWide(error: unknown): boolean {
  return error instanceof BudgetReached || error instanceof ProviderError;
}

// Every source is tried even when one fails, except after a stop, a reached budget or a provider failure; false when
// any failed
export async function runEmbeddings(db: PrismaClient, options: EmbedOptions): Promise<boolean> {
  const { log, signal, secrets } = options.context;
  await checkDatabase(db, log);
  let isOk = true;
  let isStopped = false;
  for (const [index, code] of options.codes.entries()) {
    if (signal.aborted || isStopped) {
      log(`not started: ${options.codes.slice(index).join(", ")}`);
      return false;
    }
    try {
      const sourceId = await findSource(db, code);
      if (sourceId === null) throw new ImportStopped(`${code}: no catalogue in the database, run the import first`);
      if (options.isDryRun) {
        await planSource(db, code, sourceId, options);
        log(`${code}: dry run, nothing sent or written`);
      } else {
        await runSource(db, code, sourceId, options);
      }
    } catch (error) {
      isOk = false;
      log(`FAIL ${code}: ${scrub(describeError(error, signal), secrets)}`);
      isStopped = isRunWide(error);
    }
  }
  return isOk && !signal.aborted;
}
