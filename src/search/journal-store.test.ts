import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { JournalEntry } from "./journal.js";
import {
  JOURNAL_DAYS, journalCutoff, journalWriter, type PruneLog, pruneSearchJournal, scheduleJournalPrune,
} from "./journal-store.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-23T12:00:00Z");

interface Row {
  searchId: string;
  createdAt: Date;
}

// A journal table in memory: the DELETE keeps the order, the cutoff and the batch the store sends; isLockFree false is
// another copy of the app holding the pruning's lock
function fakeDb(rows: Row[], isLockFree = true) {
  const batches: number[] = [];
  const timeouts: unknown[] = [];
  const tx = {
    $queryRaw: () => Promise.resolve([{ isTaken: isLockFree }]),
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!strings.join("").includes("DELETE")) return Promise.resolve(1);
      const [cutoff, batchRows] = values as [string, number];
      const old = rows.filter((row) => row.createdAt < new Date(cutoff))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, batchRows);
      for (const row of old) rows.splice(rows.indexOf(row), 1);
      batches.push(old.length);
      return Promise.resolve(old.length);
    },
  };
  const db = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>, options: { timeout?: number }) => {
      timeouts.push(options.timeout);
      return work(tx);
    },
  } as unknown as PrismaClient;
  return { db, batches, timeouts };
}

const daysAgo = (days: number, searchId = `s${days}`): Row => ({ searchId, createdAt: new Date(NOW.getTime() - days * DAY_MS) });

describe("pruneSearchJournal", () => {
  it("deletes a search older than 90 days and keeps the younger ones", async () => {
    expect(JOURNAL_DAYS).toBe(90);
    const rows = [daysAgo(91), daysAgo(89), daysAgo(0)];
    const { db } = fakeDb(rows);
    expect(await pruneSearchJournal(db, NOW)).toBe(1);
    expect(rows.map((row) => row.searchId)).toEqual(["s89", "s0"]);
  });

  it("cuts at exactly 90 days before now", () => {
    expect(journalCutoff(NOW)).toEqual(new Date("2026-08-25T12:00:00Z"));
  });

  it("goes on in batches of 500 while a batch comes full, each within a transaction longer than Prisma's 5 s", async () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => daysAgo(100 + index / 1_000, `s${index}`));
    const { db, batches, timeouts } = fakeDb(rows);
    expect(await pruneSearchJournal(db, NOW)).toBe(1_200);
    expect(batches).toEqual([500, 500, 200]);
    expect(rows).toEqual([]);
    expect(timeouts).toEqual([30_000, 30_000, 30_000]);
  });

  it("stops between batches on a stop signal", async () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => daysAgo(100 + index / 1_000, `s${index}`));
    const { db, batches } = fakeDb(rows);
    const stopping = new AbortController();
    stopping.abort();
    expect(await pruneSearchJournal(db, NOW, stopping.signal)).toBe(0);
    expect(batches).toEqual([]);
  });

  it("leaves the pruning to the copy of the app that holds the lock", async () => {
    const rows = [daysAgo(91)];
    const { db, batches } = fakeDb(rows, false);
    expect(await pruneSearchJournal(db, NOW)).toBeNull();
    expect(batches).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe("journalWriter", () => {
  const entry: JournalEntry = {
    searchId: "3f2b1c9e-7a46-4e0b-9d11-2c5a8f6e1b70", userId: 4, queryText: "mug", queryParse: null, hasPhoto: true,
    photo: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), photoSizeBytes: 4, embeddingModel: "gemini-embedding-2/1536",
    filters: { minStock: 10 }, resultLimit: 100, isParseQuery: true, isConditionPass: false,
    results: [{ modelId: 7, rank: 1, confidencePercent: 90, photos: 2 }], tookMs: 812,
  };

  function writeOf(row: JournalEntry) {
    const created: { data: Record<string, unknown>; select: unknown }[] = [];
    const db = {
      searchJournal: {
        create: (call: { data: Record<string, unknown>; select: unknown }) => {
          created.push(call);
          return Promise.resolve({ searchId: row.searchId });
        },
      },
    } as unknown as PrismaClient;
    return journalWriter(db)(row).then(() => created);
  }

  it("writes the row as the journal made it: the photo's bytes, SQL NULL for no reading, the results as a list", async () => {
    const [call] = await writeOf(entry);
    expect(call?.data).toEqual({
      ...entry, photo: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), queryParse: Prisma.DbNull,
    });
    // The photo is not read back
    expect(call?.select).toEqual({ searchId: true });
  });

  it("cuts NUL and a lone surrogate from the strings, which Postgres text and jsonb refuse, and keeps the rest", async () => {
    const [call] = await writeOf({
      ...entry, queryText: "red\u0000 mug", filters: { categories: [{ source: "axpol", path: ["DRINK\u0000WARE"] }] },
      queryParse: { status: "unavailable", model: "claude-haiku-5-5", reason: "timed-out", message: "half \ud800" },
    });
    expect(call?.data).toMatchObject({
      queryText: "red mug", filters: { categories: [{ source: "axpol", path: ["DRINKWARE"] }] },
      queryParse: { status: "unavailable", model: "claude-haiku-5-5", reason: "timed-out", message: "half �" },
    });
  });
});

describe("scheduleJournalPrune", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function recordingLog() {
    const lines: string[] = [];
    const log: PruneLog = {
      info: (_fields, message) => lines.push(`info ${message}`),
      error: (_fields, message) => lines.push(`error ${message}`),
    };
    return { log, lines };
  }

  it("prunes after the start and on schedule, never twice at once, and stops after the run under way", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let finish: (deleted: number) => void = () => {};
    let runSignal: AbortSignal | undefined;
    const prune = (signal: AbortSignal) => {
      runs += 1;
      runSignal = signal;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    };
    const { log, lines } = recordingLog();
    const schedule = scheduleJournalPrune(prune, log, { firstAfterMs: 1_000, everyMs: 5_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    // Due again while the first run still goes: skipped
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs).toBe(1);
    let isStopped = false;
    const stopping = schedule.stop().then(() => {
      isStopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isStopped).toBe(false);
    // The run under way is told to end after its batch
    expect(runSignal?.aborted).toBe(true);
    finish(3);
    await stopping;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(1);
    expect(lines).toEqual(["info search journal: searches past their days deleted"]);
  });

  it("logs a failed run and runs again on schedule", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const prune = () => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error("database is down")) : Promise.resolve(0);
    };
    const { log, lines } = recordingLog();
    const schedule = scheduleJournalPrune(prune, log, { firstAfterMs: 1_000, everyMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await schedule.stop();
    expect(runs).toBe(2);
    expect(lines).toEqual(["error search journal: pruning failed", "info search journal: searches past their days deleted"]);
  });
});
