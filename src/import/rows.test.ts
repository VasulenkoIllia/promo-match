import { describe, expect, it } from "vitest";
import type { CatalogSnapshot, ModelInput, VariantInput } from "../suppliers/types.js";
import { changedRaw, emptyState, planImport } from "./plan.js";
import { deactivatedShare, type EntityPlan, type Existing, keyOf, massDeactivation, planEntity, rowsOf } from "./rows.js";

const stock = {
  inStock: 5, reserved: null, onOrder: null, nextArrivalQuantity: null, nextArrivalDate: null, leadTime: null,
  arrivals: [], sourceUpdatedAt: "2026-10-28T18:45:09+01:00",
};

function variant(sku: string, inStock = 5): VariantInput {
  return {
    sku, externalId: null, ean: null, color: { en: "black" }, colorCode: null, colorGroup: null, size: null, status: null,
    printing: null, attributes: {},
    prices: [{ kind: "net", currency: "EUR", minQuantity: 1, amount: "1.23", isPrimary: true, validUntil: null }],
    stock: { ...stock, inStock },
  };
}

function model(code: string, variants: VariantInput[]): ModelInput {
  return {
    code, externalId: null, name: { en: code }, description: {}, category: {}, categoryCode: null, material: {},
    brand: null, dimensions: null, specFields: { volume: null, texts: [] }, weightGrams: null, countryOfOrigin: null,
    printing: null, printTechniques: [], attributes: {},
    photos: [{
      url: `https://cdn.example/${code}.jpg`, urlLarge: null, kind: null, position: 0,
      variantLinks: variants.flatMap((item) => [{ sku: item.sku, position: 0 }, { sku: item.sku, position: 3 }]),
    }],
    variants,
  };
}

function snapshot(models: ModelInput[]): CatalogSnapshot {
  return {
    models, techniques: [], raw: [{ feed: "products", externalId: "M1", payload: { a: 1 } }], isComplete: true,
    fetched: {}, checks: {}, examples: {}, warnings: [],
  };
}

describe("rowsOf", () => {
  const rows = rowsOf(snapshot([model("M1", [variant("M1-01"), variant("M1-02")])]));

  it("flattens the snapshot into rows keyed by the supplier's codes", () => {
    expect(rows.models.map((row) => row.code)).toEqual(["M1"]);
    expect(rows.variants.map((row) => [row.model_code, row.sku])).toEqual([["M1", "M1-01"], ["M1", "M1-02"]]);
    expect(rows.prices).toHaveLength(2);
    expect(rows.stock.map((row) => row.sku)).toEqual(["M1-01", "M1-02"]);
  });

  it("links a variant to a picture once, at its first place", () => {
    expect(rows.links).toEqual([
      { model_code: "M1", url: "https://cdn.example/M1.jpg", sku: "M1-01", position: 0 },
      { model_code: "M1", url: "https://cdn.example/M1.jpg", sku: "M1-02", position: 0 },
    ]);
  });

  it("hashes the content: the same input the same hash, the stock's source time left out", () => {
    const again = rowsOf(snapshot([model("M1", [variant("M1-01"), variant("M1-02")])]));
    expect(again.models[0]?.content_hash).toBe(rows.models[0]?.content_hash);
    const later = rowsOf(snapshot([model("M1", [{ ...variant("M1-01"), stock: { ...stock, sourceUpdatedAt: "2026-10-28T19:45:09+01:00" } }])]));
    expect(later.stock[0]?.content_hash).toBe(rows.stock[0]?.content_hash);
    const sold = rowsOf(snapshot([model("M1", [variant("M1-01", 4)])]));
    expect(sold.stock[0]?.content_hash).not.toBe(rows.stock[0]?.content_hash);
  });
});

describe("planEntity", () => {
  const existing: Existing = new Map([
    ["a", { hash: "1", isActive: true }],
    ["b", { hash: "2", isActive: true }],
    ["c", { hash: "3", isActive: false }],
    ["d", { hash: "4", isActive: true }],
  ]);

  it("counts new, changed, unchanged, back and missing rows", () => {
    const plan = planEntity(existing, [{ key: "a", hash: "1" }, { key: "b", hash: "9" }, { key: "c", hash: "3" }, { key: "e", hash: "5" }]);
    expect(plan).toEqual({ incoming: 4, created: 1, changed: 1, unchanged: 2, reactivated: 1, missing: 1, active: 3 });
    expect(deactivatedShare(plan)).toBeCloseTo(1 / 3);
  });

  it("has nothing to deactivate in an empty database", () => {
    expect(deactivatedShare(planEntity(new Map(), [{ key: "a", hash: "1" }]))).toBe(0);
  });
});

describe("massDeactivation", () => {
  const steady: EntityPlan = { incoming: 100, created: 0, changed: 0, unchanged: 100, reactivated: 0, missing: 0, active: 100 };
  const plan = { models: steady, variants: steady, photos: steady, prices: steady, stock: steady, techniques: steady, raw: steady };

  it("lets a catalogue through that loses a few rows", () => {
    expect(massDeactivation({ ...plan, prices: { ...steady, missing: 20 } })).toBeUndefined();
  });

  it("stops a feed cut short, prices and photos as well as models", () => {
    expect(massDeactivation({ ...plan, prices: { ...steady, missing: 100 } }))
      .toBe("100 of 100 active prices (100%) would be marked inactive, over 20%: check the feed, or run with"
        + " --allow-mass-deactivation");
    expect(massDeactivation({ ...plan, photos: { ...steady, missing: 21 } })).toContain("21 of 100 active photos");
    expect(massDeactivation({ ...plan, models: { ...steady, missing: 50 } })).toContain("active models");
  });
});

describe("planImport", () => {
  it("plans every entity of a first import as new", () => {
    const plan = planImport(emptyState(), rowsOf(snapshot([model("M1", [variant("M1-01")])])));
    expect(plan.models).toMatchObject({ incoming: 1, created: 1 });
    expect(plan.photos).toMatchObject({ incoming: 1, created: 1 });
    expect(plan.raw).toMatchObject({ incoming: 1, created: 1 });
  });

  it("refuses rows whose keys repeat, which Postgres would refuse in one batch", () => {
    const rows = rowsOf(snapshot([model("M1", [variant("M1-01")]), model("M2", [variant("M1-01")])]));
    expect(() => planImport(emptyState(), rows)).toThrow("variants: 1 keys met twice, e.g. M1-01");
  });
});

describe("changedRaw", () => {
  it("keeps only new raw records and those whose payload changed", () => {
    const rows = rowsOf(snapshot([]));
    const state = emptyState();
    expect(changedRaw(state, rows)).toHaveLength(1);
    state.raw.set(keyOf("products", "M1"), { hash: rows.raw[0]?.payload_hash ?? "", isActive: true });
    expect(changedRaw(state, rows)).toHaveLength(0);
  });
});
