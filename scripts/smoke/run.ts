import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { HttpError, request, type HttpResult, type RequestOptions } from "../../src/suppliers/http.js";
import { linkSecrets, scrub } from "../../src/suppliers/secrets.js";
import { countRecords, describeShape, sampleOf, secretValues } from "./shape.js";

// What every supplier step shares: the request with its saved response, the result row and its console line
export const SAMPLE_LIMIT = 5;
export const BYTES_PER_MB = 1_048_576;
export const HTTP_OK = 200;
const TEXT_SAMPLE_CHARS = 4_096;
// A probed picture is known by its first bytes, not by Content-Type: Makito sends its JPEGs as
// application/octet-stream, and a header must never name a file
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_OFFSET = 8;

export function imageExtension(body: Buffer): "jpg" | "png" | "webp" | undefined {
  if (body.subarray(0, JPEG_START.length).equals(JPEG_START)) return "jpg";
  if (body.subarray(0, PNG_START.length).equals(PNG_START)) return "png";
  const isWebp = body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", WEBP_OFFSET, WEBP_OFFSET + 4) === "WEBP";
  return isWebp ? "webp" : undefined;
}
const BOM = "﻿";
// Owner only: the samples hold purchase prices
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// A record type, not an interface: Object.values(env) then lists every secret as a string. A supplier left out of the
// run has its values empty.
export type Env = Record<
  "axpolLogin" | "axpolPassword" | "axpolApiKey" | "midoceanApiKey" | "makitoClientId" | "makitoClientSecret"
  | "inspirionApiKey" | "bluecollectionUsername" | "bluecollectionPassword",
  string
>;

export type SmokeSupplier = "axpol" | "midocean" | "makito" | "inspirion" | "bluecollection";

export interface StepResult {
  supplier: SmokeSupplier;
  host: string;
  step: string;
  // A failed required step fails the run; the others (a second Axpol base, a login retried with browser headers)
  // are findings
  isRequired: boolean;
  isOk: boolean;
  status?: number;
  // Records in the response, and the number a *.Count method reports
  records?: number;
  total?: number;
  bytes?: number;
  durationMs?: number;
  attempts?: number;
  note?: string;
  files?: string[];
  // A step whose response was not saved has not done its job
  filesError?: string;
}

export interface Run {
  env: Env;
  dir: string;
  // Grows by the JWT after each login
  secrets: string[];
  results: StepResult[];
  jwtTtlSeconds?: number;
  // Host of the Axpol base the required reads ran on
  axpolBase?: string;
}

export function addNote(row: StepResult, text: string): void {
  row.note = row.note ? `${row.note}; ${text}` : text;
}

// A name made of supplier data must not lead out of the run folder
async function fileInRun(run: Run, name: string): Promise<string> {
  const file = join(run.dir, name);
  const inside = relative(run.dir, file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`output name outside the run folder: ${name}`);
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  return file;
}

async function writeOutput(run: Run, name: string, text: string): Promise<string> {
  await writeFile(await fileInRun(run, name), scrub(text, run.secrets), { mode: FILE_MODE });
  return name;
}

export function writeJson(run: Run, name: string, value: unknown): Promise<string> {
  return writeOutput(run, name, `${JSON.stringify(value, null, 2)}\n`);
}

// A picture as it came: no secrets in it, and scrubbing text would break it
async function writeBinary(run: Run, name: string, body: Buffer): Promise<string> {
  await writeFile(await fileInRun(run, name), body, { mode: FILE_MODE });
  return name;
}

