// The catalogue import of each supplier in turn (docs/integrations.md, «Імпорт каталогів»): read the full catalogue,
// plan against the database, then write in batches and mark inactive what a complete catalogue no longer has.
// A dry run reads the supplier and the database and writes nothing.
import { config } from "../config.js";
import { refreshSearchRanks } from "../embeddings/store.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { scrub } from "../suppliers/secrets.js";
import type { FetchContext, SupplierAdapter } from "../suppliers/types.js";
import { ImportStopped } from "./errors.js";
import { finishRun, findSource, releaseLease, renewLease, startRun, takeLease, upsertSource } from "./lock.js";
import { changedRaw, emptyState, planImport, readState, readTotals } from "./plan.js";
import { planLines, snapshotLines, totalLines, writtenLines } from "./report.js";
import { massDeactivation, rowsOf } from "./rows.js";
import { deactivateMissing, writeRows, type WrittenCounts } from "./write.js";

export interface ImportOptions {
  adapters: SupplierAdapter[];
  isDryRun: boolean;
  allowMassDeactivation: boolean;
  context: FetchContext;
}

// The database the import (or the embeddings worker) is about to write, by name; with POSTGRES_DB set it must be that
// one
export async function checkDatabase(db: PrismaClient, log: (line: string) => void): Promise<void> {
  const [row] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const name = row?.name ?? "?";
  log(`database: ${name}`);
  const expected = config.postgresDb;
  if (expected && expected !== name) {
    throw new ImportStopped(`DATABASE_URL points at "${name}", POSTGRES_DB says "${expected}": stopped before any write`);
  }
}

async function readAndPlan(db: PrismaClient, adapter: SupplierAdapter, sourceId: number | null, options: ImportOptions) {
  const { log } = options.context;
  const code = adapter.source.code;
  const snapshot = await adapter.fetchCatalog(options.context);
  for (const line of snapshotLines(code, snapshot)) log(line);
  const rows = rowsOf(snapshot);
  const state = sourceId === null ? emptyState() : await readState(db, sourceId);
  const plan = planImport(state, rows);
  for (const line of planLines(code, plan)) log(line);
  // An incomplete snapshot marks nothing inactive, so its missing rows are no danger
  const refusal = snapshot.isComplete ? massDeactivation(plan) : undefined;
  if (refusal && !options.allowMassDeactivation) throw new ImportStopped(`${code}: ${refusal}`);
  return { snapshot, rows, state, plan };
}

async function importSource(db: PrismaClient, adapter: SupplierAdapter, options: ImportOptions): Promise<void> {
  const { log, signal, secrets } = options.context;
  const code = adapter.source.code;
  if (options.isDryRun) {
    await readAndPlan(db, adapter, await findSource(db, code), options);
    log(`${code}: dry run, nothing written`);
    return;
  }
  const sourceId = await upsertSource(db, adapter.source);
  const runId = await startRun(db, sourceId);
  const counts: Record<string, unknown> = {};
  try {
    const holder = await takeLease(db, sourceId, runId);
    if (holder) throw new ImportStopped(`${code}: ${holder}`);
    const { snapshot, rows, state, plan } = await readAndPlan(db, adapter, sourceId, options);
    Object.assign(counts, { fetched: snapshot.fetched, checks: snapshot.checks, examples: snapshot.examples,
      warnings: snapshot.warnings, isComplete: snapshot.isComplete, plan });
    // Renewed now: reading a catalogue can take minutes
    await renewLease(db, sourceId, runId);
    const written: WrittenCounts = {};
    counts.written = written;
    await writeRows(db, sourceId, runId, { ...rows, raw: changedRaw(state, rows) }, signal, written);
    signal.throwIfAborted();
    const deactivated = snapshot.isComplete ? await deactivateMissing(db, sourceId, runId) : undefined;
    await refreshSearchRanks(db, sourceId);
    const totals = await readTotals(db, sourceId);
    for (const line of [...writtenLines(code, written, deactivated), ...totalLines(code, totals)]) log(line);
    Object.assign(counts, { deactivated, totals });
    // Written, but a catalogue not read to its end is a failed run: what it no longer has stays active until a
    // complete read, and the exit code says so to whoever runs it
    if (!snapshot.isComplete) {
      throw new ImportStopped(`${code}: the catalogue was not read to its end, nothing marked inactive`
        + ` (${snapshot.warnings.join("; ") || "see the read lines"})`);
    }
    await finishRun(db, runId, counts);
    log(`${code}: done, sync_run ${runId}`);
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), secrets);
    // The import's own error is the one to report; a log row that could not be closed is said beside it
    await finishRun(db, runId, counts, message).catch((closeError: unknown) =>
      log(`${code}: sync_run ${runId} not closed: ${scrub(String(closeError), secrets)}`));
    throw error;
  } finally {
    await releaseLease(db, sourceId, runId).catch((releaseError: unknown) =>
      log(`${code}: lease of sync_run ${runId} not released, it runs out by itself: ${scrub(String(releaseError), secrets)}`));
  }
}

export function describeError(error: unknown, signal: AbortSignal): string {
  if (!(error instanceof Error)) return String(error);
  // A stop and a guard say all in their message; an unexpected error needs its stack
  return error instanceof ImportStopped || signal.aborted ? error.message : error.stack ?? error.message;
}

// Every supplier is tried even when one fails; false when any failed or the run was stopped. A stop (SIGTERM) ends
// the run before the next supplier.
export async function runImport(db: PrismaClient, options: ImportOptions): Promise<boolean> {
  const { log, signal, secrets } = options.context;
  await checkDatabase(db, log);
  let isOk = true;
  for (const adapter of options.adapters) {
    if (signal.aborted) return false;
    try {
      await importSource(db, adapter, options);
    } catch (error) {
      isOk = false;
      log(`FAIL ${adapter.source.code}: ${scrub(describeError(error, signal), secrets)}`);
    }
  }
  return isOk && !signal.aborted;
}
