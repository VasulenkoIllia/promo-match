import { afterEach, describe, expect, it, vi } from "vitest";
import { InspirionClient, InspirionError, inspirionUrl } from "./api.js";

const API_KEY = "inspirion-api-key";
const feed = { name: "stock", path: "v1/stock", query: {} };
let keys: (string | undefined)[] = [];

function serve(answer: () => Response): void {
  vi.stubGlobal("fetch", (_input: URL, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)["X-Gateway-API-Key"]);
    return Promise.resolve(answer());
  });
}

const client = () => new InspirionClient(API_KEY, [], new AbortController().signal);

afterEach(() => {
  vi.unstubAllGlobals();
  keys = [];
});

describe("inspirionUrl", () => {
  it("builds the three read lists only", () => {
    expect(inspirionUrl({ name: "products", path: "v2/products", query: { language: "en" } }).href)
      .toBe("https://leoapi.inspirion.eu/api/v2/products?language=en");
    for (const path of ["v1/create-order", "v1/offers/create", "v1/price-calculation", "../api/v1/orders", "v1/stock/../orders"]) {
      expect(() => inspirionUrl({ name: "x", path, query: {} })).toThrow("is not a read feed");
    }
  });
});

describe("InspirionClient", () => {
  it("sends the key in its header and reads the JSON", async () => {
    serve(() => new Response(JSON.stringify([{ article_id: "56-1101117" }])));
    await expect(client().read(feed)).resolves.toMatchObject({ json: [{ article_id: "56-1101117" }] });
    expect(keys).toEqual([API_KEY]);
  });

  it("stops on a refusal without a retry and on an answer that is not JSON", async () => {
    serve(() => new Response("Forbidden", { status: 403 }));
    await expect(client().read(feed)).rejects.toThrow(new InspirionError("stock: HTTP 403"));
    expect(keys).toHaveLength(1);
    serve(() => new Response("<html>"));
    await expect(client().read(feed)).rejects.toThrow("stock: the answer is not JSON");
  });
});
