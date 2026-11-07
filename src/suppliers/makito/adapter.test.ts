import { afterEach, describe, expect, it, vi } from "vitest";
import { makitoAdapter } from "./adapter.js";

const CREDENTIALS = { clientId: "makito-client", clientSecret: "makito-secret" };
const ASSETS = "https://apis.makito.es/catalog/assets";

const FILES: Record<string, unknown> = {
  "/catalog/files": {
    generatedAt: "2026-11-04T01:02:39Z",
    products: [{
      ref: "15246", web_reference: "5246", name: "Komir", type: "Action Camera",
      categories: ["Production > PRODUCTS > Marking Techniques > Marking Techniques > Serigraphy"],
      image: null, detail_images: [],
      variants: [{ variant_image: `${ASSETS}/15246/15246003000/principal/5246-003-P.jpg`, variant_colorcode: "003", variant_size: "000" }],
    }],
  },
  "/stock/files": { generatedAt: "2026-11-04T18:00:13Z", stocks: [{ material: "15246003000", quantity: 5 }] },
  "/price-list/files": { priceList: [{ material: "15246", currency: "EUR", baseQuantity: "1000", scales: [{ quantity: "1", amount: "1500.00" }] }] },
  "/catalog/colors": [{ colorCode: "003", colorTitle: "Red" }],
  "/catalog/sizes": [{ sizeCode: "102", sizeTitle: "M" }],
  "/print-config/files": { products: [{ id: "15246", areas: [{ id: "A1", techniques: "100123(4)" }] }] },
  "/print-price-list/files": { printPriceList: [{ id: "100123", code: "K", category: "PAD PRINTING K" }] },
};

let paths: string[] = [];

// Makito answers the files above; the print feeds (all, or only the one named) can be made to fail with the status given
function serve(printStatus = 200, onlyPath?: string): void {
  vi.stubGlobal("fetch", (input: URL) => {
    paths.push(input.pathname);
    if (input.pathname === "/access/auth/login") return Promise.resolve(Response.json({ token: "jwt-secret-token" }));
    const status = input.pathname.startsWith("/print") && (!onlyPath || input.pathname === onlyPath) ? printStatus : 200;
    return Promise.resolve(status === 200 ? Response.json(FILES[input.pathname]) : new Response("no", { status }));
  });
}

function fetchCatalog(secrets: string[] = []) {
  return makitoAdapter(CREDENTIALS).fetchCatalog({ signal: new AbortController().signal, log: () => undefined, secrets });
}

afterEach(() => {
  vi.unstubAllGlobals();
  paths = [];
});

describe("makitoAdapter.fetchCatalog", () => {
  it("reads the print areas after the required feeds and adds their techniques", async () => {
    serve();
    const snapshot = await fetchCatalog();
    expect(paths).toEqual([
      "/access/auth/login", "/catalog/files", "/stock/files", "/price-list/files", "/catalog/colors", "/catalog/sizes",
      "/print-config/files", "/print-price-list/files",
    ]);
    expect(snapshot.models[0]?.printTechniques).toEqual(["pad", "screen"]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.isComplete).toBe(true);
  });

  it("keeps the catalogue and warns when the print areas cannot be read", async () => {
    serve(404);
    const snapshot = await fetchCatalog();
    expect(snapshot.isComplete).toBe(true);
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]?.printTechniques).toEqual(["screen"]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("print-config not read");
    expect(snapshot.warnings[0]).toContain("HTTP 404");
  });

  it("drops both print feeds when only the names are missing, so no half-read state is joined", async () => {
    serve(404, "/print-price-list/files");
    const snapshot = await fetchCatalog();
    expect(snapshot.models[0]?.printTechniques).toEqual(["screen"]);
    expect(snapshot.fetched).not.toHaveProperty("print-config");
    expect(snapshot.warnings).toHaveLength(1);
  });

  it("does not turn a stop from outside, in the middle of the print feeds, into a warning", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (input: URL) => {
      if (input.pathname === "/access/auth/login") return Promise.resolve(Response.json({ token: "jwt-secret-token" }));
      if (input.pathname.startsWith("/print")) {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(Response.json(FILES[input.pathname]));
    });
    await expect(makitoAdapter(CREDENTIALS).fetchCatalog({ signal: controller.signal, log: () => undefined, secrets: [] })).rejects.toThrow();
  });
});
