import {
  AXPOL_BASE, AXPOL_READ_METHOD, AXPOL_SINCE, JWT_MARGIN_MS, JWT_TTL_FALLBACK_SECONDS, readJwtTtlSeconds,
} from "../../src/suppliers/axpol/api.js";
import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import { isRecord } from "../../src/suppliers/normalize.js";
import { addNote, BYTES_PER_MB, exchange, HTTP_OK, report, SAMPLE_LIMIT, type Run, type StepResult } from "./run.js";

// Axpol B2B API (docs/integrations.md): Customer.Login, then Count and a small List page of each feed
const AXPOL_BASES = ["https://axpol.com.pl/api/b2b-api/", AXPOL_BASE] as const;
const AXPOL_TIMEOUT_MS = 30_000;
const AXPOL_MAX_BYTES = 10 * BYTES_PER_MB;
// A gateway or firewall that turns away a client without browser headers answers like this, not with JSON
const REFUSED_STATUSES = [403, 406, 415];
const UNAUTHORIZED = 401;

interface AxpolRead {
  method: string;
  params: Record<string, string>;
}
const PRODUCT_COUNT: AxpolRead = { method: "Product.Count", params: { date: AXPOL_SINCE } };
const PAGE = { date: AXPOL_SINCE, limit: String(SAMPLE_LIMIT), offset: "0" };
const AXPOL_READS: AxpolRead[] = [
  PRODUCT_COUNT,
  { method: "Product.List", params: PAGE },
  { method: "Stock.Count", params: { date: AXPOL_SINCE } },
  { method: "Stock.List", params: PAGE },
  { method: "Printing.Count", params: { date: AXPOL_SINCE } },
  { method: "Printing.List", params: PAGE },
];

// The supplier's Postman collection sends a browser User-Agent (verbatim, with its stray space) and
// Content-Type: application/json on every call. Tried only when a plain login is refused. The login keeps its
// multipart Content-Type: setting one by hand would drop the form boundary.
const COLLECTION_USER_AGENT = "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/41.0. 2272.118 Safari/537.36";
interface AxpolProfile {
  name: string;
  loginHeaders: Record<string, string>;
  readHeaders: Record<string, string>;
}
const AXPOL_PROFILES: AxpolProfile[] = [
  { name: "plain", loginHeaders: {}, readHeaders: {} },
  {
    name: "collection",
    loginHeaders: { "User-Agent": COLLECTION_USER_AGENT },
    readHeaders: { "User-Agent": COLLECTION_USER_AGENT, "Content-Type": "application/json" },
  },
];

interface AxpolSession {
  base: string;
  profile: AxpolProfile;
  uid: string;
  jwt: string;
  refreshAtMs: number;
  // A failed renewal ends the session: no more logins with this account in this run
  isExpired: boolean;
}

export type AxpolOutcome = "ok" | "refused" | "rejected" | "unreachable";

interface LoginAttempt {
  outcome: AxpolOutcome;
  session?: AxpolSession;
}

const OUTCOME_NOTES: Record<Exclude<AxpolOutcome, "ok">, string> = {
  rejected: "rejected by Axpol",
  refused: "refused before the API",
  unreachable: "no API answer",
};

function formatParams(params: Record<string, string>): string {
  return Object.entries(params).map(([name, value]) => `params[${name}]=${value}`).join(" ");
}

