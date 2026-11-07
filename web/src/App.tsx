import { type KeyboardEvent, type SubmitEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, type FactFilters, fetchOptions, search, type SearchBody, type SearchOptions } from "./api";
import { Filters } from "./Filters";
import { apiFilters, type FilterState, MAX_RESULTS, parseMinStock, type SharedCategoryEntry, sharedCategoryIndex } from "./format";
import { encodeJpeg, fullRect } from "./image";
import { type Photo, PhotoInput } from "./PhotoInput";
import { ErrorNote, type SearchState, SearchView } from "./SearchView";
import { type ErrorText, searchErrorText, text } from "./text";
import type { OwnProducts } from "./useOwnProducts";

// The API's bound for the text (src/search/request.ts)
const MAX_TEXT_CHARS = 1_000;
const EMPTY_FILTERS: FilterState = {
  sources: [], supplierCategories: [], sharedCategories: [], minStock: "", model: "", facts: {}, isConditionPass: false,
};

type OptionsState = { kind: "loading" } | { kind: "ok"; options: SearchOptions } | { kind: "error"; error: ErrorText };

function errorTextOf(error: unknown): ErrorText {
  if (error instanceof ApiError) return searchErrorText(error.failure);
  console.error(error);
  return { message: text.search.failed, detail: null };
}

// The default model when it has a key, or the first one with a key
function initialModel(options: SearchOptions): string {
  const configured = options.models.filter((model) => model.isConfigured);
  return (configured.find((model) => model.isDefault) ?? configured[0])?.name ?? "";
}

// The body of a search from the form, or what is missing from it
function searchBody(query: string, photo: Photo | null, filters: FilterState): SearchBody | string {
  const trimmed = query.trim();
  if (!trimmed && !photo) return text.search.needInput;
  if (!filters.model) return text.search.noModel;
  const minStock = parseMinStock(filters.minStock);
  if (minStock === "invalid") return text.filters.minStockInvalid;
  let image: string | undefined;
  try {
    image = photo ? encodeJpeg(photo.image, photo.crop ?? fullRect(photo)) : undefined;
  } catch (error) {
    console.error(error);
    return text.search.imageFailed;
  }
  return {
    ...(trimmed ? { text: trimmed } : {}),
    ...(image ? { image } : {}),
    model: filters.model,
    conditionPass: filters.isConditionPass,
    filters: apiFilters(filters, minStock),
    limit: MAX_RESULTS,
  };
}

export function App({ own }: { own: OwnProducts }) {
  const [optionsState, setOptionsState] = useState<OptionsState>({ kind: "loading" });
  const [optionsLoad, setOptionsLoad] = useState(0);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);
  // Each search is paid: a second click before the answer sends nothing
  const isSearching = useRef(false);
  const searchCount = useRef(0);
  const queryId = useId();
  const resultsHeadingId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchOptions(controller.signal)
      .then((options) => {
        setOptionsState({ kind: "ok", options });
        setFilters((current) => (current.model ? current : { ...current, model: initialModel(options) }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOptionsState({ kind: "error", error: errorTextOf(error) });
      });
    return () => controller.abort();
  }, [optionsLoad]);

  const categories = useMemo(() => (optionsState.kind === "ok"
    ? sharedCategoryIndex(optionsState.options.sharedCategories)
    : new Map<string, SharedCategoryEntry>()), [optionsState]);

  const runSearch = async (searchFilters: FilterState) => {
    if (isSearching.current || optionsState.kind !== "ok") return;
    const body = searchBody(query, photo, searchFilters);
    if (typeof body === "string") {
      setFormError(body);
      return;
    }
    setFormError(null);
    isSearching.current = true;
    setSearchState((current) => ({ kind: "pending", previous: current.kind === "done" ? current.shown : null }));
    try {
      const response = await search(body);
      searchCount.current += 1;
      setSearchState({ kind: "done", shown: {
        id: searchCount.current, response, query: query.trim(), photo, categories: searchFilters.sharedCategories,
        facts: searchFilters.facts, filters: body.filters,
      } });
      own.showModels(response.results.map((result) => result.modelId));
    } catch (error) {
      setSearchState({ kind: "error", error: errorTextOf(error) });
    } finally {
      isSearching.current = false;
    }
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runSearch(filters);
  };

  const onQueryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const applyCategory = (code: string) => {
    const next = { ...filters, sharedCategories: [...filters.sharedCategories, code] };
    setFilters(next);
    void runSearch(next);
  };

  const applyFact = (facts: FactFilters) => {
    const next = { ...filters, facts: { ...filters.facts, ...facts } };
    setFilters(next);
    void runSearch(next);
  };

  const changePhoto = (next: Photo | null) => {
    setPhoto(next);
    setFormError(null);
  };

  const retryOptions = () => {
    setOptionsState({ kind: "loading" });
    setOptionsLoad((count) => count + 1);
  };

  const isPending = searchState.kind === "pending";
  return (
    <div className="layout">
      <form className="query-panel" onSubmit={onSubmit}>
        <h1>{text.title}</h1>
        <PhotoInput photo={photo} onChange={changePhoto} />
        <div className="panel-block">
          <label htmlFor={queryId} className="label">{text.query.heading}</label>
          <textarea
            id={queryId}
            rows={3}
            maxLength={MAX_TEXT_CHARS}
            placeholder={text.query.placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFormError(null);
            }}
            onKeyDown={onQueryKeyDown}
          />
          <p className="hint">{text.query.hint}</p>
        </div>
        {optionsState.kind === "loading" && <p className="hint">{text.options.loading}</p>}
        {optionsState.kind === "error" && (
          <ErrorNote error={{ ...optionsState.error, message: `${text.options.failed} ${optionsState.error.message}` }}>
            <button type="button" onClick={retryOptions}>{text.options.retry}</button>
          </ErrorNote>
        )}
        {optionsState.kind === "ok" && (
          <Filters
            options={optionsState.options}
            value={filters}
            onChange={setFilters}
            categories={categories}
            isMinStockInvalid={parseMinStock(filters.minStock) === "invalid"}
          />
        )}
        <div className="submit">
          <button type="submit" className="primary" disabled={isPending || optionsState.kind !== "ok"}>
            {isPending ? text.search.pending : text.search.button}
          </button>
          {formError && <p className="error-text" role="alert">{formError}</p>}
        </div>
      </form>
      <main className="results" aria-labelledby={resultsHeadingId} aria-busy={isPending}>
        <h2 id={resultsHeadingId} className="visually-hidden">{text.results.heading}</h2>
        <SearchView
          state={searchState}
          categories={categories}
          query={query}
          photo={photo}
          onApplyCategory={applyCategory}
          onApplyFact={applyFact}
          own={own}
        />
      </main>
    </div>
  );
}
