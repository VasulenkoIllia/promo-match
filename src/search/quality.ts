// The quality test of stage 8 (README «Тест якості пошуку»): the client's real queries, each with the models a person
// named as right without looking at our search. A case hits when one of them is among the first TOP_K results; the same
// product and an acceptable analog are told apart, so there are two numbers. Pure: the cases file and the score. The
// reads, the search and the report are in scripts/quality-test.ts.
import { basename } from "node:path";
import { ConfigError } from "../config.js";
import { type CodeMatch, preferredMatches } from "./codes.js";
import { MAX_TEXT_CHARS } from "./request.js";

export const TOP_K = 10;

const REQUIRED_COLUMNS = ["id", "photo", "text", "same", "analogs"] as const;
type Column = (typeof REQUIRED_COLUMNS)[number];
const DELIMITERS = [",", ";", "\t"];
// No model code or SKU of the catalogues has a space, a comma or a semicolon (2026-10-30)
const CODE_SEPARATOR = /[\s,;]+/;
const PERCENT = 100;
const USD_DIGITS = 4;

export interface QualityCase {
  id: string;
  // A file in the photos folder beside the cases file
  photo?: string;
  text?: string;
  // Model codes or SKUs, as a person wrote them
  same: string[];
  analogs: string[];
}

export interface ReadCases {
  cases: QualityCase[];
  issues: string[];
}

// A spreadsheet in the wrong encoding (Excel's plain CSV is Windows-1251 here) would pass as garbled queries
export function decodeCases(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError("the cases file is not UTF-8: save it as CSV UTF-8");
  }
}

function delimiterOf(text: string): string {
  const [header = ""] = text.split("\n", 1);
  return DELIMITERS.find((delimiter) => header.includes(delimiter)) ?? ",";
}

