import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import { OwnProductExists, OwnProductNotFound } from "./errors.js";
import type { NewOwnProduct } from "./request.js";
import type { ModelLink, OwnProductList, OwnProductsService } from "./store.js";

const LIST: OwnProductList = {
  products: [{
    id: 1, name: "Кружка", code: "K-1", links: [{
      modelId: 7, type: "same", source: { code: "axpol", name: "Axpol" }, code: "V1", name: "Mug", category: ["DRINKWARE"],
      isActive: true, photoUrl: "https://files.axpol.com/a.jpg",
    }],
  }],
  isComplete: true,
};
const LINKS: ModelLink[] = [{ modelId: 7, ownProductId: 1, ownProductName: "Кружка", type: "same" }];

// Records what it was asked; a test overrides what it needs to fail
function fakeService(overrides: Partial<OwnProductsService> = {}) {
  const calls = {
    created: [] as NewOwnProduct[], linked: [] as unknown[][], unlinked: [] as number[][], modelIds: [] as number[][],
  };
  const service: OwnProductsService = {
    list: () => Promise.resolve(LIST),
    create: (input) => {
      calls.created.push(input);
      return Promise.resolve({ id: 2, ...input });
    },
    linksOfModels: (modelIds) => {
      calls.modelIds.push(modelIds);
      return Promise.resolve(LINKS);
    },
    link: (...args) => {
      calls.linked.push(args);
      return Promise.resolve();
    },
    unlink: (...args) => {
      calls.unlinked.push(args);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { service, calls };
}

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// Only this session's cookie is signed in
const auth: AuthOptions = {
  isCookieSecure: false,
  service: {
    signIn: () => Promise.resolve(null),
    userOfSession: (token) => Promise.resolve(token === "t1" ? { id: 1, login: "tester", role: "manager" } : null),
    signOut: () => Promise.resolve(),
  },
};
const SIGNED_IN = { cookie: "session=t1" };

function appWith(service: OwnProductsService) {
  app = buildApp({ auth, ownProducts: service });
  return app;
}

describe("POST /api/own-products", () => {
  const post = (service: OwnProductsService, payload: Record<string, unknown>) =>
    appWith(service).inject({ method: "POST", url: "/api/own-products", headers: SIGNED_IN, payload });

  it("creates the product with its name and code tidied", async () => {
    const { service, calls } = fakeService();
    const response = await post(service, { name: "  Кружка   біла\n", code: " K-1 " });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 2, name: "Кружка біла", code: "K-1" });
    expect(calls.created).toEqual([{ name: "Кружка біла", code: "K-1" }]);
  });

  it("takes a code left blank as no code", async () => {
    const { service, calls } = fakeService();
    await post(service, { name: "Кружка", code: "  " });
    expect(calls.created).toEqual([{ name: "Кружка", code: null }]);
  });

  it.each([
    ["no name", { code: "K-1" }],
    ["a blank name", { name: " \n " }],
    ["a name over the bound", { name: "к".repeat(201) }],
    ["a code over the bound", { name: "Кружка", code: "к".repeat(61) }],
    ["a NUL in the name, which Postgres text cannot hold", { name: "Кру\u0000жка" }],
    ["a NUL in the code", { name: "Кружка", code: "K\u00001" }],
    ["a field the API does not take", { name: "Кружка", price: 5 }],
  ])("answers 400 to %s, without creating anything", async (_title, payload) => {
    const { service, calls } = fakeService();
    const response = await post(service, payload);
    expect(response.statusCode).toBe(400);
    expect(calls.created).toEqual([]);
  });

  it("answers 409 when the name or code is taken", async () => {
    const { service } = fakeService({ create: () => Promise.reject(new OwnProductExists("another own product has this name or code")) });
    const response = await post(service, { name: "Кружка" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "another own product has this name or code" });
  });

  it("answers 500 to an error it does not know, without its details", async () => {
    const { service } = fakeService({ create: () => Promise.reject(new Error("relation own_product does not exist")) });
    const response = await post(service, { name: "Кружка" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("own_product");
  });

  it.each([
    ["text/plain", '{"name":"Кружка"}'],
    ["application/x-www-form-urlencoded", "name=x"],
  ])("takes nothing a cross-site form can send: %s", async (contentType, payload) => {
    const { service, calls } = fakeService();
    const response = await appWith(service).inject({
      method: "POST", url: "/api/own-products", headers: { ...SIGNED_IN, "content-type": contentType }, payload,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(calls.created).toEqual([]);
  });
});

describe("GET /api/own-products", () => {
  it("lists the products with their linked models", async () => {
    const response = await appWith(fakeService().service).inject({ method: "GET", url: "/api/own-products", headers: SIGNED_IN });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(LIST);
  });
});

describe("GET /api/own-products/links", () => {
  const get = (service: OwnProductsService, query: string) =>
    appWith(service).inject({ method: "GET", url: `/api/own-products/links?${query}`, headers: SIGNED_IN });

  it("reads the links of the models asked for, one or several", async () => {
    const { service, calls } = fakeService();
    const several = await get(service, "modelIds=7&modelIds=9");
    expect(several.statusCode).toBe(200);
    expect(several.json()).toEqual({ links: LINKS });
    await app?.close();
    await get(service, "modelIds=7");
    expect(calls.modelIds).toEqual([[7, 9], [7]]);
  });

  it.each([
    ["no models", ""],
    ["a model that is not a number", "modelIds=abc"],
    ["a model id past the column", "modelIds=2147483648"],
    ["more models than a search shows", Array.from({ length: 101 }, (_item, index) => `modelIds=${index + 1}`).join("&")],
  ])("answers 400 to %s", async (_title, query) => {
    const { service, calls } = fakeService();
    const response = await get(service, query);
    expect(response.statusCode).toBe(400);
    expect(calls.modelIds).toEqual([]);
  });
});

describe("PUT /api/own-products/:ownProductId/links/:modelId", () => {
  const put = (service: OwnProductsService, path: string, payload: Record<string, unknown>) =>
    appWith(service).inject({ method: "PUT", url: `/api/own-products/${path}`, headers: SIGNED_IN, payload });

  it("links the model with the type", async () => {
    const { service, calls } = fakeService();
    const response = await put(service, "1/links/7", { type: "analog" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ownProductId: 1, modelId: 7, type: "analog" });
    expect(calls.linked).toEqual([[1, 7, "analog"]]);
  });

  it.each([
    ["an unknown type", "1/links/7", { type: "similar" }],
    ["no type", "1/links/7", {}],
    ["a field the API does not take", "1/links/7", { type: "same", note: "x" }],
    ["an own product that is not a number", "abc/links/7", { type: "same" }],
    ["a model id of 0", "1/links/0", { type: "same" }],
    ["a model id past the column", "1/links/2147483648", { type: "same" }],
  ])("answers 400 to %s, without linking", async (_title, path, payload) => {
    const { service, calls } = fakeService();
    const response = await put(service, path, payload);
    expect(response.statusCode).toBe(400);
    expect(calls.linked).toEqual([]);
  });

  it("answers 404 when the own product or the model is not there", async () => {
    const { service } = fakeService({ link: () => Promise.reject(new OwnProductNotFound("no such own product or model")) });
    const response = await put(service, "1/links/7", { type: "same" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no such own product or model" });
  });
});

describe("DELETE /api/own-products/:ownProductId/links/:modelId", () => {
  it("unlinks the pair and says whether it was linked, so a repeat is safe", async () => {
    const { service, calls } = fakeService();
    const first = await appWith(service).inject({ method: "DELETE", url: "/api/own-products/1/links/7", headers: SIGNED_IN });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ isRemoved: true });
    expect(calls.unlinked).toEqual([[1, 7]]);
    await app?.close();
    const repeat = await appWith(fakeService({ unlink: () => Promise.resolve(false) }).service)
      .inject({ method: "DELETE", url: "/api/own-products/1/links/7", headers: SIGNED_IN });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ isRemoved: false });
  });
});

describe("the login", () => {
  const requests = [
    { method: "GET", url: "/api/own-products" },
    { method: "POST", url: "/api/own-products", payload: { name: "Кружка" } },
    { method: "GET", url: "/api/own-products/links?modelIds=7" },
    { method: "PUT", url: "/api/own-products/1/links/7", payload: { type: "same" } },
    { method: "DELETE", url: "/api/own-products/1/links/7" },
  ] as const;

  it.each(requests)("answers 401 to $method $url without a session", async (request) => {
    const { service, calls } = fakeService();
    const response = await appWith(service).inject(request);
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual({ created: [], linked: [], unlinked: [], modelIds: [] });
  });

  it.each(requests)("refuses $method $url from another site, even with the cookie", async (request) => {
    const { service, calls } = fakeService();
    const response = await appWith(service).inject({ ...request, headers: { ...SIGNED_IN, "sec-fetch-site": "same-site" } });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual({ created: [], linked: [], unlinked: [], modelIds: [] });
  });

  it.each(requests)("takes $method $url from a signed-in page", async (request) => {
    const response = await appWith(fakeService().service)
      .inject({ ...request, headers: { ...SIGNED_IN, "sec-fetch-site": "same-origin" } });
    expect(response.statusCode).toBeLessThan(300);
  });

  it("has no routes without the service", async () => {
    app = buildApp({ auth });
    const response = await app.inject({ method: "GET", url: "/api/own-products", headers: SIGNED_IN });
    expect(response.statusCode).toBe(404);
  });
});