export function axpolPlan(): string[] {
  const refused = REFUSED_STATUSES.join(", ");
  const lines = [`Axpol, timeout ${AXPOL_TIMEOUT_MS / MS_PER_SECOND} s per request, each base in turn:`];
  for (const base of AXPOL_BASES) {
    lines.push(`  POST ${base}  form-data: method=Customer.Login, key, params[username], params[password]`);
  }
  lines.push(
    "  the login sends the API key, login and password to every base above;",
    `  a refused login (${refused} without JSON, or a 200 that is not JSON) is repeated once with the collection's`
      + " browser User-Agent;",
    `  a rejected login (Axpol's answer without success, ${UNAUTHORIZED}, or ${refused} with JSON) stops all further`
      + " logins, so a wrong password is not retried",
    "  on the first base that logs in, GET ?key=<key>&uid=<uid>&method=... with Authorization: Bearer <jwt>:",
  );
  for (const read of AXPOL_READS) lines.push(`    ${read.method} ${formatParams(read.params)}`);
  lines.push(
    `  on any other base that logs in: ${PRODUCT_COUNT.method} only`,
    `  the JWT is renewed a minute before it expires; a failed renewal skips the remaining reads`,
  );
  return lines;
}

// ok: success 1 with HTTP 200; rejected: Axpol's answer without success, a 401, or a firewall status with JSON
// (key, password, parameters: the same login would fail again); refused: a firewall status without JSON or a 200
// that is not JSON (tried again with browser headers); unreachable: no answer, a redirect, a missing endpoint, 5xx
export function axpolOutcome(status: number | undefined, json: unknown): AxpolOutcome {
  if (status === undefined) return "unreachable";
  if (isRecord(json) && "success" in json) {
    const isSuccess = json.success === 1 || json.success === "1" || json.success === true;
    return isSuccess && status === HTTP_OK ? "ok" : "rejected";
  }
  if (status === UNAUTHORIZED || (json !== undefined && REFUSED_STATUSES.includes(status))) return "rejected";
  if (REFUSED_STATUSES.includes(status) || (status === HTTP_OK && json === undefined)) return "refused";
  return "unreachable";
}

// Why a step failed, with Axpol's own message when it gave one
function noteOutcome(row: StepResult, outcome: AxpolOutcome, json: unknown): void {
  if (outcome === "ok") return;
  const message = isRecord(json) && typeof json.message === "string" && json.message ? `: ${json.message}` : "";
  addNote(row, `${OUTCOME_NOTES[outcome]}${message}`);
}

function sessionOf(run: Run, row: StepResult, base: string, profile: AxpolProfile, json: unknown) {
  const data = isRecord(json) && isRecord(json.data) ? json.data : {};
  const { jwt, uid } = data;
  if (typeof jwt !== "string" || !jwt || (typeof uid !== "string" && typeof uid !== "number")) {
    addNote(row, "success without data.jwt and data.uid");
    return undefined;
  }
  const ttlSeconds = readJwtTtlSeconds(jwt);
  run.jwtTtlSeconds ??= ttlSeconds;
  addNote(row, ttlSeconds ? `JWT lifetime ${ttlSeconds} s` : `JWT lifetime unknown, ${JWT_TTL_FALLBACK_SECONDS} s assumed`);
  const ttlMs = (ttlSeconds ?? JWT_TTL_FALLBACK_SECONDS) * MS_PER_SECOND;
  // Half the lifetime at least, so a short-lived token does not mean a login before every read
  const refreshAtMs = Date.now() + Math.max(ttlMs - JWT_MARGIN_MS, ttlMs / 2);
  return { base, profile, uid: String(uid), jwt, refreshAtMs, isExpired: false } satisfies AxpolSession;
}

async function loginOnce(run: Run, base: string, profile: AxpolProfile, label: string, isRequired: boolean) {
  const form = new FormData();
  form.set("method", "Customer.Login");
  form.set("key", run.env.axpolApiKey);
  form.set("params[username]", run.env.axpolLogin);
  form.set("params[password]", run.env.axpolPassword);
  const url = new URL(base);
  const { row, json } = await exchange(run, {
    supplier: "axpol", step: `Customer.Login (${label})`, isRequired, url,
    options: {
      method: "POST", headers: profile.loginHeaders, body: form, timeoutMs: AXPOL_TIMEOUT_MS, maxBytes: AXPOL_MAX_BYTES,
    },
    prefix: `axpol/${url.host}/Customer.Login.${label}`,
  });
  const outcome = axpolOutcome(row.status, json);
  noteOutcome(row, outcome, json);
  const session = outcome === "ok" ? sessionOf(run, row, base, profile, json) : undefined;
  row.isOk = session !== undefined;
  report(run, row);
  return { outcome, session } satisfies LoginAttempt;
}

