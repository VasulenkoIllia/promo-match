// The search's own errors, each answered with a status of its own (src/search/routes.ts, searchFailure). Kept apart
// from the modules that read the database or the environment, so the routes load neither.

// A request the search cannot run, with a message safe to show the client
export class SearchInputError extends Error {
  override name = "SearchInputError";
}

// The model has no key in the environment: the search answers that it is not configured
export class ModelNotConfigured extends Error {
  override name = "ModelNotConfigured";
}

// A query of the search ran past its statement_timeout (src/search/store.ts); a count of candidates past its own
// does not fail the search (src/search/search.ts, listScans)
export class SearchTimedOut extends Error {
  override name = "SearchTimedOut";
}
