import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import type { TextPlan } from "../embeddings/texts.js";
import { modelChanges, type OverviewRows, supplierOverview, type SuppliersOverview, textTotals } from "./overview.js";

const STARTED = new Date("2026-11-06T18:05:10.000Z");
const FINISHED = new Date("2026-11-06T18:05:19.000Z");
const EARLIER = new Date("2026-11-05T09:00:00.000Z");

function textPlan(overrides: Partial<TextPlan> = {}): TextPlan {
  return { total: 0, created: [], changed: [], unchanged: 0, withoutText: [], ...overrides };
}

function text(modelId: number) {
  return { modelId, code: `M${modelId}`, input: { title: null, text: "pen" }, hash: "h" };
}

function rows(overrides: Partial<OverviewRows> = {}): OverviewRows {
  return {
    sources: [{ id: 1, code: "axpol", name: "Axpol" }, { id: 2, code: "macma", name: "Macma" }],
    lastRuns: [],
    lastSucceeded: [],
    counts: [],
    vectors: new Map(),
    ...overrides,
  };
}

const PLAN = { models: { active: 4606, changed: 2, created: 1, missing: 43, incoming: 4563, unchanged: 4561, reactivated: 3 } };

describe("modelChanges", () => {
  it("reads the models written by the plan and those deactivated", () => {
    const counts = { plan: PLAN, deactivated: { models: 40, variants: 2 } };
    expect(modelChanges(counts)).toEqual({ created: 1, changed: 2, missing: 40, reactivated: 3 });
  });

  it("has none for a run without its plan or its deactivation", () => {
    expect(modelChanges({})).toBeNull();
    expect(modelChanges(null)).toBeNull();
    expect(modelChanges({ plan: { models: "x" }, deactivated: { models: 0 } })).toBeNull();
    expect(modelChanges({ plan: PLAN })).toBeNull();
  });

  it("counts a missing or broken number as 0", () => {
    expect(modelChanges({ plan: { models: { created: "5", changed: Number.NaN } }, deactivated: {} }))
      .toEqual({ created: 0, changed: 0, missing: 0, reactivated: 0 });
  });
});

describe("textTotals", () => {
  it("splits the models as the embeddings worker plans them", () => {
    const plan = textPlan({ total: 6, unchanged: 2, created: [text(1)], changed: [text(2), text(3)], withoutText: ["X"] });
    expect(textTotals(plan)).toEqual({ models: 6, ready: 2, stale: 2, missing: 1, withoutText: 1 });
  });
});

describe("supplierOverview", () => {
  it("sums each source's counts and keeps its last runs", () => {
    const overview = supplierOverview(rows({
      lastRuns: [
        { sourceId: 1, kind: "catalog", status: "failed", startedAt: STARTED, finishedAt: FINISHED, counts: {} },
        { sourceId: 1, kind: "embed", status: "succeeded", startedAt: EARLIER, finishedAt: EARLIER, counts: {} },
      ],
      lastSucceeded: [{ sourceId: 1, id: 10, finishedAt: EARLIER }],
      counts: [
        { sourceId: 1, models: 3774 },
        { sourceId: 1, variants: 10_900, withStock: 10_881 },
        { sourceId: 1, photos: 30_000 },
        { sourceId: 1, paths: 211, pathsWithout: 1, modelsWithout: 4 },
        { sourceId: 2, models: 1192 },
      ],
      vectors: new Map([[1, {
        photos: { inScope: 27_448, ready: 27_445, failed: 3, pending: 0 },
        texts: textPlan({ total: 3774, unchanged: 3772, withoutText: ["A", "B"] }),
      }]]),
    }));
    const [axpol, macma] = overview.suppliers;
    expect(overview.model).toBe("gemini-embedding-2/1536");
    expect(axpol).toEqual({
      code: "axpol",
      name: "Axpol",
      catalog: { models: 3774, variants: 10_900, photos: 30_000 },
      lastImport: { status: "failed", startedAt: STARTED.toISOString(), finishedAt: FINISHED.toISOString(), models: null },
      lastSucceededAt: EARLIER.toISOString(),
      stock: { variants: 10_881 },
      vectors: {
        photos: { inScope: 27_448, ready: 27_445, failed: 3, pending: 0 },
        texts: { models: 3774, ready: 3772, stale: 0, missing: 0, withoutText: 2 },
        lastRun: { status: "succeeded", startedAt: EARLIER.toISOString(), finishedAt: EARLIER.toISOString() },
      },
      categories: { paths: 211, pathsWithout: 1, modelsWithout: 4 },
    });
    expect(macma?.catalog).toEqual({ models: 1192, variants: 0, photos: 0 });
  });

  it("shows no model changes of a failed import, whose plan may be written in part", () => {
    const overview = supplierOverview(rows({
      lastRuns: [{ sourceId: 1, kind: "catalog", status: "failed", startedAt: STARTED, finishedAt: FINISHED,
        counts: { plan: PLAN, deactivated: { models: 0 } } }],
    }));
    expect(overview.suppliers[0]?.lastImport?.models).toBeNull();
  });

  it("shows the model changes of a succeeded import", () => {
    const overview = supplierOverview(rows({
      lastRuns: [{ sourceId: 1, kind: "catalog", status: "succeeded", startedAt: STARTED, finishedAt: FINISHED,
        counts: { plan: PLAN, deactivated: { models: 43 } } }],
    }));
    expect(overview.suppliers[0]?.lastImport?.models).toEqual({ created: 1, changed: 2, missing: 43, reactivated: 3 });
  });

  it("shows a source never imported nor embedded as empty, not as another's", () => {
    const overview = supplierOverview(rows({
      lastRuns: [{ sourceId: 1, kind: "catalog", status: "running", startedAt: STARTED, finishedAt: null, counts: {} }],
    }));
    const macma = overview.suppliers[1];
    expect(overview.suppliers[0]?.lastImport).toEqual({ status: "running", startedAt: STARTED.toISOString(), finishedAt: null, models: null });
    expect(macma).toMatchObject({
      lastImport: null, lastSucceededAt: null, stock: { variants: 0 },
      vectors: { photos: { inScope: 0, ready: 0, failed: 0, pending: 0 }, texts: { models: 0, ready: 0 }, lastRun: null },
    });
  });
});

describe("GET /api/suppliers", () => {
  const overview: SuppliersOverview = { model: "gemini-embedding-2/1536", suppliers: [] };
  const auth: AuthOptions = {
    isCookieSecure: false,
    service: {
      signIn: () => Promise.resolve(null),
      userOfSession: (token) => Promise.resolve(token === "t1" ? { id: 1, login: "one", role: "manager" } : null),
      signOut: () => Promise.resolve(),
    },
  };
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("answers a manager, not the signed-out", async () => {
    app = buildApp({ auth, suppliers: { overview: () => Promise.resolve(overview) } });
    const signedIn = await app.inject({ method: "GET", url: "/api/suppliers", headers: { cookie: "session=t1" } });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual(overview);
    expect(signedIn.headers["cache-control"]).toBe("no-store");
    const signedOut = await app.inject({ method: "GET", url: "/api/suppliers" });
    expect(signedOut.statusCode).toBe(401);
  });
});
