// The search API of the server (src/search/routes.ts, docs/integrations.md, «Пошук»), its grades (src/grades/routes.ts,
// «Оцінки»), its own products API (src/own-products/routes.ts, «Свої товари») and its sign-in (src/auth/routes.ts,
// «Логін»; the users API is users-api.ts): the shapes the UI reads, copied from src/search/search.ts, results.ts, query-parse.ts, store.ts,
// src/grades/request.ts and src/own-products/store.ts rather than imported, since those modules load Node's types.
// Fields the UI does not show are left out.

interface CategoryName {
  uk: string;
  en: string;
}

interface ModelOption {
  name: string;
  provider: string;
  isDefault: boolean;
  // false: the server has no key for it, a search answers 503
  isConfigured: boolean;
}

interface SourceOption {
  code: string;
  name: string;
  // false: the supplier gives no stock, so the minimum stock filter leaves out all its models
  hasStock: boolean;
}

interface SharedCategoryOption {
  code: string;
  name: CategoryName;
  models: number;
}

export interface SharedGroupOption extends SharedCategoryOption {
  categories: SharedCategoryOption[];
}

// A supplier's own English category path, with its active models
export interface CategoryOption {
  source: string;
  path: string[];
  models: number;
}

export interface SearchOptions {
  models: ModelOption[];
  sources: SourceOption[];
  categories: CategoryOption[];
  sharedCategories: SharedGroupOption[];
}

// An empty list is refused by the API (400): a filter not wanted is left out
export interface FactFilters {
  volumeMl?: { min?: number; max?: number };
  materials?: string[];
  // Sides in centimetres, longest first
  sizeCm?: { min?: number[]; max?: number[] };
}

// A prefix of a supplier's English category path: ["BAGS & BACKPACKS"] or ["BAGS & BACKPACKS", "backpacks"]
export interface CategoryFilter {
  source: string;
  path: string[];
}

export interface SearchFilters extends FactFilters {
  sources?: string[];
  // A model passes when one of the paths is a prefix of its own
  categories?: CategoryFilter[];
  sharedCategories?: string[];
  minStock?: number;
}

export interface SearchBody {
  text?: string;
  // A data URL of a JPEG
  image?: string;
  model: string;
  // The second pass over the models whose catalogue confirms what the query asks; false ranks by the vectors alone
  conditionPass: boolean;
  filters: SearchFilters;
  limit: number;
}

export interface PriceRange {
  min: number | null;
  max: number | null;
  currency: string | null;
}

interface SuggestedFilters {
  sharedCategories: string[];
  colors: string[];
  materials: string[];
  price: PriceRange | null;
}

// What the query asks of one product
export interface Conditions {
  volumeMl: { min: number | null; max: number | null } | null;
  materials: string[];
  sizeCm: { min: number[]; max: number[] } | null;
}

type ParseFailure = "not-configured" | "budget-spent" | "timed-out" | "rejected" | "provider-failed" | "refused"
  | "bad-answer";

export type QueryParse =
  // englishText null: the query names nothing of the product, its text went as it is
  | { status: "ok"; englishText: string | null; conditions: Conditions[]; suggestedFilters: SuggestedFilters }
  | { status: "unavailable"; reason: ParseFailure };

interface ResultPhoto {
  id: number | null;
  url: string;
  urlLarge: string | null;
}

export interface ResultVariant {
  sku: string;
  color: string | null;
  size: string | null;
  // null: the supplier gave no stock, or the last import did not see it
  inStock: number | null;
  // date: YYYY-MM-DD
  nextArrival: { date: string | null; quantity: number | null } | null;
  // amount: numeric(12,4) as text, in the supplier's currency (a purchase price)
  price: { amount: string; currency: string } | null;
}

export type Match = "fits" | "unknown" | "against";

