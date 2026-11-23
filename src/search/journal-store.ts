// The journal of searches in the database (src/search/journal.ts): a row goes in as the journal made it, and rows older
// than JOURNAL_DAYS are deleted on the server's own schedule (not by deploy/nightly.sh, which is installed on the host
// by hand: the pruning comes with a release), by one copy of the app at a time.
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { jsonParam } from "../import/write.js";
import { journalErrorKind, type JournalWrite } from "./journal.js";
import type { QueryParse } from "./query-parse.js";
import type { SearchFilters } from "./store.js";

// The owner's decision of 2026-11-23 (docs/decisions.md)
export const JOURNAL_DAYS = 90;
const DAY_MS = 86_400_000;
// Rows per transaction: deleting a row deletes its photo's TOAST chunks too (some 150 for 300 KB), so a batch stays
// well inside PRUNE_TRANSACTION_MS even on a cold cache, and a deploy's migration never waits long behind it
const PRUNE_BATCH_ROWS = 500;
// Bounds one run; what is left goes on the next
const PRUNE_MAX_BATCHES = 100;
// Prisma's own bound of an interactive transaction is 5 s; the statement's is below it, so the database cancels a slow
// DELETE itself rather than leave it running after Prisma gave up
const PRUNE_TRANSACTION_MS = 30_000;
const PRUNE_STATEMENT_TIMEOUT = "25s";
// The key of the pruning's advisory lock, no other lock of this database uses it: during a deploy the old and the new
// copy of the app both run, and only one of them prunes
const PRUNE_LOCK_KEY = 20_261_123;
// After the start, so a restart loop does not prune on every start; then four times a day
export const PRUNE_FIRST_AFTER_MS = 60_000;
export const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

export function journalWriter(db: PrismaClient): JournalWrite {
  return async ({ photo, results, settings, ...entry }) => {
    // Postgres text and jsonb refuse NUL and a lone surrogate, which no screen sends: they are cut from the strings
    // (src/import/write.ts, jsonParam) rather than the row lost
    const [queryText, queryParse, filters] = JSON.parse(jsonParam([entry.queryText, entry.queryParse, entry.filters])) as
      [string | null, QueryParse | null, SearchFilters];
    await db.searchJournal.create({
      data: {
        ...entry,
        queryText,
        // A copy over an ArrayBuffer of its own, as Prisma's Bytes takes it
        photo: photo && new Uint8Array(photo),
        queryParse: queryParse === null ? Prisma.DbNull : queryParse as unknown as Prisma.InputJsonObject,
        filters: filters as Prisma.InputJsonObject,
        // Names and levels of src/search/settings.ts only: no text, nothing to cut
        settings: settings as unknown as Prisma.InputJsonObject,
        results: results as unknown as Prisma.InputJsonArray,
      },
      select: { searchId: true },
    });
  };
}

export function journalCutoff(now: Date): Date {
  return new Date(now.getTime() - JOURNAL_DAYS * DAY_MS);
}

// Deletes the rows older than JOURNAL_DAYS, oldest first, in batches, and says how many; null: another copy of the app
// held the lock, and prunes now. The lock is a transaction's: a pooled connection never keeps it after the batch. A
// stop signal ends the run between batches.
export async function pruneSearchJournal(db: PrismaClient, now = new Date(), signal?: AbortSignal): Promise<number | null> {
  // With its zone: a bare timestamp would be read in the session's time zone
  const cutoff = journalCutoff(now).toISOString();
  let deleted = 0;
  for (let batch = 0; batch < PRUNE_MAX_BATCHES && !signal?.aborted; batch += 1) {
    const count = await db.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ isTaken: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${PRUNE_LOCK_KEY}::bigint) AS "isTaken"`;
      if (!lock?.isTaken) return null;
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${PRUNE_STATEMENT_TIMEOUT}, true)`;
      return tx.$executeRaw`
        DELETE FROM search_journal WHERE search_id IN (
          SELECT search_id FROM search_journal WHERE created_at < ${cutoff}::timestamptz
          ORDER BY created_at LIMIT ${PRUNE_BATCH_ROWS}::int)`;
    }, { timeout: PRUNE_TRANSACTION_MS });
    // The other copy goes on from here
    if (count === null) return batch ? deleted : null;
    deleted += count;
    if (count < PRUNE_BATCH_ROWS) break;
  }
  return deleted;
}

export interface PruneLog {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface PruneSchedule {
  // Stops the timers, ends a run still going after its batch and waits for it, so the database is not closed under it
  stop(): Promise<void>;
}

// Prunes firstAfterMs after the start, then every everyMs; a run still going when the next is due is not doubled
export function scheduleJournalPrune(prune: (signal: AbortSignal) => Promise<number | null>, log: PruneLog,
  { firstAfterMs = PRUNE_FIRST_AFTER_MS, everyMs = PRUNE_EVERY_MS } = {}): PruneSchedule {
  const stopping = new AbortController();
  let running: Promise<void> | undefined;
  const run = () => {
    if (running) return;
    running = prune(stopping.signal).then((deleted) => {
      if (deleted === null) log.info({}, "search journal: another copy of the app prunes it");
      else log.info({ deleted, days: JOURNAL_DAYS }, "search journal: searches past their days deleted");
    }, (error: unknown) => {
      // The kind only, as for a failed write
      log.error({ error: journalErrorKind(error) }, "search journal: pruning failed");
    }).finally(() => {
      running = undefined;
    });
  };
  const first = setTimeout(run, firstAfterMs);
  const every = setInterval(run, everyMs);
  first.unref();
  every.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(every);
      stopping.abort();
      await running;
    },
  };
}
