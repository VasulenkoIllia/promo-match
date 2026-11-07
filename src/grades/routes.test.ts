import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import { GradedModelNotFound } from "./errors.js";
import type { GradesService } from "./store.js";

const SEARCH_ID = "3f2b1c9e-7a46-4e0b-9d11-2c5a8f6e1b70";
const URL_OF_GRADE = `/api/search/grades/${SEARCH_ID}/7`;
const BODY = {
  grade: "exact", text: "пляшка 750 мл", hasPhoto: false, model: "gemini-embedding-2/1536", filters: { minStock: 10 }, rank: 3,
  confidencePercent: 70, lists: { "text-text": { rank: 2, similarity: 0.71 } },
  conditionMatch: { volumeMl: "fits", materials: null }, matchedCode: null,
};

function fakeService(overrides: Partial<GradesService> = {}) {
  const calls = { set: [] as unknown[][], removed: [] as unknown[][] };
  const service: GradesService = {
    set: (...args) => {
      calls.set.push(args);
      return Promise.resolve();
    },
    remove: (...args) => {
      calls.removed.push(args);
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

// Two sessions of two users
const auth: AuthOptions = {
  isCookieSecure: false,
  service: {
    signIn: () => Promise.resolve(null),
    userOfSession: (token) => Promise.resolve(token === "t1" ? { id: 1, login: "one", role: "manager" } : token === "t2" ? { id: 2, login: "two", role: "manager" } : null),
    signOut: () => Promise.resolve(),
  },
};

function put(service: GradesService, payload: Record<string, unknown>, cookie = "session=t1", url = URL_OF_GRADE) {
  app = buildApp({ auth, grades: service });
  return app.inject({ method: "PUT", url, headers: { cookie }, payload });
}

describe("PUT /api/search/grades/:searchId/:modelId", () => {
  it("keeps the grade with its search, under the user signed in", async () => {
    const { service, calls } = fakeService();
    const response = await put(service, BODY, "session=t2");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ grade: "exact" });
    expect(calls.set).toEqual([[{ searchId: SEARCH_ID, modelId: 7 }, 2, BODY]]);
  });

  it("takes a search by photo alone, which has no text", async () => {
    const { service, calls } = fakeService();
    const response = await put(service, { ...BODY, text: undefined, hasPhoto: true });
    expect(response.statusCode).toBe(200);
    expect(calls.set).toHaveLength(1);
  });

  it("takes a result with nothing measured", async () => {
    const { service } = fakeService();
    const response = await put(service, { ...BODY, confidencePercent: null, conditionMatch: null, matchedCode: "V1" });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["no grade", { ...BODY, grade: undefined }],
    ["a grade the API does not know", { ...BODY, grade: "maybe" }],
    ["a text over the search's bound", { ...BODY, text: "к".repeat(1001) }],
    ["a NUL in the text, which Postgres text cannot hold", { ...BODY, text: "пля\u0000шка" }],
    ["a rank past a search's limit", { ...BODY, rank: 101 }],
    ["a percent past 100", { ...BODY, confidencePercent: 101 }],
    ["a list the search does not have", { ...BODY, lists: { price: { rank: 1, similarity: 1 } } }],
    ["a filter the search does not know", { ...BODY, filters: { price: 5 } }],
    ["a field the API does not take", { ...BODY, price: 5 }],
  ])("answers 400 to %s, without keeping anything", async (_title, payload) => {
    const { service, calls } = fakeService();
    const response = await put(service, payload);
    expect(response.statusCode).toBe(400);
    expect(calls.set).toEqual([]);
  });

  it("answers 400 to a search id that is not one", async () => {
    const { service, calls } = fakeService();
    const response = await put(service, BODY, "session=t1", "/api/search/grades/search-1/7");
    expect(response.statusCode).toBe(400);
    expect(calls.set).toEqual([]);
  });

  it("answers 404 to a model the database does not have", async () => {
    const { service } = fakeService({ set: () => Promise.reject(new GradedModelNotFound("no such model")) });
    const response = await put(service, BODY);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "no such model" });
  });

  it("answers 401 without a session, keeping nothing", async () => {
    const { service, calls } = fakeService();
    const response = await put(service, BODY, "session=stranger");
    expect(response.statusCode).toBe(401);
    expect(calls.set).toEqual([]);
  });
});

describe("DELETE /api/search/grades/:searchId/:modelId", () => {
  it("takes back only the grade of the user signed in", async () => {
    const { service, calls } = fakeService();
    app = buildApp({ auth, grades: service });
    const response = await app.inject({ method: "DELETE", url: URL_OF_GRADE, headers: { cookie: "session=t2" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ isRemoved: true });
    expect(calls.removed).toEqual([[{ searchId: SEARCH_ID, modelId: 7 }, 2]]);
  });
});
