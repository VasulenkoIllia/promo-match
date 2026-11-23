// The journal of searches (docs/integrations.md, «Журнал пошуків»; owner's decision of 2026-11-23, docs/decisions.md):
// one row per search the API answered, so a complaint can be searched again as it was. The row is made here from the
// input and the answer: the text, Claude's reading, the reference photo the search embedded, the request, and the
// results as model, place and confidence, without purchase prices. The route starts the write once the answer is made
// and does not wait for it (src/search/routes.ts); the writes and the pruning are in src/search/journal-store.ts. The
// text and the photo go to the database only, never to a log.
import type { QueryParse } from "./query-parse.js";
import type { SearchInput } from "./request.js";
import type { SearchResponse } from "./search.js";
import type { SearchFilters } from "./store.js";

// The screen's photo is a JPEG of up to 1024 px (web/src/image.ts), a few hundred kilobytes; of a larger one, which did
// not come from the screen, only the size is kept
export const MAX_JOURNAL_PHOTO_BYTES = 1024 * 1024;

export interface JournalResult {
  modelId: number;
  rank: number;
  confidencePercent: number | null;
  // How many photos the answer gave the model (its cover when only its text matched): 0 says a card without a picture
  // came so from the server, not from the browser (feedback item 12, docs/requirements.md)
  photos: number;
}

export interface JournalEntry {
  searchId: string;
  userId: number;
  queryText: string | null;
  queryParse: QueryParse | null;
  hasPhoto: boolean;
  photo: Uint8Array | null;
  photoSizeBytes: number | null;
  embeddingModel: string;
  filters: SearchFilters;
  resultLimit: number;
  isParseQuery: boolean;
  isConditionPass: boolean;
  results: JournalResult[];
  tookMs: number;
}

export type JournalWrite = (entry: JournalEntry) => Promise<void>;

export interface SearchJournal {
  // Starts the write and gives back its promise at once: the answer does not wait for it. The entry is made inside, so a
  // fault in making it rejects too and never reaches the search; a rejection is the caller's to log (journalFailure).
  record(make: () => JournalEntry): Promise<void>;
  // Waits for the writes still going: the server calls it before the database closes
  settle(): Promise<void>;
}

export function journalEntry(searchId: string, userId: number, input: SearchInput, response: SearchResponse): JournalEntry {
  const photo = input.image?.bytes;
  return {
    searchId,
    userId,
    queryText: input.text ?? null,
    queryParse: response.queryParse,
    hasPhoto: photo !== undefined,
    photo: photo && photo.length <= MAX_JOURNAL_PHOTO_BYTES ? photo : null,
    photoSizeBytes: photo?.length ?? null,
    embeddingModel: input.model,
    filters: input.filters,
    resultLimit: input.limit,
    isParseQuery: input.parseQuery,
    isConditionPass: Boolean(input.conditionPass),
    results: response.results.map((result) => ({
      modelId: result.modelId, rank: result.rank, confidencePercent: result.confidence?.percent ?? null, photos: result.photos.length,
    })),
    tookMs: response.tookMs,
  };
}

export function createSearchJournal(write: JournalWrite): SearchJournal {
  const pending = new Set<Promise<unknown>>();
  return {
    record(make) {
      const writing = Promise.try(() => write(make()));
      const settled = writing.catch(() => undefined);
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return writing;
    },
    async settle() {
      await Promise.all(pending);
    },
  };
}

// The kind of an error of the journal, never its message, which may quote the row (Prisma's validation error prints the
// call with its data: the text, the photo's bytes)
export function journalErrorKind(error: unknown): { type: string; code: string | undefined } {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { type: error instanceof Error ? error.name : typeof error, code };
}

// What a failed write logs: the search and the kind of the error
export function journalFailure(searchId: string, error: unknown): Record<string, unknown> {
  return { searchId, error: journalErrorKind(error) };
}
