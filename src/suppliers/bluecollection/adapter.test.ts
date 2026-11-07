import { afterEach, describe, expect, it, vi } from "vitest";
import { bluecollectionAdapter } from "./adapter.js";

// The pages of client-products against a mocked network: the snapshot is complete only when they add up to the count
const credentials = { username: "bluecollection-user", password: "bluecollection-password" };
const json = (body: unknown) => new Response(JSON.stringify(body));
const product = (index: string) => ({
  index, quantity: 1, category: 3, subcategory: 99, names: [{ language: "en", title: "Refill" }],
  currency: "PLN", purchase_price: "0.30", catalogue_price: "0.50",
});

function serve(products: unknown[], count: number): void {
  vi.stubGlobal("fetch", (input: URL) => {
    const path = input.pathname;
    if (path.endsWith("/token/")) return Promise.resolve(json({ access: "access-1", refresh: "refresh-1" }));
    if (path.endsWith("/categories/")) return Promise.resolve(json({ count: 1, next: null, results: [{ id: 3, en: "Stationery" }] }));
    if (path.endsWith("/subcategories/")) return Promise.resolve(json({ count: 1, next: null, results: [{ id: 99, en: "Refills" }] }));
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
});