// A spreadsheet's export: quoted cells, doubled quotes, line breaks in quotes, and the delimiter of its locale (Excel
// writes ";" here), told from the header line
export function parseCsv(text: string): string[][] {
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let isQuoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (isQuoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"' && (isQuoted || !cell)) {
      isQuoted = !isQuoted;
    } else if (isQuoted) {
      cell += char;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (isQuoted) throw new ConfigError("the cases file has a quote that is never closed");
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function codesOf(cell: string): string[] {
  return [...new Set(cell.split(CODE_SEPARATOR).filter(Boolean))];
}

function caseIssues({ id, photo, text, same, analogs }: QualityCase): string[] {
  const inBoth = same.filter((code) => analogs.some((analog) => analog.toLowerCase() === code.toLowerCase()));
  const issues = [
    !photo && !text ? "no photo and no text" : "",
    !same.length && !analogs.length ? "no right model" : "",
    photo && basename(photo) !== photo ? `the photo must be a file name, got "${photo}"` : "",
    text && text.length > MAX_TEXT_CHARS ? `the text is over ${MAX_TEXT_CHARS} characters` : "",
    inBoth.length ? `${inBoth.join(", ")} is both the same product and an analog` : "",
  ];
  return issues.filter(Boolean).map((issue) => `case ${id}: ${issue}`);
}

// Columns by name, in any order; others (a note) are left alone. A row counts from the header as row 1, as a
// spreadsheet shows it; a blank one is skipped.
export function readCases(rows: string[][]): ReadCases {
  const [header = [], ...body] = rows;
  const columns = header.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length) return { cases: [], issues: [`the header has no column ${missing.join(", ")}`] };
  const cellOf = (row: string[], name: Column) => (row[columns.indexOf(name)] ?? "").trim();
  const cases: QualityCase[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  body.forEach((row, index) => {
    if (row.every((cell) => !cell.trim())) return;
    const place = `row ${index + 2}`;
    const id = cellOf(row, "id");
    if (row.length > columns.length) issues.push(`${place}: more cells than columns (a delimiter in an unquoted text?)`);
    if (!id) {
      issues.push(`${place}: no id`);
      return;
    }
    if (seen.has(id)) issues.push(`${place}: the id ${id} is used twice`);
    seen.add(id);
    const kase: QualityCase = {
      id, photo: cellOf(row, "photo") || undefined, text: cellOf(row, "text") || undefined,
      same: codesOf(cellOf(row, "same")), analogs: codesOf(cellOf(row, "analogs")),
    };
    issues.push(...caseIssues(kase));
    cases.push(kase);
  });
  if (!cases.length && !issues.length) issues.push("the file has no cases");
  return { cases, issues };
}

// The model a code stands for, or why it stands for none
export function pickModel(code: string, matches: CodeMatch[]): number | string {
  const found = preferredMatches(matches);
  const labels = [...new Set(found.map((match) => match.label))];
  if (!labels.length) return `${code} is not in the catalogues`;
  if (labels.length > 1) return `${code} stands for ${labels.join(", ")}`;
  return (found[0] as CodeMatch).modelId;
}

export type QueryKind = "photo" | "text" | "both";
export const QUERY_KINDS: QueryKind[] = ["photo", "text", "both"];

export function queryKind({ photo, text }: Pick<QualityCase, "photo" | "text">): QueryKind {
  if (photo && text) return "both";
  return photo ? "photo" : "text";
}

// The models a case's codes stand for
export interface ExpectedModels {
  same: number[];
  analogs: number[];
}

// The rank of the best of the models among the results, in their order; null: none of them is there
export function firstRank(results: { rank: number; modelId: number }[], modelIds: number[]): number | null {
  const wanted = new Set(modelIds);
  return results.find((result) => wanted.has(result.modelId))?.rank ?? null;
}

interface RunOfCase {
  caseId: string;
  kind: QueryKind;
  // A case with analogs only says nothing about the same product: it counts in the second number alone
  hasSame: boolean;
}

export interface AnsweredRun extends RunOfCase {
  status: "answered";
  sameRank: number | null;
  anyRank: number | null;
  isComplete: boolean;
  // Why Claude did not read the text, so it was embedded as it is: the search went another way than it normally does,
  // and not always the same for each embedding model (a failed parse is tried again)
  textUnreadReason: string | null;
}

// The search gave no answer: this says nothing about the quality, so the run counts in no share
export interface FailedRun extends RunOfCase {
  status: "failed";
  error: string;
}

export type CaseRun = AnsweredRun | FailedRun;

export function answeredRun(kase: QualityCase, expected: ExpectedModels, results: { rank: number; modelId: number }[],
  flags: Pick<AnsweredRun, "isComplete" | "textUnreadReason">): AnsweredRun {
  return {
    status: "answered", caseId: kase.id, kind: queryKind(kase), hasSame: expected.same.length > 0,
    sameRank: firstRank(results, expected.same), anyRank: firstRank(results, [...expected.same, ...expected.analogs]),
    ...flags,
  };
}

export interface Share {
  hits: number;
  cases: number;
}

export interface Shares {
  same: Share;
  sameOrAnalog: Share;
}

export interface QualitySummary extends Shares {
  byKind: Record<QueryKind, Shares>;
  failed: number;
  incomplete: number;
  textUnread: number;
}

export function isHit(rank: number | null): boolean {
  return rank !== null && rank <= TOP_K;
}

function sharesOf(runs: AnsweredRun[]): Shares {
  const withSame = runs.filter((run) => run.hasSame);
  return {
    same: { hits: withSame.filter((run) => isHit(run.sameRank)).length, cases: withSame.length },
    sameOrAnalog: { hits: runs.filter((run) => isHit(run.anyRank)).length, cases: runs.length },
  };
}

export function summarize(runs: CaseRun[]): QualitySummary {
  const answered = runs.filter((run) => run.status === "answered");
  const byKind = Object.fromEntries(QUERY_KINDS.map((kind) =>
    [kind, sharesOf(answered.filter((run) => run.kind === kind))])) as Record<QueryKind, Shares>;
  return {
    ...sharesOf(answered), byKind, failed: runs.length - answered.length,
    incomplete: answered.filter((run) => !run.isComplete).length,
    textUnread: answered.filter((run) => run.textUnreadReason !== null).length,
  };
}

export function shareText({ hits, cases }: Share): string {
  return cases ? `${hits}/${cases} (${Math.round((hits / cases) * PERCENT)}%)` : "no cases";
}

// A right model the search cannot reach would pass for its miss
export function unreachableIssues(expected: Map<string, ExpectedModels>, isSearchable: (modelId: number) => boolean,
  labelOf: (modelId: number) => string): string[] {
  return [...expected].flatMap(([id, { same, analogs }]) => [...same, ...analogs]
    .filter((modelId) => !isSearchable(modelId))
    .map((modelId) => `case ${id}: ${labelOf(modelId)} is not in the search: inactive, or no vectors of a model`));
}

// A run's cost at list prices
export interface Estimate {
  embeddingUsd: Record<string, number>;
  parseUsd: number;
  texts: number;
}

export function usdText(usd: number): string {
  return `$${usd.toFixed(USD_DIGITS)}`;
}

// Past a limit a search stops halfway and a text goes without Claude: better refused before the first paid call
export function checkLimits({ embeddingUsd, parseUsd }: Estimate, searchLimitUsd: number, parseLimitUsd: number): void {
  const searchUsd = Object.values(embeddingUsd).reduce((sum, usd) => sum + usd, 0);
  if (searchUsd > searchLimitUsd) throw new ConfigError(`the run costs ${usdText(searchUsd)}, over SEARCH_BUDGET_USD`);
  if (parseUsd > parseLimitUsd) throw new ConfigError(`the run costs ${usdText(parseUsd)}, over QUERY_PARSE_BUDGET_USD`);
}
