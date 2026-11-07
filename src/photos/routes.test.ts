import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import type { PhotoAnswer, SupplierPhotos } from "./proxy.js";

const URL_OF_PHOTO = "/api/photos/makito/15246/15246003000/principal/5246-003-P.jpg";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0]);

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const auth: AuthOptions = {
  isCookieSecure: false,
  service: {
    signIn: () => Promise.resolve(null),
    userOfSession: (token) => Promise.resolve(token === "t1" ? { id: 1, login: "one", role: "manager" } : null),
    signOut: () => Promise.resolve(),
  },
};

function get(answer: PhotoAnswer, cookie = "session=t1", url = URL_OF_PHOTO) {
  const paths: string[] = [];
  const photos: SupplierPhotos = {
    read: (path) => {
      paths.push(path);
      return Promise.resolve(answer);
    },
  };
  app = buildApp({ auth, supplierPhotos: photos });
  return { response: app.inject({ method: "GET", url, headers: { cookie } }), paths };
}

describe("GET /api/photos/makito/*", () => {
  it("gives the photo by its own type, kept by this browser only", async () => {
    const { response, paths } = get({ kind: "ok", bytes: JPEG, mimeType: "image/jpeg" });
    const answer = await response;
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/jpeg");
    expect(answer.headers["cache-control"]).toBe("private, max-age=86400");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer.rawPayload).toEqual(JPEG);
    expect(paths).toEqual(["15246/15246003000/principal/5246-003-P.jpg"]);
  });

  it("is closed without a session", async () => {
    const { response, paths } = get({ kind: "ok", bytes: JPEG, mimeType: "image/jpeg" }, "");
    expect((await response).statusCode).toBe(401);
    expect(paths).toEqual([]);
  });

  it("answers a missing photo, the supplier's limit and its failure without caching them", async () => {
    const missing = await get({ kind: "missing" }).response;
    expect([missing.statusCode, missing.headers["cache-control"]]).toEqual([404, "no-store"]);
    await app?.close();
    const busy = await get({ kind: "busy", retryAfterSeconds: 12 }).response;
    expect([busy.statusCode, busy.headers["retry-after"], busy.headers["cache-control"]]).toEqual([503, "12", "no-store"]);
    await app?.close();
    const failed = await get({ kind: "failed", reason: "HTTP 500" }).response;
    expect([failed.statusCode, failed.json()]).toEqual([502, { error: "the supplier did not give the photo" }]);
  });

  it("passes an encoded path on decoded, for the proxy to refuse", async () => {
    const { response, paths } = get({ kind: "missing" }, "session=t1", "/api/photos/makito/15246/%2E%2E/%2E%2E/orders");
    expect((await response).statusCode).toBe(404);
    expect(paths.every((path) => !path.includes("%"))).toBe(true);
  });
});
