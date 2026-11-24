import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import type { PhotoAnswer, SupplierPhotos } from "./proxy.js";

const URL_OF_PHOTO = "/api/photos/makito/15246/15246003000/principal/5246-003-P.jpg";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0]);
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ");

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

describe("GET /api/photos/stored/:name", () => {
  const SHA = "ab".repeat(32);
  let storeDir = "";

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "photo-store-"));
    await mkdir(join(storeDir, "ab"));
    await writeFile(join(storeDir, "ab", `${SHA}.webp`), WEBP);
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  function getStored(url: string, cookie = "session=t1") {
    app = buildApp({ auth, photoStoreDir: storeDir });
    return app.inject({ method: "GET", url, headers: { cookie } });
  }

  it("gives the reduced copy, kept by this browser for good: its name changes with its picture", async () => {
    const answer = await getStored(`/api/photos/stored/${SHA}.webp`);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/webp");
    expect(answer.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer.rawPayload).toEqual(WEBP);
  });

  it("is closed without a session", async () => {
    expect((await getStored(`/api/photos/stored/${SHA}.webp`, "")).statusCode).toBe(401);
  });

  it("answers 404 for an empty file: a copy cut short is no copy", async () => {
    const empty = "ef".repeat(32);
    await mkdir(join(storeDir, "ef"));
    await writeFile(join(storeDir, "ef", `${empty}.webp`), "");
    expect((await getStored(`/api/photos/stored/${empty}.webp`)).statusCode).toBe(404);
  });

  it("answers 404, never cached, for a copy not made and for a name that is no sha256", async () => {
    for (const url of [`/api/photos/stored/${"cd".repeat(32)}.webp`, `/api/photos/stored/${SHA}.jpg`,
      "/api/photos/stored/..%2F..%2Fetc%2Fpasswd", `/api/photos/stored/ab%2F${SHA}.webp`]) {
      const answer = await getStored(url);
      expect([url, answer.statusCode, answer.headers["cache-control"]]).toEqual([url, 404, "no-store"]);
      await app?.close();
    }
  });
});
