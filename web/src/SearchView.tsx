import { type ReactNode, useState } from "react";
import type { FactFilters, SearchFilters, SearchResponse, SearchResult } from "./api";
import { countChoices, DEFAULT_RESULT_COUNT, type SharedCategoryEntry } from "./format";
import type { Photo } from "./PhotoInput";
import { QueryParseNote } from "./QueryParseNote";
import { Results } from "./Results";
import { type ErrorText, text } from "./text";
import type { OwnProducts } from "./useOwnProducts";

const NO_RESULTS: SearchResult[] = [];

// A search on screen and what it was made of: its suggestions apply to that form only
export interface ShownSearch {
  // A new search draws new cards, rather than keeping the photo picked in a card of the last one
  id: number;
  response: SearchResponse;
  query: string;
  photo: Photo | null;
  categories: string[];
  // The fact filters of the search shown
  facts: FactFilters;
  // All its filters as they were sent: a grade keeps them
  filters: SearchFilters;
}

export type SearchState =
  | { kind: "idle" }
  // The previous results stay on screen, dimmed, until the new ones come
  | { kind: "pending"; previous: ShownSearch | null }
  | { kind: "done"; shown: ShownSearch }
  | { kind: "error"; error: ErrorText };

export function ErrorNote({ error, children }: { error: ErrorText; children?: ReactNode }) {
  return (
    <div className="note error" role="alert">
      <p>{error.message}</p>
      {error.detail && <p className="hint" lang="en">{error.detail}</p>}
      {children}
    </div>
  );
}

interface SearchViewProps {
  state: SearchState;
  categories: Map<string, SharedCategoryEntry>;
  // The form as it is now, to tell whether the search shown still matches it
  query: string;
  photo: Photo | null;
  onApplyCategory: (code: string) => void;
  onApplyFact: (facts: FactFilters) => void;
  own: OwnProducts;
}

export function SearchView({ state, categories, query, photo, onApplyCategory, onApplyFact, own }: SearchViewProps) {
  // Stays from one search to the next: a manager picks it once
  const [count, setCount] = useState(DEFAULT_RESULT_COUNT);
  const shown = state.kind === "done" ? state.shown : state.kind === "pending" ? state.previous : null;
  const found = shown ? shown.response.results : NO_RESULTS;
  const choices = countChoices(found.length);
  // The count picked may be past what this search has, or between its choices
  const visibleCount = choices.find((choice) => choice >= count) ?? found.length;
  if (state.kind === "idle") return <p className="hint">{text.search.idle}</p>;
  if (state.kind === "error") return <ErrorNote error={state.error} />;
  const isPending = state.kind === "pending";
  const summary = isPending ? text.search.pending
    : text.results.summary(visibleCount, state.shown.response.tookMs, state.shown.response.model, state.shown.response.costUsd);
  return (
    <div className={isPending ? "is-pending" : undefined}>
      <div className="results-head">
        <p className="summary" role="status">{summary}</p>
        {choices.length > 1 && (
          <label className="result-count">
            {text.results.count}
            <select value={visibleCount} onChange={(event) => setCount(Number(event.target.value))}>
              {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </label>
        )}
      </div>
      {shown && (
        <>
          {shown.response.queryParse && (
            <QueryParseNote
              parse={shown.response.queryParse}
              categories={categories}
              appliedCategories={shown.categories}
              appliedFacts={shown.facts}
              hasCodeHit={shown.response.results.some((result) => result.matchedCode !== null)}
              isPending={isPending}
              isStale={shown.query !== query.trim() || shown.photo !== photo}
              onApplyCategory={onApplyCategory}
              onApplyFact={onApplyFact}
            />
          )}
          {!shown.response.isComplete && <p className="note warn">{text.results.incomplete}</p>}
          {shown.response.hasCloseMatch === false && <p className="note warn">{text.results.noCloseMatch}</p>}
          {own.hasMarksFailed && <p className="note warn">{text.own.marksFailed}</p>}
          {found.some((result) => result.confidence) && (
            <p className="hint confidence-note">
              {text.results.confidenceNote}
              {shown.photo && ` ${text.results.confidenceNotePhoto}`}
            </p>
          )}
          <Results key={shown.id} results={found} count={visibleCount} own={own} search={shown} />
        </>
      )}
    </div>
  );
}
