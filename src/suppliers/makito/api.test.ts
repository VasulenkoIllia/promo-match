import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUrl, isAssetPath, isAssetUrl, MakitoSession, makitoPhotoFetch, readUrl } from "./api.js";

const CREDENTIALS = { clientId: "makito-client", clientSecret: "makito-secret" };
const PHOTO = "https://apis.makito.es/catalog/assets/15246/15246003000/principal/5246-003-P.jpg";
const MINUTE_MS = 60_000;

interface Call {
  url: string;
  authorization: string | undefined;
}

let calls: Call[] = [];
let tokens = 0;

// Login answers a new token each time; a photo answers by the status the test gives for that token
function serve(photoStatus: (token: string) => number = () => 200, loginStatus = 200): void {
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: input.href, authorization: headers.Authorization });
    if (input.pathname === "/access/auth/login") {
      tokens += 1;
      return Promise.resolve(Response.json({ token: `jwt-${tokens}` }, { status: loginStatus }));
    }
    const token = headers.Authorization?.replace("Bearer ", "") ?? "";
    return Promise.resolve(new Response("photo", { status: photoStatus(token) }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  calls = [];
  tokens = 0;
});

const photoOptions = { method: "GET" as const, timeoutMs: 1_000, maxBytes: 1_000, maxAttempts: 1 };

describe("readUrl", () => {
  it("builds the read feeds only", () => {
    expect(readUrl("catalog/files", { format: "JSON", lang: "en" }).href)
      .toBe("https://apis.makito.es/catalog/files?format=JSON&lang=en");
    expect(readUrl("catalog/colors", { language: "en" }).href).toBe("https://apis.makito.es/catalog/colors?language=en");
    expect(readUrl("print-config/files", { format: "JSON", lang: "en" }).href)
      .toBe("https://apis.makito.es/print-config/files?format=JSON&lang=en");
    expect(readUrl("print-price-list/files", { format: "JSON" }).href).toBe("https://apis.makito.es/print-price-list/files?format=JSON");
    for (const path of ["orders", "orders/sales-order", "access/clients", "catalog/files/../../orders", "stock/files/x", "print-config/assets/14964/x.jpg", "print-config"]) {
      expect(() => readUrl(path, {})).toThrow("is not a read feed");
    }
  });
});

describe("isAssetUrl", () => {
  it("takes Makito's https photos of the catalogue only", () => {
    expect(isAssetUrl(new URL(PHOTO))).toBe(true);
    expect(isAssetUrl(new URL("https://apis.makito.es/catalog/assets/12008C/principal/2008C-W.jpg"))).toBe(true);
    for (const link of [
      "http://apis.makito.es/catalog/assets/15246/principal/5246-W.jpg",
      "https://apis.makito.es.evil.test/catalog/assets/15246/principal/5246-W.jpg",
      "https://apis.makito.es:8443/catalog/assets/15246/principal/5246-W.jpg",
      "https://user:pass@apis.makito.es/catalog/assets/15246/principal/5246-W.jpg",
      "https://apis.makito.es/catalog/assets/15246/principal/5246-W.jpg?token=x",
      "https://apis.makito.es/orders/sales-order",
      "https://apis.makito.es/catalog/assets/../../orders/x",
      "https://apis.makito.es/catalog/assets/15246",
    ]) {
      expect(isAssetUrl(new URL(link)), link).toBe(false);
    }
  });

  it("refuses a path that could leave the photos", () => {
    expect(isAssetPath("15246/principal/5246-W.jpg")).toBe(true);
    for (const path of ["", "15246", "../orders/x", "15246/../x", "15246/.hidden", "15246//x", "15246/a%2Fb", "15246/a b"]) {
      expect(isAssetPath(path), path).toBe(false);
    }
    expect(() => assetUrl("../orders/x")).toThrow("not a photo path");
  });
});

describe("MakitoSession", () => {
  it("logs in once for many reads and sends the token to its photos only", async () => {
    serve();
    const fetchUrl = makitoPhotoFetch(new MakitoSession(CREDENTIALS, []));
    await fetchUrl(new URL(PHOTO), photoOptions);
    await fetchUrl(new URL(PHOTO), photoOptions);
    await fetchUrl(new URL("https://cdn.example.test/photo.jpg"), photoOptions);
    expect(calls.map((call) => [new URL(call.url).pathname, call.authorization])).toEqual([
      ["/access/auth/login", undefined],
      ["/catalog/assets/15246/15246003000/principal/5246-003-P.jpg", "Bearer jwt-1"],
      ["/catalog/assets/15246/15246003000/principal/5246-003-P.jpg", "Bearer jwt-1"],
      ["/photo.jpg", undefined],
    ]);
  });

  it("does not log in again right after a failed login", async () => {
    serve(() => 200, 401);
    const secrets: string[] = [];
    const session = new MakitoSession(CREDENTIALS, secrets);
    await expect(session.bearer()).rejects.toThrow("login: HTTP 401");
    await expect(session.bearer()).rejects.toThrow("login: HTTP 401");
    expect(calls).toHaveLength(1);
    expect(secrets).toEqual([CREDENTIALS.clientId, CREDENTIALS.clientSecret]);
  });

  it("takes a new token after 55 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve();
    const session = new MakitoSession(CREDENTIALS, []);
    expect(await session.bearer()).toBe("jwt-1");
    vi.setSystemTime(Date.now() + 54 * MINUTE_MS);
    expect(await session.bearer()).toBe("jwt-1");
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    expect(await session.bearer()).toBe("jwt-2");
  });

  it("renews a token a photo refuses once, and not a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve((token) => (token === "jwt-1" ? 401 : 200));
    const session = new MakitoSession(CREDENTIALS, []);
    expect((await session.fetchAsset(new URL(PHOTO), photoOptions)).status).toBe(401);
    expect(tokens).toBe(1);
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    expect((await session.fetchAsset(new URL(PHOTO), photoOptions)).status).toBe(200);
    expect(tokens).toBe(2);
  });

  it("slows down to one photo at a time with a pause once the limit is at its reserve", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    let left = 31;
    vi.stubGlobal("fetch", (input: URL) => {
      calls.push({ url: input.href, authorization: undefined });
      if (input.pathname === "/access/auth/login") return Promise.resolve(Response.json({ token: "jwt-1" }));
      left -= 1;
      return Promise.resolve(new Response("photo", { headers: { "x-ratelimit-remaining": String(left) } }));
    });
    const fetchUrl = makitoPhotoFetch(new MakitoSession(CREDENTIALS, []));
    await fetchUrl(new URL(PHOTO), photoOptions);
    let isDone = false;
    const next = fetchUrl(new URL(PHOTO), photoOptions).then(() => {
      isDone = true;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(isDone).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await next;
    expect(calls).toHaveLength(3);
  });

  it("refuses to send the token anywhere else", async () => {
    serve();
    const session = new MakitoSession(CREDENTIALS, []);
    await expect(session.fetchAsset(new URL("https://apis.makito.es/orders/x"), photoOptions)).rejects.toThrow("is not a photo");
    expect(calls).toEqual([]);
  });
});
