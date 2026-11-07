import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const CONNECT_TIMEOUT_MS = 5_000;

// A driver error may quote the connection string: jobs scrub this password from what they print
export function databasePassword(databaseUrl: string): string {
  return URL.canParse(databaseUrl) ? decodeURIComponent(new URL(databaseUrl).password) : "";
}

// onError gets errors of idle pooled connections (database restart, dropped network);
// without it they would crash the process or go unseen
export function createPrisma(databaseUrl: string, onError: (error: Error) => void): PrismaClient {
  const adapter = new PrismaPg(
    { connectionString: databaseUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS },
    { onPoolError: onError, onConnectionError: onError },
  );
  return new PrismaClient({ adapter });
}
