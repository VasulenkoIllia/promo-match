import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeThumb, missingThumbs, PhotoStoreError, readThumb, shaOfName, storeThumb, THUMB_SIDE, thumbFile, thumbUrl,
} from "./thumbs.js";

const SHA = "0f".repeat(32);
let storeDir = "";

function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
}

beforeEach(async () => {
  storeDir = await mkdtemp(path.join(tmpdir(), "photo-store-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("thumbUrl and shaOfName", () => {
  it("give the route's address of a sha256, and nothing for anything else", () => {
    expect(thumbUrl(SHA)).toBe(`/api/photos/stored/${SHA}.webp`);
    expect(thumbUrl(null)).toBeNull();
    expect(thumbUrl("../etc/passwd")).toBeNull();
    expect(shaOfName(`${SHA}.webp`)).toBe(SHA);
    for (const name of [`${SHA}.jpg`, `${SHA.toUpperCase()}.webp`, `../${SHA}.webp`, `${SHA}.webp/..`, "x.webp"]) {
      expect(shaOfName(name)).toBeNull();
    }
  });
});

describe("makeThumb", () => {
  it("brings the longer side down to THUMB_SIDE as WebP, keeping the shape", async () => {
    const info = await sharp(await makeThumb(await jpeg(1200, 800))).metadata();
    expect([info.format, info.width, info.height]).toEqual(["webp", THUMB_SIDE, 320]);
  });

  it("never enlarges a small photo", async () => {
    const info = await sharp(await makeThumb(await jpeg(300, 200))).metadata();
    expect([info.width, info.height]).toEqual([300, 200]);
  });
});

describe("storeThumb", () => {
  it("writes the copy under its sha256, in a folder of its first two characters, with no partial file left", async () => {
    expect(await storeThumb(storeDir, SHA, await jpeg(1000, 1000))).toBeNull();
    expect(thumbFile(storeDir, SHA)).toBe(path.join(storeDir, "0f", `${SHA}.webp`));
    expect(await readdir(path.join(storeDir, "0f"))).toEqual([`${SHA}.webp`]);
    const bytes = await readThumb(storeDir, SHA);
    expect((await sharp(bytes ?? Buffer.alloc(0)).metadata()).width).toBe(THUMB_SIDE);
  });

  it("leaves a copy already there as it is: the same picture under another photo", async () => {
    await storeThumb(storeDir, SHA, await jpeg(1000, 1000));
    const before = await stat(thumbFile(storeDir, SHA));
    expect(await storeThumb(storeDir, SHA, Buffer.from("not a picture"))).toBeNull();
    expect((await stat(thumbFile(storeDir, SHA))).mtimeMs).toBe(before.mtimeMs);
  });

  it("says why when libvips cannot read the bytes, and writes nothing", async () => {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 10, 3]);
    expect(await storeThumb(storeDir, SHA, header)).toEqual(expect.any(String));
    expect(await readdir(storeDir)).toEqual([]);
  });
});

describe("readThumb", () => {
  it("gives null for a copy that is not there, and for an empty file", async () => {
    expect(await readThumb(storeDir, SHA)).toBeNull();
    await mkdir(path.dirname(thumbFile(storeDir, SHA)));
    await writeFile(thumbFile(storeDir, SHA), "");
    expect(await readThumb(storeDir, SHA)).toBeNull();
  });
});

describe("thumbFile", () => {
  it("refuses any name but a sha256", () => {
    expect(() => thumbFile(storeDir, "../../etc/passwd")).toThrow(/not a sha256/);
  });
});

describe("missingThumbs", () => {
  it("names the sha256 with no file, each once", async () => {
    await storeThumb(storeDir, SHA, await jpeg(100, 100));
    const gone = "1e".repeat(32);
    expect(await missingThumbs(storeDir, [SHA, gone, gone])).toEqual(new Set([gone]));
  });
});

describe("storeThumb on a store that cannot be written", () => {
  it("throws PhotoStoreError: the run stops, the photo is not blamed", async () => {
    const file = path.join(storeDir, "a-file");
    await writeFile(file, "");
    await expect(storeThumb(file, SHA, await jpeg(100, 100))).rejects.toBeInstanceOf(PhotoStoreError);
  });
});
