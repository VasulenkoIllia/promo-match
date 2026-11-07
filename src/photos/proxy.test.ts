import { describe, expect, it } from "vitest";
import type { HttpResult } from "../suppliers/http.js";
import type { MakitoSession } from "../suppliers/makito/api.js";
import { createMakitoPhotos } from "./proxy.js";

const PATH = "15246/15246003000/principal/5246-003-P.jpg";
// The start of a JPEG of 2×1 pixels: SOI, then a start-of-frame marker with its size
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03]);

function answer(status: number, body = JPEG, headers: Record<string, string> = {}): HttpResult {
  return { status, headers, omittedHeaders: [], body, durationMs: 1, attempts: 1, retries: [] };
}

// A session whose photos answer in turn from the list; the URLs asked for are kept
function fakeSession(answers: (HttpResult | Error)[]) {
  const asked: string[] = [];
  const session = {
    fetchAsset: (url: URL) => {
      asked.push(url.href);
      const next = answers.shift() ?? answer(200);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  } as unknown as MakitoSession;
  return { session, asked };
}

describe("createMakitoPhotos", () => {
  it("reads a photo of the catalogue once, types it by its bytes and keeps it", async () => {
    const { session, asked } = fakeSession([answer(200)]);
    const photos = createMakitoPhotos(session);
    const [first, second] = await Promise.all([photos.read(PATH), photos.read(PATH)]);
    expect(first).toEqual({ kind: "ok", bytes: JPEG, mimeType: "image/jpeg" });
    expect(second).toBe(first);
    expect(await photos.read(PATH)).toBe(first);
    expect(asked).toEqual([`https://apis.makito.es/catalog/assets/${PATH}`]);
  });

  it("never asks for a path outside the photos", async () => {
    const { session, asked } = fakeSession([]);
    const photos = createMakitoPhotos(session);
    for (const path of ["../../orders/x", "15246/..", "15246", "15246/a?b=1"]) {
      expect(await photos.read(path)).toEqual({ kind: "missing" });
    }
    expect(asked).toEqual([]);
  });

  it("tells a missing photo, the request limit and a failure apart, and keeps none of them", async () => {
    const { session, asked } = fakeSession([
      answer(404), answer(429, JPEG, { "retry-after": "12" }), answer(200, Buffer.from("<html>")), answer(500),
      new Error("login: HTTP 401"),
    ]);
    const photos = createMakitoPhotos(session);
    expect(await photos.read(PATH)).toEqual({ kind: "missing" });
    expect(await photos.read(PATH)).toEqual({ kind: "busy", retryAfterSeconds: 12 });
    const notPicture = await photos.read(PATH);
    expect(notPicture.kind === "failed" && notPicture.reason.startsWith("not a JPEG or PNG")).toBe(true);
    expect(await photos.read(PATH)).toEqual({ kind: "failed", reason: "HTTP 500" });
    expect(await photos.read(PATH)).toEqual({ kind: "failed", reason: "login: HTTP 401" });
    expect(asked).toHaveLength(5);
  });

  it("shows a photo too big for the vectors", async () => {
    // A PNG header of 4500×4500, as Makito sends some of its photos
    const big = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    big.writeUInt32BE(4500, 16);
    big.writeUInt32BE(4500, 20);
    const { session } = fakeSession([answer(200, big)]);
    expect(await createMakitoPhotos(session).read(PATH)).toEqual({ kind: "ok", bytes: big, mimeType: "image/png" });
  });

  it("drops the photo used longest ago past the size limit", async () => {
    const { session, asked } = fakeSession([]);
    const photos = createMakitoPhotos(session, JPEG.length * 2);
    for (const path of ["1/a.jpg", "1/b.jpg", "1/a.jpg", "1/c.jpg", "1/a.jpg", "1/b.jpg"]) await photos.read(path);
    expect(asked.map((url) => url.split("/").at(-1))).toEqual(["a.jpg", "b.jpg", "c.jpg", "b.jpg"]);
  });
});
