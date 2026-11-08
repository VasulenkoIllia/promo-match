// Smoke test of the supplier APIs (stage 1 in docs/requirements.md): log in, read a little of every feed the project
// uses and keep the shape and the first records of each response in output/ (outside git: purchase prices).
// Read only: Axpol Order.Add, Address.* and Api.*, Midocean order/* and proof/*, the order and offer methods of
// Makito, Inspirion and Blue Collection are never called.
// pnpm run smoke:suppliers --dry-run prints the plan without network; without the flag the plan runs.
// --only <supplier> runs one supplier and needs only its variables.
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { axpolPlan, runAxpol } from "./smoke/axpol.js";
import { bluecollectionPlan, runBluecollection } from "./smoke/bluecollection.js";
import { inspirionPlan, runInspirion } from "./smoke/inspirion.js";
import { makitoPlan, runMakito } from "./smoke/makito.js";
import { MAX_ATTEMPTS, MAX_RETRY_WAIT_MS, MS_PER_SECOND } from "../src/suppliers/http.js";
import { midoceanPlan, runMidocean } from "./smoke/midocean.js";
import { type Env, type Run, SAMPLE_LIMIT, writeJson } from "./smoke/run.js";
import { scrub } from "../src/suppliers/secrets.js";

// A mistake in the command or .env: its message is enough, a stack trace would only bury it
class ConfigError extends Error {}

// Same rule as src/config.ts, which is not imported: it also requires DATABASE_URL, which this script never uses
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not set (see .env.example)`);
  return value;
}

// Each supplier's variables by the Env field they fill
const SUPPLIERS = {
  axpol: {
    plan: axpolPlan, run: runAxpol,
    env: { axpolLogin: "AXPOL_LOGIN", axpolPassword: "AXPOL_PASSWORD", axpolApiKey: "AXPOL_API_KEY" },
  },
  midocean: { plan: midoceanPlan, run: runMidocean, env: { midoceanApiKey: "MIDOCEAN_API_KEY" } },
  makito: {
    plan: makitoPlan, run: runMakito,
    env: { makitoClientId: "MAKITO_CLIENT_ID", makitoClientSecret: "MAKITO_CLIENT_SECRET" },
  },
  inspirion: { plan: inspirionPlan, run: runInspirion, env: { inspirionApiKey: "INSPIRION_API_KEY" } },
  bluecollection: {
    plan: bluecollectionPlan, run: runBluecollection,
    env: { bluecollectionUsername: "BLUECOLLECTION_USERNAME", bluecollectionPassword: "BLUECOLLECTION_PASSWORD" },
  },
} as const satisfies Record<
  string, { plan: () => string[]; run: (run: Run) => Promise<void>; env: Partial<Record<keyof Env, string>> }
>;
type Supplier = keyof typeof SUPPLIERS;
const SUPPLIER_NAMES = Object.keys(SUPPLIERS) as Supplier[];

function envEntries(suppliers: Supplier[]): [keyof Env, string][] {
  return suppliers.flatMap((supplier) => Object.entries(SUPPLIERS[supplier].env) as [keyof Env, string][]);
}

// Only the suppliers of this run need their variables; the others stay empty
function readEnv(suppliers: Supplier[]): Env {
  const env = Object.fromEntries(envEntries(SUPPLIER_NAMES).map(([field]) => [field, ""])) as Env;
  for (const [field, name] of envEntries(suppliers)) env[field] = required(name);
  return env;
}

// --only runs some suppliers (comma-separated): a repeat of one part without new logins at the others
function selectSuppliers(only: string | undefined): Supplier[] {
  if (only === undefined) return SUPPLIER_NAMES;
  const suppliers = only.split(",").map((part) => {
    const supplier = SUPPLIER_NAMES.find((name) => name === part.trim());
    if (!supplier) throw new ConfigError(`--only takes ${SUPPLIER_NAMES.join(", ")}, comma-separated; got "${part}"`);
    return supplier;
  });
  return [...new Set(suppliers)];
}

function isConfigError(error: unknown): boolean {
  // parseArgs marks its own errors (unknown option, missing value) with ERR_PARSE_ARGS_* codes
  const isArgsError = error instanceof Error && "code" in error && typeof error.code === "string"
    && error.code.startsWith("ERR_PARSE_ARGS");
  return error instanceof ConfigError || isArgsError;
}

function plan(suppliers: Supplier[]): string[] {
  return [
    `Plan: read only; ${MAX_ATTEMPTS - 1} retry on a network error, a timeout, 429 or 5xx (Retry-After up to`
      + ` ${MAX_RETRY_WAIT_MS / MS_PER_SECOND} s); redirects are not followed unless said below.`,
    "",
    ...envEntries(suppliers).map(([, name]) => `  ${name}: ${process.env[name] ? "set" : "missing"}`),
    ...suppliers.flatMap((supplier) => ["", ...SUPPLIERS[supplier].plan()]),
    "",
    `Output: output/smoke-test/<run>/: headers, shape and the first ${SAMPLE_LIMIT} records of each response;`
      + " Makito, Inspirion and Blue Collection also keep each answer as it came (*.raw.json, up to about 100 MB each)"
      + " and the probed picture.",
  ];
}

// Written after a crash too, so the steps done so far are not lost
async function writeSummary(run: Run, startedAt: string): Promise<void> {
  const { jwtTtlSeconds, axpolBase, results } = run;
  const summary = { startedAt, finishedAt: new Date().toISOString(), jwtTtlSeconds, axpolBase, results };
  try {
    await writeJson(run, "summary.json", summary);
  } catch (error) {
    console.error(scrub(`summary.json not saved: ${error instanceof Error ? error.message : String(error)}`, run.secrets));
    process.exitCode = 1;
  }
}

// secrets is shared with the caller, so an error message is scrubbed of the JWT as well
async function main(secrets: string[]): Promise<void> {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false }, only: { type: "string" } },
    strict: true,
  });
  const suppliers = selectSuppliers(values.only);
  for (const line of plan(suppliers)) console.log(line);
  if (values["dry-run"]) {
    console.log("\nDry run: no request sent.");
    return;
  }
  const env = readEnv(suppliers);
  secrets.push(...Object.values(env).filter(Boolean));
  const startedAt = new Date().toISOString();
  const dir = join(import.meta.dirname, "..", "output", "smoke-test", startedAt.replace(/[:.]/g, "-"));
  const run: Run = { env, dir, results: [], secrets };
  console.log("");
  try {
    for (const supplier of suppliers) await SUPPLIERS[supplier].run(run);
  } finally {
    await writeSummary(run, startedAt);
  }
  const failed = run.results.filter((row) => row.isRequired && !row.isOk).length;
  const warned = run.results.filter((row) => !row.isRequired && !row.isOk).length;
  const axpolBase = suppliers.includes("axpol") ? ` Axpol read on: ${run.axpolBase ?? "none"}.` : "";
  console.log(`\n${failed} required step(s) failed, ${warned} warning(s).${axpolBase}`
    + ` Output: ${relative(process.cwd(), dir)}`);
  if (failed) process.exitCode = 1;
}

const secrets: string[] = [];
try {
  await main(secrets);
} catch (error) {
  const text = error instanceof Error ? (isConfigError(error) ? error.message : (error.stack ?? error.message)) : String(error);
  console.error(scrub(text, secrets));
  process.exitCode = 1;
}
