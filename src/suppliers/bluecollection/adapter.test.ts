import { afterEach, describe, expect, it, vi } from "vitest";
import { bluecollectionAdapter } from "./adapter.js";

// The pages of client-products and promo-prices against a mocked network: the snapshot is complete only when each adds
// up to its count
const credentials = { username: "bluecollection-user", password: "bluecollection-password" };
const json = (body: unknown) => new Response(JSON.stringify(body));
const product = (index: string) => ({
  index, quantity: 1, category: 3, subcategory: 99, names: [{ language: "en", title: "Refill" }],
  currency: "PLN", purchase_price: "0.30", catalogue_price: "0.50", discount_prices: true, prices: [{ pln: "0.50", eur: "0.12" }],
});
const promotion = (index: string) => ({ index, active: true, is_current: true, tiers: [{ from_qty: 1, eur: "0.05" }] });

function serve(products: unknown[], count: number, promotions: { results: unknown[]; count: number } = { results: [], count: 0 }): void {
  vi.stubGlobal("fetch", (input: URL) => {
    const path = input.pathname;
    if (path.endsWith("/token/")) return Promise.resolve(json({ access: "access-1", refresh: "refresh-1" }));
    if (path.endsWith("/categories/")) return Promise.resolve(json({ count: 1, next: null, results: [{ id: 3, en: "Stationery" }] }));
    if (path.endsWith("/subcategories/")) return Promise.resolve(json({ count: 1, next: null, results: [{ id: 99, en: "Refills" }] }));
    if (path.endsWith("/promo-prices/")) return Promise.resolve(json({ ...promotions, next: null }));
    return Promise.resolve(json({ count, next: null, results: products }));
  });
}

const context = () => ({ signal: new AbortController().signal, log: () => undefined, secrets: [] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bluecollectionAdapter", () => {
  it("is complete when the pages add up to the count", async () => {
    serve([product("02003-03"), product("02003-12")], 2);
    const snapshot = await bluecollectionAdapter(credentials).fetchCatalog(context());
    expect(snapshot).toMatchObject({ isComplete: true, warnings: [] });
  });

  it("is not complete, so nothing is marked inactive, when records are missing or an index comes twice", async () => {
    serve([product("02003-03")], 2);
    const short = await bluecollectionAdapter(credentials).fetchCatalog(context());
    expect(short).toMatchObject({ isComplete: false, warnings: ["products: 1 records read, the first page said 2"] });
    serve([product("02003-03"), product("02003-03")], 2);
    expect(await bluecollectionAdapter(credentials).fetchCatalog(context())).toMatchObject({ isComplete: false });
  });

  it("writes nothing when the promotions are cut or one comes twice, as their indexes would show a higher price", async () => {
    serve([product("02003-03")], 1, { results: [promotion("02003-03")], count: 2 });
    await expect(bluecollectionAdapter(credentials).fetchCatalog(context()))
      .rejects.toThrow("prices not written, yesterday's stay: promotions: 1 records read, the first page said 2");
    serve([product("02003-03")], 1, { results: [promotion("02003-03"), promotion("02003-03")], count: 2 });
    await expect(bluecollectionAdapter(credentials).fetchCatalog(context())).rejects.toThrow("1 records with a repeated index");
  });

  it("writes nothing when a list changed its shape, not on a few odd records", async () => {
    const plain = (index: string) => ({ ...product(index), discount_prices: undefined });
    serve([plain("02003-03")], 1);
    await expect(bluecollectionAdapter(credentials).fetchCatalog(context()))
      .rejects.toThrow("discount_prices values other than true or false: 1 of 1");
    const renamed = { ...promotion("02003-03"), index: undefined, product_index: "02003-03" };
    serve([product("02003-03")], 1, { results: [renamed], count: 1 });
    await expect(bluecollectionAdapter(credentials).fetchCatalog(context())).rejects.toThrow("promotions records without index");
    const onPromotion = { ...product("02003-03"), price_source: "promo" };
    serve([onPromotion], 1, { results: [], count: 0 });
    await expect(bluecollectionAdapter(credentials).fetchCatalog(context()))
      .rejects.toThrow("promo prices without a current promotion: 1 of 1 (e.g. 02003-03)");
    const many = Array.from({ length: 30 }, (_, index) => product(`02003-${index}`));
    serve([...many, plain("02004")], 31);
    expect(await bluecollectionAdapter(credentials).fetchCatalog(context())).toMatchObject({ isComplete: true });
  });

  it("prices an index by its promotion", async () => {
    serve([product("02003-03"), product("02003-12")], 2, { results: [promotion("02003-03")], count: 1 });
    const snapshot = await bluecollectionAdapter(credentials).fetchCatalog(context());
    expect(snapshot.isComplete).toBe(true);
    const primary = snapshot.models[0]?.variants.map((variant) => variant.prices.find((price) => price.isPrimary)?.amount);
    expect(primary).toEqual(["0.05", "0.066"]);
  });
});