// One word per condition; null: the query does not ask that
export interface ConditionMatch {
  volumeMl: Match | null;
  materials: Match | null;
  sizeCm: Match | null;
  printTechniques: Match | null;
  sheets: Match | null;
  gsm: Match | null;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface SearchResult {
  rank: number;
  // The code the query named this model by, as written; null: found by its look or description
  matchedCode: string | null;
  // How many results that code named, this one too: over 1 when several suppliers have the code; null without a code
  matchedCodeModels: number | null;
  // What the catalogue says of the conditions of the query's product that found it; null: that product has none, or
  // only a code found the model
  conditionMatch: ConditionMatch | null;
  // null: nothing was measured for such a search, as for a model other than the default
  confidence: { percent: number; level: ConfidenceLevel } | null;
  modelId: number;
  source: { code: string; name: string };
  code: string;
  name: string | null;
  // The supplier's English category path
  category: string[];
  // The model's page on its supplier's site, built by the site's rule: it may be gone. null: none can be named.
  pageUrl: string | null;
  // The photos that matched, best first, or the model's cover when only its text did
  photos: ResultPhoto[];
  variants: ResultVariant[];
  // Not shown: a grade sends it back, for the confidence percent to be measured on
  lists: Record<string, { rank: number; similarity: number }>;
}

export interface SearchResponse {
  // Kept nowhere by the server: the grades of this search come back with it
  searchId: string;
  model: string;
  // false: a list through the index stopped short, nearer models may be missing
  isComplete: boolean;
  // false: nothing in the catalogue is near the text; null: the search has nothing to say of it
  hasCloseMatch: boolean | null;
  // null: no list used the text
  queryParse: QueryParse | null;
  tookMs: number;
  // What this search paid at list prices, an estimate
  costUsd: number;
  results: SearchResult[];
}

export type Grade = "exact" | "suitable" | "wrong";

export interface GradeBody {
  grade: Grade;
  // Left out: a search by photo alone
  text?: string;
  hasPhoto: boolean;
  model: string;
  filters: SearchFilters;
  rank: number;
  confidencePercent: number | null;
  lists: SearchResult["lists"];
  conditionMatch: ConditionMatch | null;
  matchedCode: string | null;
}

export type LinkType = "same" | "analog";

export interface OwnProduct {
  id: number;
  name: string;
  code: string | null;
}

export interface LinkedModel {
  modelId: number;
  type: LinkType;
  source: { code: string; name: string };
  code: string;
  name: string | null;
  // false: the last import no longer found the model
  isActive: boolean;
  photoUrl: string | null;
}

export interface OwnProductEntry extends OwnProduct {
  links: LinkedModel[];
}

export interface OwnProductList {
  products: OwnProductEntry[];
  // false: more products or links than the list holds
  isComplete: boolean;
}

// A link as a result card shows it
export interface ModelLink {
  modelId: number;
  ownProductId: number;
  ownProductName: string;
  type: LinkType;
}

export interface NewOwnProduct {
  name: string;
  code: string;
}

// The server checks the role on every request of the users API; the UI only hides what a manager cannot open
export type Role = "admin" | "manager";

export interface SignedInUser {
  login: string;
  role: Role;
}

export type ApiFailure =
  | { kind: "network" }
  | { kind: "timeout" }
  // detail: the server's own message ({ error }), in English
  | { kind: "status"; status: number; detail: string | null }
  // A limit per user or per login: a 429 with Retry-After. The daily budget's 429 has none and comes as a status.
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "bad-answer" };

export class ApiError extends Error {
  override name = "ApiError";

  constructor(readonly failure: ApiFailure) {
    super(failure.kind === "status" ? `HTTP ${failure.status}` : failure.kind);
  }
}

// Past the server's own deadline of a search (40 s, src/search/routes.ts) the request is given up
const SEARCH_TIMEOUT_MS = 45_000;
const OPTIONS_TIMEOUT_MS = 15_000;
const GRADE_TIMEOUT_MS = 15_000;
const OWN_PRODUCTS_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 15_000;
export const JSON_HEADERS = { "content-type": "application/json" };
const UNAUTHORIZED = 401;
const TOO_MANY_REQUESTS = 429;

let onSignedOut: () => void = () => undefined;

// Who is told that the session is over: a 401 from any call, wherever it was made
export function setSignedOutListener(listener: () => void): void {
  onSignedOut = listener;
}

// The server answers every error as { error } (src/app.ts); a proxy's page has none
async function errorDetail(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error : null;
}

