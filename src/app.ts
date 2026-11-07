import { STATUS_CODES } from "node:http";
import { relative, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { UsersService } from "./auth/admin.js";
import { registerAdminRoutes, registerLinkRoutes } from "./auth/admin-routes.js";
import {
  type AuthOptions, refuseCrossSite, registerSessionRoutes, registerSignInRoute, requireAdmin, requireUser,
} from "./auth/routes.js";
import { registerGradeRoutes } from "./grades/routes.js";
import type { GradesService } from "./grades/store.js";
import { registerOwnProductRoutes } from "./own-products/routes.js";
import type { SupplierPhotos } from "./photos/proxy.js";
import { ARCHIVE_PHOTO_PATH, registerPhotoRoutes } from "./photos/routes.js";
import type { OwnProductsService } from "./own-products/store.js";
import { registerSearchRoutes } from "./search/routes.js";
import type { SearchService } from "./search/search.js";
import type { SuppliersService } from "./suppliers/overview.js";
import { registerSupplierRoutes } from "./suppliers/overview-routes.js";

export interface AppOptions {
  logLevel?: string;
  // Folder with the built web app (dist/web); unset in development, where Vite serves the UI
  webRoot?: string;
  // Readiness: resolves when the database answers, otherwise /ready returns 503
  checkDatabase?: () => Promise<unknown>;
  // Signing in. Unset, the app has no API at all: search and ownProducts are served behind it, never without it
  auth?: AuthOptions;
  // The admin's users API (/api/admin) and the pages of its one-time links (/api/auth/invite, /api/auth/reset); unset,
  // or without auth, the app has none
  users?: UsersService;
  // The search API (/api/search); unset, the app has none
  search?: SearchService;
  // A user's searches per minute; unset, the search's own default
  searchRatePerMinute?: number;
  // The own products API (/api/own-products); unset, the app has none
  ownProducts?: OwnProductsService;
  // The grades of found models (/api/search/grades); unset, the app has none
  grades?: GradesService;
  // The «Постачальники» screen's overview (/api/suppliers), for every signed-in role; unset, the app has none
  suppliers?: SuppliersService;
  // Makito photos through the server (/api/photos/makito), which adds the token; unset, the app has none
  supplierPhotos?: SupplierPhotos;
  // Macma and Easy Gifts photos out of their ZIP archives (/api/photos/promotray); unset, the app has none
  archivePhotos?: SupplierPhotos;
}

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;
// The last status Fastify can send
const LAST_STATUS = 599;
const API_PATH = /^\/api(?:\/|$)/;
// A missing file (/assets/app.js) gets a 404, never the HTML page; so does a client route whose last part has a dot
const FILE_PATH = /\/[^/]+\.[a-z0-9]+$/i;
const IMMUTABLE = "public, max-age=31536000, immutable";

// Fastify sets statusCode on the errors it raises (bad JSON, failed schema check); anything else thrown, or a
// status above 599, is a 500
function statusOf(error: unknown): number {
  if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    && error.statusCode >= CLIENT_ERROR && error.statusCode <= LAST_STATUS) {
    return error.statusCode;
  }
  return SERVER_ERROR;
}

// Only Fastify's own errors (code FST_*) explain themselves to the client:
// an error from a library may carry a URL or part of a key in its message
function clientMessage(error: unknown, statusCode: number): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("FST_")) {
    return error.message;
  }
  return STATUS_CODES[statusCode] ?? "Error";
}

// Fastify's request line with the url cut before its query: a token or an email in ?key=value stays out of it.
// Fastify's own line also logs the accept-version header, which no route here reads.
export function requestLine(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url.split("?", 1)[0] ?? request.url,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

// A browser route of the web app: GET or HEAD outside /api, without a file extension (the query is left out)
function isPage(method: string, url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return (method === "GET" || method === "HEAD") && !API_PATH.test(path) && !FILE_PATH.test(path);
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  // Traefik reaches the app over the Docker network, so private addresses count as proxies and request.ip is the
  // last address before them. Another container on the shared proxy network could still set X-Forwarded-For:
  // never grant access by request.ip alone.
  const app = Fastify({
    logger: options.logLevel ? { level: options.logLevel, serializers: { req: requestLine } } : false,
    trustProxy: ["loopback", "linklocal", "uniquelocal"],
    // A field the schema does not know is refused, not dropped: a typo in a filter would search without it
    ajv: { customOptions: { removeAdditional: false } },
  });

  // 5xx: logged in full, answered without details (no stack or database message to the client)
  app.setErrorHandler((error, request, reply) => {
    const statusCode = statusOf(error);
    if (statusCode >= SERVER_ERROR) {
      request.log.error({ err: error }, "request failed");
      return reply.code(statusCode).send({ error: STATUS_CODES[statusCode] ?? "Internal Server Error" });
    }
    return reply.code(statusCode).send({ error: clientMessage(error, statusCode) });
  });

  app.get("/health", (_request, reply) => reply.send({ status: "ok" }));

  const { checkDatabase } = options;
  if (checkDatabase) {
    app.get("/ready", async (request, reply) => {
      try {
        await checkDatabase();
        return { status: "ok" };
      } catch (error) {
        request.log.error({ err: error }, "readiness check failed");
        return reply.code(503).send({ status: "unavailable" });
      }
    });
  }

  const { auth, users, search, ownProducts, grades, suppliers, supplierPhotos, archivePhotos } = options;
  if (auth) {
    app.decorateRequest("user", null);
    registerSignInRoute(app, auth);
    if (users) registerLinkRoutes(app, users);
    // A scope of its own: every route registered in it passes these hooks, whatever its URL looks like
    void app.register((signedIn, _options, done) => {
      signedIn.addHook("onRequest", refuseCrossSite);
      signedIn.addHook("onRequest", requireUser(auth.service));
      // Answers hold purchase prices: not for a browser's or a proxy's cache
      signedIn.addHook("onSend", (_request, reply, _payload, next) => {
        void reply.header("cache-control", "no-store");
        next();
      });
      registerSessionRoutes(signedIn, auth);
      if (search) registerSearchRoutes(signedIn, search, options.searchRatePerMinute);
      if (ownProducts) registerOwnProductRoutes(signedIn, ownProducts);
      if (grades) registerGradeRoutes(signedIn, grades);
      if (suppliers) registerSupplierRoutes(signedIn, suppliers);
      if (supplierPhotos) registerPhotoRoutes(signedIn, supplierPhotos);
      if (archivePhotos) registerPhotoRoutes(signedIn, archivePhotos, ARCHIVE_PHOTO_PATH, "macma");
      // A scope inside it: its hook runs after the session's, and every route there is the admin's alone
      if (users) {
        void signedIn.register((admin, _adminOptions, adminDone) => {
          admin.addHook("onRequest", requireAdmin);
          registerAdminRoutes(admin, users);
          adminDone();
        });
      }
      done();
    });
  }

  const { webRoot } = options;
  if (webRoot) {
    void app.register(fastifyStatic, {
      root: webRoot,
      // Hidden files (a .DS_Store copied from web/public, editor files) are never served
      dotfiles: "ignore",
      // Vite names files in assets/ by content hash, so they never change under the same name
      setHeaders: (reply, filePath) => {
        if (relative(webRoot, filePath).startsWith(`assets${sep}`)) reply.header("cache-control", IMMUTABLE);
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (webRoot && isPage(request.method, request.url)) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not Found" });
  });

  return app;
}
