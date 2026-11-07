import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import { isMidoceanFileLink, type MidoceanFeed, midoceanUrl } from "../../src/suppliers/midocean/api.js";
import { isRecord } from "../../src/suppliers/normalize.js";
import { addNote, BYTES_PER_MB, exchange, HTTP_OK, report, type Run, type StepResult } from "./run.js";

// Midocean REST API (docs/integrations.md): the five feeds the project reads, API key in a header
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
// Each feed is a full dump of tens of MB without pagination
const MIDOCEAN_TIMEOUT_MS = 180_000;
const MIDOCEAN_MAX_BYTES = 200 * BYTES_PER_MB;

const MIDOCEAN_READS: MidoceanFeed[] = [
  { name: "products", path: "products/2.0", query: { language: "en" } },
  { name: "stock", path: "stock/2.0", query: {} },
  { name: "pricelist", path: "pricelist/2.0/", query: {} },
  { name: "printdata", path: "printdata/1.0", query: {} },
  { name: "printpricelist", path: "printpricelist/2.0/", query: {} },
];

export function midoceanPlan(): string[] {
  const lines = [
    `Midocean, header x-Gateway-APIKey, Accept: application/json, timeout ${MIDOCEAN_TIMEOUT_MS / MS_PER_SECOND} s,`
      + ` body up to ${MIDOCEAN_MAX_BYTES / BYTES_PER_MB} MB:`,
  ];
  for (const read of MIDOCEAN_READS) lines.push(`  GET ${midoceanUrl(read).href}`);
  lines.push("  a redirect to a presigned file in a midocean-* bucket on S3 is followed once: GET without the API key");
  return lines;
}

// A feed counts as read when it brings records: a non-empty root array or an object with a non-empty array.
// Returns why it does not.
function feedProblem(row: StepResult, json: unknown): string | undefined {
  if (row.status !== HTTP_OK) return `not ${HTTP_OK}`;
  if (json === undefined) return "not JSON";
  if (row.records === 0) return "no records";
  if (row.records !== undefined) return undefined;
  const hasRecords = isRecord(json) && Object.values(json).some((value) => Array.isArray(value) && value.length > 0);
  if (!hasRecords) return "no array of records";
  addNote(row, "several arrays, records not counted (see shape.json)");
  return undefined;
}

export function judgeFeed(row: StepResult, json: unknown): void {
  // Without a status the request itself failed and its note says why
  const problem = row.status === undefined ? undefined : feedProblem(row, json);
  if (problem) addNote(row, problem);
  row.isOk = row.status !== undefined && problem === undefined;
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && status >= REDIRECT_MIN && status <= REDIRECT_MAX;
}

// The gateway step of products and stock counts when its link points to a Midocean file on S3: https, no port, no
// user in the URL
function judgeLink(row: StepResult, link: URL | undefined): void {
  let problem: string | undefined;
  if (!link) problem = "redirect without Location";
  else if (!isMidoceanFileLink(link)) {
    problem = "redirect not to a Midocean file on S3, not followed";
  }
  if (problem) addNote(row, problem);
  row.isOk = problem === undefined;
}

// The file behind the gateway's link, fetched without the API key, which S3 does not need and must not see
async function fetchFile(run: Run, read: MidoceanFeed, link: URL): Promise<void> {
  const { row, json } = await exchange(run, {
    supplier: "midocean", step: `${read.name} file`, isRequired: true, url: link,
    options: {
      method: "GET", headers: { Accept: "application/json" }, timeoutMs: MIDOCEAN_TIMEOUT_MS, maxBytes: MIDOCEAN_MAX_BYTES,
    },
    prefix: `midocean/${read.name}.file`,
  });
  judgeFeed(row, json);
  report(run, row);
}

export async function runMidocean(run: Run): Promise<void> {
  for (const read of MIDOCEAN_READS) {
    const { row, json, redirectUrl } = await exchange(run, {
      supplier: "midocean", step: read.name, isRequired: true, url: midoceanUrl(read),
      options: {
        method: "GET", headers: { "x-Gateway-APIKey": run.env.midoceanApiKey, Accept: "application/json" },
        timeoutMs: MIDOCEAN_TIMEOUT_MS, maxBytes: MIDOCEAN_MAX_BYTES,
      },
      prefix: `midocean/${read.name}`,
    });
    const isLink = isRedirect(row.status);
    if (isLink) judgeLink(row, redirectUrl);
    else judgeFeed(row, json);
    report(run, row);
    if (isLink && row.isOk && redirectUrl) await fetchFile(run, read, redirectUrl);
  }
}