// Not JSON (an HTML error page, XML) is a finding, not a crash: the caller saves the start of the body as text
function parseJson(body: Buffer): unknown {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

// Listed field by field: redirectUrl carries the full query and stays out of the file
function metaOf(result: HttpResult) {
  const { status, headers, omittedHeaders, location, durationMs, attempts, retries, body } = result;
  return { status, headers, omittedHeaders, location, bytes: body.length, durationMs, attempts, retries };
}

async function saveResponse(run: Run, call: Exchange, result: HttpResult, json: unknown): Promise<string[]> {
  const { prefix } = call;
  const files = [await writeJson(run, `${prefix}.meta.json`, metaOf(result))];
  // The whole feed, for counting models, colours and photos later without reading the supplier again
  if (call.saveRaw) {
    files.push(await writeOutput(run, `${prefix}.raw.${json === undefined ? "txt" : "json"}`, result.body.toString("utf8")));
  }
  if (json === undefined) {
    const text = scrub(result.body.toString("utf8"), run.secrets).slice(0, TEXT_SAMPLE_CHARS);
    files.push(await writeOutput(run, `${prefix}.body.txt`, text));
  } else {
    files.push(await writeJson(run, `${prefix}.shape.json`, describeShape(json, run.secrets)));
    files.push(await writeJson(run, `${prefix}.sample.json`, sampleOf(json, SAMPLE_LIMIT, run.secrets)));
  }
  return files;
}

async function saveFiles(row: StepResult, write: () => Promise<string[]>): Promise<void> {
  try {
    row.files = await write();
  } catch (error) {
    row.filesError = error instanceof Error ? error.message : String(error);
  }
}

export interface Exchange {
  supplier: StepResult["supplier"];
  step: string;
  isRequired: boolean;
  url: URL;
  options: RequestOptions;
  // Path of the saved files inside the run folder
  prefix: string;
  saveRaw?: boolean;
}

export interface Exchanged {
  row: StepResult;
  json: unknown;
  // The full redirect target for a caller that follows it on purpose
  redirectUrl?: URL;
}

// One request with its result row and saved files; the caller decides whether the answer counts as success
export async function exchange(run: Run, call: Exchange): Promise<Exchanged> {
  const row: StepResult = {
    supplier: call.supplier, host: call.url.host, step: call.step, isRequired: call.isRequired, isOk: false,
  };
  let result: HttpResult;
  try {
    result = await request(call.url, call.options);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const { attempts, retries, response } = error;
    row.attempts = attempts;
    addNote(row, retries.length ? `${error.message} (after ${retries.join(", ")})` : error.message);
    // The status of an answer that could not be read goes to the note, not to row.status: the step failed as a
    // request, not as an answer to judge (a login cut off by a timeout is not a refused one)
    if (response) {
      addNote(row, `HTTP ${response.status} before the failure`);
      await saveFiles(row, async () => [await writeJson(run, `${call.prefix}.meta.json`, { ...response, attempts, retries })]);
    }
    return { row, json: undefined };
  }
  const json = parseJson(result.body);
  run.secrets.push(...secretValues(json));
  if (result.redirectUrl) run.secrets.push(...linkSecrets(result.redirectUrl));
  row.status = result.status;
  row.bytes = result.body.length;
  row.durationMs = result.durationMs;
  row.attempts = result.attempts;
  row.records = countRecords(json);
  if (result.location) addNote(row, `redirect to ${result.location}`);
  if (result.retries.length) addNote(row, `retried after ${result.retries.join(", ")}`);
  await saveFiles(row, () => saveResponse(run, call, result, json));
  return { row, json, redirectUrl: result.redirectUrl };
}

// One picture of a feed: does it open with the given headers (none for a public CDN), its type and size, and the
// file itself for its pixel size (sips). A finding, never a failure of the run.
export async function probePhoto(run: Run, call: Omit<Exchange, "isRequired" | "saveRaw">): Promise<StepResult> {
  const row: StepResult = {
    supplier: call.supplier, host: call.url.host, step: call.step, isRequired: false, isOk: false,
  };
  try {
    const result = await request(call.url, call.options);
    row.status = result.status;
    row.bytes = result.body.length;
    row.durationMs = result.durationMs;
    const type = (result.headers["content-type"] ?? "no content-type").replace(/[^\x20-\x7e]/g, "?");
    const extension = imageExtension(result.body);
    const isImage = result.status === HTTP_OK && extension !== undefined;
    addNote(row, `${type}${isImage ? `, ${extension} by its bytes` : ""}`);
    await saveFiles(row, async () => [
      await writeJson(run, `${call.prefix}.meta.json`, metaOf(result)),
      ...(isImage ? [await writeBinary(run, `${call.prefix}.${extension}`, result.body)] : []),
    ]);
    row.isOk = isImage;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    addNote(row, error.response ? `${error.message}, HTTP ${error.response.status}` : error.message);
  }
  report(run, row);
  return row;
}

// Adds the row to the run and prints its line
export function report(run: Run, row: StepResult): void {
  if (row.filesError) {
    row.isOk = false;
    addNote(row, `files not saved: ${row.filesError}`);
  }
  run.results.push(row);
  const label = row.isOk ? "ok  " : row.isRequired ? "FAIL" : "warn";
  const parts = [label, row.supplier, row.host, row.step];
  if (row.status !== undefined) parts.push(`HTTP ${row.status}`);
  if (row.total !== undefined) parts.push(`count ${row.total}`);
  if (row.records !== undefined) parts.push(`${row.records} records`);
  if (row.bytes !== undefined) parts.push(`${(row.bytes / BYTES_PER_MB).toFixed(2)} MB`);
  if (row.durationMs !== undefined) parts.push(`${row.durationMs} ms`);
  if (row.attempts !== undefined && row.attempts > 1) parts.push(`${row.attempts} attempts`);
  if (row.note) parts.push(`- ${row.note}`);
  console.log(scrub(parts.join("  "), run.secrets));
}
