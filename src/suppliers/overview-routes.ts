// The «Постачальники» screen's API (docs/integrations.md, «Постачальники»).
//   GET /api/suppliers   per supplier: catalogue, last import, stock, vectors of the default model, shared categories
// Behind the login, registered in the signed-in scope of src/app.ts: an admin and a manager both see it (decision
// 2026-11-07). Counts and dates only: a failed run's error text stays in sync_run and the worker's log.
import type { FastifyInstance } from "fastify";
import type { SuppliersService } from "./overview.js";

export function registerSupplierRoutes(app: FastifyInstance, service: SuppliersService): void {
  app.get("/api/suppliers", () => service.overview());
}
