import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { createUsersService } from "./auth/admin.js";
import { isLoopbackHostname } from "./auth/session.js";
import { createAuthService } from "./auth/store.js";
import { config } from "./config.js";
import { createPrisma } from "./db.js";
import { createGradesService } from "./grades/store.js";
import { createOwnProductsService } from "./own-products/store.js";
import { createArchivePhotos } from "./photos/archive.js";
import { createMakitoPhotos, type SupplierPhotos } from "./photos/proxy.js";
import { type QueryParser, queryParserFromEnv } from "./search/query-parse.js";
import { postgresReadings } from "./search/query-readings.js";
import { createSearchService, dailyBudgetFromEnv, QueryEmbedder, type SearchService } from "./search/search.js";
import { ArchiveReader } from "./suppliers/macma/archive.js";
import { createSuppliersService } from "./suppliers/overview.js";
import { MakitoSession } from "./suppliers/makito/api.js";

// Below stop_grace_period in docker-compose.yml, so the app exits on its own before Docker kills it
const SHUTDOWN_TIMEOUT_MS = 10_000;
const IDLE_SWEEP_MS = 500;

function searchService(prisma: ReturnType<typeof createPrisma>, parser: QueryParser): SearchService {
  return createSearchService(prisma, new QueryEmbedder(dailyBudgetFromEnv("SEARCH_BUDGET_USD")), parser);
}

// Makito gives its photos only with its token; without its keys the screen shows them as broken pictures
function makitoPhotos(): SupplierPhotos | undefined {
  const clientId = process.env.MAKITO_CLIENT_ID;
  const clientSecret = process.env.MAKITO_CLIENT_SECRET;
  return clientId && clientSecret ? createMakitoPhotos(new MakitoSession({ clientId, clientSecret }, [])) : undefined;
}

export async function startServer(): Promise<void> {
  // Production serves the built web app; in development Vite serves it and proxies the API here
  const webRoot = join(import.meta.dirname, "web");
  const hasWeb = existsSync(webRoot);
  if (!hasWeb && process.env.NODE_ENV === "production") {
    throw new Error(`${webRoot} is missing: the image was built without the web app (npm run build)`);
  }

  const prisma = createPrisma(config.databaseUrl, (error) => app.log.error({ err: error }, "database pool error"));
  const parser = queryParserFromEnv(dailyBudgetFromEnv("QUERY_PARSE_BUDGET_USD"), postgresReadings(prisma));
  const supplierPhotos = makitoPhotos();
  const app = buildApp({
    logLevel: config.logLevel,
    webRoot: hasWeb ? webRoot : undefined,
    checkDatabase: () => prisma.$queryRaw`SELECT 1`,
    auth: { service: createAuthService(prisma), isCookieSecure: !isLoopbackHostname(config.host) },
    users: createUsersService(prisma),
    search: searchService(prisma, parser),
    searchRatePerMinute: config.searchRatePerMinute,
    ownProducts: createOwnProductsService(prisma),
    grades: createGradesService(prisma),
    suppliers: createSuppliersService(prisma),
    supplierPhotos,
    archivePhotos: createArchivePhotos(new ArchiveReader()),
  });
  if (!supplierPhotos) app.log.warn("Makito photos off: MAKITO_CLIENT_ID or MAKITO_CLIENT_SECRET is not set");
  if (!parser.isConfigured) {
    app.log.warn("query parse off: ANTHROPIC_API_KEY is not set, the search embeds a text not read before as it is");
  }
  app.addHook("onClose", () => prisma.$disconnect());

  async function shutdown(signal: string): Promise<void> {
    app.log.info({ signal }, "shutting down");
    setTimeout(() => {
      app.log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    // A keep-alive connection that goes idle during close would hold it open until its timeout
    const sweep = setInterval(() => app.server.closeIdleConnections(), IDLE_SWEEP_MS);
    await app.close();
    clearInterval(sweep);
    process.exit(0);
  }

  // process.on with a flag, not once: Ctrl+C in npm run dev also brings the signal that npm and Node's watch mode
  // pass on, which would kill the app halfway through closing
  let isShuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      shutdown(signal).catch((error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      });
    });
  }

  await app.listen({ host: config.host, port: config.port });
}
