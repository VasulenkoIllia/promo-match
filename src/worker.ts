// One-off jobs of the same image, picked by WORKER (src/main.ts). WORKER=import runs the catalogue import:
//   npm run import:catalog -- [--dry-run] [--only axpol|midocean|inspirion|bluecollection|makito|macma|easygifts] [--probe] [--allow-mass-deactivation]
// --dry-run reads the suppliers and the database and writes nothing; --probe only sends the small reads that find
// the APIs' limits. Supplier APIs are read only. Macma and Easy Gifts are read with --only alone.
// WORKER=embed makes the vectors of photos and texts (docs/integrations.md, «Ембедінги каталогу»):
//   npm run embed:catalog -- [--dry-run] [--only axpol|midocean|inspirion|bluecollection|makito|macma|easygifts] [--limit <n>] [--retry-failed]
// --dry-run prints counts and the cost at list prices and calls no provider; --limit caps photos and texts per source.
// WORKER=categories writes the shared category list and the sources' mappings from git to the database
// (docs/integrations.md, «Спільні категорії»): npm run categories:sync -- [--dry-run] [--allow-mass-removal]
// WORKER=users manages the users (src/auth/users.ts): npm run users -- add <login> [--role admin]
import { parseArgs } from "node:util";
import { runUsers } from "./auth/users.js";
import { config, ConfigError } from "./config.js";
import { createPrisma, databasePassword } from "./db.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { runCategorySync } from "./categories/sync.js";
import { Budget } from "./embeddings/batch.js";
import { budgetFromEnv, PROVIDER_CODES, providerCodeFromEnv, providerFromEnv } from "./embeddings/provider.js";
import { runEmbeddings } from "./embeddings/run.js";
import { ImportStopped } from "./import/errors.js";
import { runImport } from "./import/run.js";
import { adapterFor, DEFAULT_IMPORT_CODES, isSupplierCode, SUPPLIER_CODES } from "./suppliers/registry.js";
import { scrub } from "./suppliers/secrets.js";
import type { FetchContext } from "./suppliers/types.js";

// After a stop signal the job finishes its statement and exits; this long at most
const FORCED_EXIT_MS = 30_000;

function parseOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      only: { type: "string" },
      probe: { type: "boolean", default: false },
      "allow-mass-deactivation": { type: "boolean", default: false },
    },
    strict: true,
  });
  const { only } = values;
  if (only !== undefined && !isSupplierCode(only)) {
    throw new ConfigError(`--only must be one of ${SUPPLIER_CODES.join(", ")}, got "${only}"`);
  }
  return { ...values, codes: only === undefined ? [...DEFAULT_IMPORT_CODES] : [only] };
}

// The first SIGTERM or Ctrl+C stops the job between requests and batches; a second one, or a stop that takes too
// long, exits at once
function stopOnSignal(controller: AbortController, log: (line: string) => void): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (controller.signal.aborted) process.exit(1);
      log(`${signal}: stopping`);
      controller.abort(new ImportStopped(`stopped by ${signal}`));
      setTimeout(() => process.exit(1), FORCED_EXIT_MS).unref();
    });
  }
}

function isConfigError(error: unknown): boolean {
  // parseArgs marks its own errors (unknown option, missing value) with ERR_PARSE_ARGS_* codes
  const isArgsError = error instanceof Error && "code" in error && typeof error.code === "string"
    && error.code.startsWith("ERR_PARSE_ARGS");
  return error instanceof ConfigError || error instanceof ImportStopped || isArgsError;
}

function parseEmbedOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      only: { type: "string" },
      limit: { type: "string" },
      "retry-failed": { type: "boolean", default: false },
    },
    strict: true,
  });
  const { only, limit } = values;
  if (only !== undefined && !isSupplierCode(only)) {
    throw new ConfigError(`--only must be one of ${SUPPLIER_CODES.join(", ")}, got "${only}"`);
  }
  const limitCount = limit === undefined ? undefined : Number(limit);
  if (limitCount !== undefined && (!Number.isInteger(limitCount) || limitCount <= 0)) {
    throw new ConfigError(`--limit must be a positive integer, got "${limit}"`);
  }
  return { ...values, limit: limitCount, codes: only === undefined ? [...SUPPLIER_CODES] : [only] };
}

// A driver error may quote the connection string, so its password joins the secrets
function openDatabase(context: FetchContext): PrismaClient {
  const password = databasePassword(config.databaseUrl);
  if (password) context.secrets.push(password);
  return createPrisma(config.databaseUrl, (error) => context.log(`database pool error: ${error.message}`));
}

// A run needs EMBED_PROVIDER, its key and EMBED_BUDGET_USD; a dry run needs none and prices every provider when
// EMBED_PROVIDER is not set
async function runEmbedJob(argv: string[], context: FetchContext): Promise<number> {
  const options = parseEmbedOptions(argv);
  const isDryRun = options["dry-run"];
  const code = providerCodeFromEnv();
  if (!isDryRun && !code) throw new ConfigError("EMBED_PROVIDER is not set (see .env.example)");
  const providers = (code ? [code] : [...PROVIDER_CODES]).map((each) => {
    const { provider, apiKey } = providerFromEnv(each, isDryRun);
    if (apiKey) context.secrets.push(apiKey);
    return provider;
  });
  const budget = isDryRun ? undefined : new Budget(budgetFromEnv());
  const db = openDatabase(context);
  try {
    const isOk = await runEmbeddings(db, {
      codes: options.codes, isDryRun, limit: options.limit, isRetryFailed: options["retry-failed"], providers, budget,
      context,
    });
    return isOk ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

async function runImportJob(argv: string[], context: FetchContext): Promise<number> {
  const options = parseOptions(argv);
  const adapters = options.codes.map(adapterFor);
  if (options.probe) {
    for (const adapter of adapters) await adapter.probe(context);
    return 0;
  }
  const db = openDatabase(context);
  try {
    const isOk = await runImport(db, {
      adapters, isDryRun: options["dry-run"], allowMassDeactivation: options["allow-mass-deactivation"], context,
    });
    return isOk ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

async function runCategoriesJob(argv: string[], context: FetchContext): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "allow-mass-removal": { type: "boolean", default: false },
    },
    strict: true,
  });
  const db = openDatabase(context);
  try {
    await runCategorySync(db, {
      isDryRun: values["dry-run"], allowMassRemoval: values["allow-mass-removal"], signal: context.signal, log: context.log,
    });
    return 0;
  } finally {
    await db.$disconnect();
  }
}

async function runUsersJob(argv: string[], context: FetchContext): Promise<number> {
  const db = openDatabase(context);
  try {
    await runUsers(db, argv, context.log);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

const JOBS: Record<string, (argv: string[], context: FetchContext) => Promise<number>> = {
  import: runImportJob, embed: runEmbedJob, categories: runCategoriesJob, users: runUsersJob,
};

export async function runWorker(name: string, argv: string[]): Promise<number> {
  const secrets: string[] = [];
  const log = (line: string) => console.log(scrub(line, secrets));
  const controller = new AbortController();
  stopOnSignal(controller, log);
  try {
    // Own keys only: an inherited name such as "constructor" is no job
    const job = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined;
    if (!job) throw new ConfigError(`WORKER must be one of ${Object.keys(JOBS).join(", ")}, got "${name}"`);
    const context = { signal: controller.signal, log, secrets };
    return await job(argv, context);
  } catch (error) {
    const text = error instanceof Error ? (isConfigError(error) ? error.message : error.stack ?? error.message) : String(error);
    console.error(scrub(text, secrets));
    return 1;
  }
}
