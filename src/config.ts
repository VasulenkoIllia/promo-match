// Settings from the environment, read once at start: a missing or broken value stops the start with its name.
// Empty values count as missing (`||`): a key left empty in .env falls back to its default, never to "".
// A mistake in the environment or the command: its message is enough, a stack trace would only bury it
export class ConfigError extends Error {}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not set (see .env.example)`);
  return value;
}

const MAX_PORT = 65_535;

function port(): number {
  const value = Number(process.env.PORT || "3000");
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PORT) {
    throw new Error(`PORT must be an integer from 1 to ${MAX_PORT}, got "${String(process.env.PORT)}"`);
  }
  return value;
}

// Empty means the setting's own default
function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export const config = {
  // Local development listens on this machine only; the Docker image sets HOST=0.0.0.0
  host: process.env.HOST || "127.0.0.1",
  port: port(),
  logLevel: process.env.LOG_LEVEL || "info",
  databaseUrl: required("DATABASE_URL"),
  // Set: the process runs this job instead of the HTTP app (src/worker.ts)
  worker: process.env.WORKER || undefined,
  // The database Compose creates; with it set, the import refuses a DATABASE_URL that points at another one
  postgresDb: process.env.POSTGRES_DB || undefined,
  // A user's paid searches per minute (src/search/routes.ts)
  searchRatePerMinute: optionalPositiveInteger("SEARCH_RATE_PER_MINUTE"),
};