// The plain login first; the collection's browser headers only when the plain one is refused
async function loginAxpol(run: Run, base: string): Promise<LoginAttempt> {
  let attempt: LoginAttempt = { outcome: "unreachable" };
  for (const profile of AXPOL_PROFILES) {
    attempt = await loginOnce(run, base, profile, profile.name, false);
    if (attempt.outcome !== "refused") break;
  }
  return attempt;
}

// A read counts when it brings data: a positive whole count, or at least one record on a List page
function checkRead(row: StepResult, read: AxpolRead, json: unknown): boolean {
  if (read.method.endsWith(".Count")) {
    const data = isRecord(json) && isRecord(json.data) ? json.data : {};
    const count = typeof data.count === "string" || typeof data.count === "number"
      ? Number(String(data.count).replace(/\s/g, ""))
      : Number.NaN;
    if (!Number.isInteger(count) || count <= 0) {
      addNote(row, "no positive whole number in data.count");
      return false;
    }
    row.total = count;
    return true;
  }
  if (!row.records) {
    addNote(row, "no records");
    return false;
  }
  if (row.records > SAMPLE_LIMIT) addNote(row, `limit ignored: ${row.records} records for limit ${SAMPLE_LIMIT}`);
  return true;
}

async function readAxpol(run: Run, session: AxpolSession, read: AxpolRead, isRequired: boolean): Promise<void> {
  if (!AXPOL_READ_METHOD.test(read.method)) throw new Error(`${read.method} is not a read method`);
  if (!session.isExpired && Date.now() >= session.refreshAtMs) {
    const renewed = await loginOnce(run, session.base, session.profile, "renew", isRequired);
    if (renewed.session) Object.assign(session, renewed.session);
    else session.isExpired = true;
  }
  if (session.isExpired) {
    const host = new URL(session.base).host;
    report(run, { supplier: "axpol", host, step: read.method, isRequired, isOk: false, note: "skipped: JWT renewal failed" });
    return;
  }
  const url = new URL(session.base);
  url.searchParams.set("key", run.env.axpolApiKey);
  url.searchParams.set("uid", session.uid);
  url.searchParams.set("method", read.method);
  for (const [name, value] of Object.entries(read.params)) url.searchParams.set(`params[${name}]`, value);
  const { row, json } = await exchange(run, {
    supplier: "axpol", step: read.method, isRequired, url,
    options: {
      method: "GET", headers: { ...session.profile.readHeaders, Authorization: `Bearer ${session.jwt}` },
      timeoutMs: AXPOL_TIMEOUT_MS, maxBytes: AXPOL_MAX_BYTES,
    },
    prefix: `axpol/${url.host}/${read.method}`,
  });
  const outcome = axpolOutcome(row.status, json);
  noteOutcome(row, outcome, json);
  row.isOk = outcome === "ok" && checkRead(row, read, json);
  report(run, row);
}

export async function runAxpol(run: Run): Promise<void> {
  let primary: AxpolSession | undefined;
  for (const base of AXPOL_BASES) {
    const { outcome, session } = await loginAxpol(run, base);
    // The same account on the next base would be one more failed login: stop before a lockout
    if (outcome === "rejected") break;
    if (!session) continue;
    if (primary) {
      await readAxpol(run, session, PRODUCT_COUNT, false);
      continue;
    }
    primary = session;
    run.axpolBase = new URL(base).host;
    for (const read of AXPOL_READS) await readAxpol(run, primary, read, true);
    if (primary.isExpired) break;
  }
  if (!primary) {
    report(run, { supplier: "axpol", host: "-", step: "login", isRequired: true, isOk: false, note: "no base logged in" });
  }
}
