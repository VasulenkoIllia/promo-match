// The overview of the «Постачальники» screen (src/suppliers/overview-routes.ts, docs/integrations.md, «Постачальники»).
// The shapes are copied from src/suppliers/overview.ts rather than imported.
import { call } from "./api";

const SUPPLIERS_TIMEOUT_MS = 30_000;

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunSummary {
  status: RunStatus;
  // ISO times
  startedAt: string;
  finishedAt: string | null;
}

export interface ImportSummary extends RunSummary {
  models: { created: number; changed: number; missing: number; reactivated: number } | null;
}

export interface PhotoTotals {
  inScope: number;
  ready: number;
  failed: number;
  pending: number;
}

export interface TextTotals {
  models: number;
  ready: number;
  stale: number;
  missing: number;
  withoutText: number;
}

export interface SupplierStatus {
  code: string;
  name: string;
  catalog: { models: number; variants: number; photos: number };
  lastImport: ImportSummary | null;
  lastSucceededAt: string | null;
  stock: { variants: number };
  vectors: { photos: PhotoTotals; texts: TextTotals; lastRun: RunSummary | null };
  categories: { paths: number; pathsWithout: number; modelsWithout: number };
}

export interface SuppliersOverview {
  model: string;
  suppliers: SupplierStatus[];
}

export function fetchSuppliers(signal: AbortSignal): Promise<SuppliersOverview> {
  return call<SuppliersOverview>("/api/suppliers", {}, SUPPLIERS_TIMEOUT_MS, ["suppliers"], signal);
}