async function failureOf(response: Response): Promise<ApiFailure> {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  if (response.status === TOO_MANY_REQUESTS && retryAfterSeconds > 0) return { kind: "limited", retryAfterSeconds };
  return { kind: "status", status: response.status, detail: await errorDetail(response) };
}

// The lists the UI maps over are there: a server of another version would otherwise break the page, not the request
function hasLists(body: unknown, keys: string[]): boolean {
  return typeof body === "object" && body !== null
    && keys.every((key) => Array.isArray((body as Record<string, unknown>)[key]));
}

// The caller's own abort is passed on as it is; the rest becomes an ApiError
export async function call<T>(url: string, init: RequestInit, timeoutMs: number, lists: string[], signal?: AbortSignal):
  Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const fail = (error: unknown, otherwise: ApiFailure): never => {
    if (signal?.aborted) throw error;
    throw new ApiError(timeout.aborted ? { kind: "timeout" } : otherwise);
  };
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    return fail(error, { kind: "network" });
  }
  if (!response.ok) {
    if (response.status === UNAUTHORIZED) onSignedOut();
    return fail(signal?.reason, await failureOf(response));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A body cut short is the connection's failure; a body that is not JSON, the server's
    return fail(error, error instanceof SyntaxError ? { kind: "bad-answer" } : { kind: "network" });
  }
  if (!hasLists(body, lists)) throw new ApiError({ kind: "bad-answer" });
  return body as T;
}

export function fetchSignedInUser(signal: AbortSignal): Promise<SignedInUser> {
  return call<SignedInUser>("/api/auth/me", {}, AUTH_TIMEOUT_MS, [], signal);
}

export function signIn(login: string, password: string): Promise<SignedInUser> {
  return call<SignedInUser>("/api/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ login, password }),
  }, AUTH_TIMEOUT_MS, []);
}

export async function signOut(): Promise<void> {
  await call("/api/auth/logout", { method: "POST" }, AUTH_TIMEOUT_MS, []);
}

export function fetchOptions(signal: AbortSignal): Promise<SearchOptions> {
  return call<SearchOptions>("/api/search/options", {}, OPTIONS_TIMEOUT_MS,
    ["models", "sources", "categories", "sharedCategories"], signal);
}

export function search(body: SearchBody): Promise<SearchResponse> {
  return call<SearchResponse>("/api/search", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }, SEARCH_TIMEOUT_MS, ["results"]);
}

export async function setGrade(searchId: string, modelId: number, body: GradeBody): Promise<void> {
  await call(`/api/search/grades/${searchId}/${modelId}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }, GRADE_TIMEOUT_MS, []);
}

export async function removeGrade(searchId: string, modelId: number): Promise<void> {
  await call(`/api/search/grades/${searchId}/${modelId}`, { method: "DELETE" }, GRADE_TIMEOUT_MS, []);
}

export function fetchOwnProducts(signal: AbortSignal): Promise<OwnProductList> {
  return call<OwnProductList>("/api/own-products", {}, OWN_PRODUCTS_TIMEOUT_MS, ["products"], signal);
}

export function createOwnProduct(body: NewOwnProduct): Promise<OwnProduct> {
  return call<OwnProduct>("/api/own-products", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }, OWN_PRODUCTS_TIMEOUT_MS, []);
}

export async function fetchModelLinks(modelIds: number[], signal: AbortSignal): Promise<ModelLink[]> {
  const query = new URLSearchParams(modelIds.map((id) => ["modelIds", String(id)]));
  const { links } = await call<{ links: ModelLink[] }>(`/api/own-products/links?${query.toString()}`, {},
    OWN_PRODUCTS_TIMEOUT_MS, ["links"], signal);
  return links;
}

export async function linkModel(ownProductId: number, modelId: number, type: LinkType): Promise<void> {
  await call(`/api/own-products/${ownProductId}/links/${modelId}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ type }),
  }, OWN_PRODUCTS_TIMEOUT_MS, []);
}

export async function unlinkModel(ownProductId: number, modelId: number): Promise<void> {
  await call(`/api/own-products/${ownProductId}/links/${modelId}`, { method: "DELETE" }, OWN_PRODUCTS_TIMEOUT_MS, []);
}
