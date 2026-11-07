import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, createOwnProduct, fetchModelLinks, fetchOptions, fetchOwnProducts, fetchSignedInUser, linkModel, search,
  setSignedOutListener, signIn, signOut, unlinkModel,
} from "./api";

const OPTIONS = { models: [], sources: [], categories: [], sharedCategories: [] };
const BODY = { model: "gemini-embedding-2/1536", conditionPass: false, filters: {}, limit: 100 };

function answer(body: BodyInit | null, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

function stubFetch(result: () => Promise<Response>) {
  const fetchMock = vi.fn(result);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`);
  return error.failure;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSignedOutListener(() => undefined);
});

describe("the API client", () => {
  it("posts the search as JSON and returns the answer", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(answer(JSON.stringify({ results: [] }))));
    await expect(search(BODY)).resolves.toEqual({ results: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
  });

  it("passes the server's own message of an error on", async () => {
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ error: "unknown source: x" }), 400)));
    expect(await failureOf(search(BODY))).toEqual({ kind: "status", status: 400, detail: "unknown source: x" });
  });

  it("gives no detail for an error page without { error }, as the dev proxy sends with the API down", async () => {
    stubFetch(() => Promise.resolve(answer(null, 502)));
    expect(await failureOf(search(BODY))).toEqual({ kind: "status", status: 502, detail: null });
  });

  it("tells a network failure from an answer that is not JSON or not the expected shape", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await failureOf(search(BODY))).toEqual({ kind: "network" });
    stubFetch(() => Promise.resolve(answer("<html>")));
    expect(await failureOf(search(BODY))).toEqual({ kind: "bad-answer" });
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ models: [] }))));
    expect(await failureOf(fetchOptions(new AbortController().signal))).toEqual({ kind: "bad-answer" });
  });

  it("reads a body cut short as the connection's failure", async () => {
    const cut = answer("{}");
    vi.spyOn(cut, "json").mockRejectedValue(new TypeError("terminated"));
    stubFetch(() => Promise.resolve(cut));
    expect(await failureOf(search(BODY))).toEqual({ kind: "network" });
  });

  it("passes the caller's own abort on as it is", async () => {
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      return Promise.reject(controller.signal.reason as Error);
    });
    await expect(fetchOptions(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns the options when their lists are there", async () => {
    stubFetch(() => Promise.resolve(answer(JSON.stringify(OPTIONS))));
    await expect(fetchOptions(new AbortController().signal)).resolves.toEqual(OPTIONS);
  });
});

describe("the sign-in client", () => {
  const signal = new AbortController().signal;
  const unauthorized = () => Promise.resolve(answer(JSON.stringify({ error: "sign in first" }), 401));

  it("posts the login and the password as JSON", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(answer(JSON.stringify({ login: "tester" }))));
    await expect(signIn("tester", "pass")).resolves.toEqual({ login: "tester" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ login: "tester", password: "pass" });
  });

  it("signs out with a POST without a body, which the server would take for broken JSON", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(answer(JSON.stringify({ status: "ok" }))));
    await signOut();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it("tells the listener of a 401 from any call, and still fails that call", async () => {
    const listener = vi.fn();
    setSignedOutListener(listener);
    stubFetch(unauthorized);
    expect(await failureOf(search(BODY))).toEqual({ kind: "status", status: 401, detail: "sign in first" });
    expect(await failureOf(fetchSignedInUser(signal))).toEqual({ kind: "status", status: 401, detail: "sign in first" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("says nothing of other failures to the listener", async () => {
    const listener = vi.fn();
    setSignedOutListener(listener);
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ error: "x" }), 403)));
    await failureOf(search(BODY));
    expect(listener).not.toHaveBeenCalled();
  });

  it("tells a limit with its wait from the daily budget's 429, which has none", async () => {
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ error: "too many" }), 429, { "retry-after": "40" })));
    expect(await failureOf(search(BODY))).toEqual({ kind: "limited", retryAfterSeconds: 40 });
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ error: "budget" }), 429)));
    expect(await failureOf(search(BODY))).toEqual({ kind: "status", status: 429, detail: "budget" });
  });
});

describe("the own products client", () => {
  const signal = new AbortController().signal;
  const requestOf = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls[0] as unknown as [string, RequestInit];

  it("reads the list, and calls an answer without its products a bad one", async () => {
    const list = { products: [], isComplete: true };
    stubFetch(() => Promise.resolve(answer(JSON.stringify(list))));
    await expect(fetchOwnProducts(signal)).resolves.toEqual(list);
    stubFetch(() => Promise.resolve(answer("{}")));
    expect(await failureOf(fetchOwnProducts(signal))).toEqual({ kind: "bad-answer" });
  });

  it("posts a new product as JSON and passes on that its name is taken", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(answer(JSON.stringify({ id: 2, name: "Кружка", code: null }), 201)));
    await expect(createOwnProduct({ name: "Кружка", code: "" })).resolves.toEqual({ id: 2, name: "Кружка", code: null });
    const [url, init] = requestOf(fetchMock);
    expect(url).toBe("/api/own-products");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Кружка", code: "" });
    stubFetch(() => Promise.resolve(answer(JSON.stringify({ error: "taken" }), 409)));
    expect(await failureOf(createOwnProduct({ name: "Кружка", code: "" })))
      .toEqual({ kind: "status", status: 409, detail: "taken" });
  });

  it("asks for the links of each model by a repeated parameter and returns the list", async () => {
    const links = [{ modelId: 7, ownProductId: 1, ownProductName: "Кружка", type: "same" }];
    const fetchMock = stubFetch(() => Promise.resolve(answer(JSON.stringify({ links }))));
    await expect(fetchModelLinks([7, 9], signal)).resolves.toEqual(links);
    expect(requestOf(fetchMock)[0]).toBe("/api/own-products/links?modelIds=7&modelIds=9");
  });

  it("puts a link with its type and deletes it by the pair", async () => {
    const linked = stubFetch(() => Promise.resolve(answer("{}")));
    await linkModel(1, 7, "analog");
    const [url, init] = requestOf(linked);
    expect(url).toBe("/api/own-products/1/links/7");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ type: "analog" });
    const unlinked = stubFetch(() => Promise.resolve(answer(JSON.stringify({ isRemoved: true }))));
    await unlinkModel(1, 7);
    expect(requestOf(unlinked)[0]).toBe("/api/own-products/1/links/7");
    expect(requestOf(unlinked)[1].method).toBe("DELETE");
  });
});
