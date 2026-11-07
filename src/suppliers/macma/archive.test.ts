import { deflateRawSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { HttpResult, RequestOptions } from "../http.js";
import {
  ARCHIVE_ORIGIN, ARCHIVES, ArchiveError, ArchiveReader, archivePhotoFetch, archivePhotoOf, endOfArchive,
} from "./archive.js";

interface Entry { name: string; data: Buffer; isDeflated?: boolean; crc?: number }

// A ZIP file in memory: local headers with their data, the central directory, the end record
function zipOf(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const stored = entry.isDeflated ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.isDeflated ? 8 : 0, 8);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.isDeflated ? 8 : 0, 10);
    header.writeUInt32LE(entry.crc ?? crc32(entry.data), 16);
    header.writeUInt32LE(stored.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name);
    offset += local.length + name.length + stored.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

// The archive host: answers a range with 206 and the file's ETag
function server(files: { current: Buffer; etag: string }) {
  const calls: string[] = [];
  const fetchUrl = (url: URL, options: RequestOptions): Promise<HttpResult> => {
    const range = options.headers?.Range ?? "";
    calls.push(`${url.pathname} ${range}`);
    const size = files.current.length;
    const [, from = "", to = ""] = /^bytes=(\d*)-(\d*)$/.exec(range) ?? [];
    const start = from === "" ? Math.max(size - Number(to), 0) : Number(from);
    const end = from === "" ? size - 1 : Math.min(Number(to), size - 1);
    return Promise.resolve({
      status: 206, headers: { "content-range": `bytes ${start}-${end}/${size}`, etag: files.etag }, omittedHeaders: [],
      body: files.current.subarray(start, end + 1), durationMs: 1, attempts: 1, retries: [],
    });
  };
  return { fetchUrl, calls };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const OPTIONS = { timeoutMs: 1_000, maxBytes: 1_048_576, maxAttempts: 1 };

describe("archivePhotoOf", () => {
  it("takes the photos of the two archives and nothing else", () => {
    expect(archivePhotoOf(new URL(`${ARCHIVE_ORIGIN}${ARCHIVES.macma}/1261803.jpg`)))
      .toEqual({ path: ARCHIVES.macma, name: "1261803.jpg" });
    expect(archivePhotoOf(new URL(`${ARCHIVE_ORIGIN}/database_macma/other.zip/1.jpg`))).toBeNull();
    expect(archivePhotoOf(new URL(`https://example.com${ARCHIVES.macma}/1.jpg`))).toBeNull();
    expect(archivePhotoOf(new URL(`${ARCHIVE_ORIGIN}${ARCHIVES.macma}/1.jpg?x=1`))).toBeNull();
    expect(archivePhotoOf(new URL(`${ARCHIVE_ORIGIN}${ARCHIVES.macma}/%2e%2e/secret.jpg`))).toBeNull();
  });
});

describe("ArchiveReader", () => {
  it("reads a stored and a deflated entry by ranges, the directory once", async () => {
    const files = { current: zipOf([{ name: "1.jpg", data: JPEG }, { name: "2.jpg", data: JPEG, isDeflated: true }]), etag: '"a"' };
    const { fetchUrl, calls } = server(files);
    const reader = new ArchiveReader(fetchUrl);
    expect(await reader.read(ARCHIVES.macma, "1.jpg", OPTIONS)).toEqual({ kind: "ok", bytes: JPEG });
    expect(await reader.read(ARCHIVES.macma, "2.jpg", OPTIONS)).toEqual({ kind: "ok", bytes: JPEG });
    expect(await reader.read(ARCHIVES.macma, "3.jpg", OPTIONS)).toEqual({ kind: "missing" });
    // The tail, the directory, then one read per entry
    expect(calls).toHaveLength(4);
  });

  it("refuses an entry whose bytes do not match its CRC", async () => {
    const { fetchUrl } = server({ current: zipOf([{ name: "1.jpg", data: JPEG, crc: 1 }]), etag: '"a"' });
    await expect(new ArchiveReader(fetchUrl).read(ARCHIVES.macma, "1.jpg", OPTIONS)).rejects.toThrow(ArchiveError);
  });

  it("loads the directory again when the file changed under it", async () => {
    const files = { current: zipOf([{ name: "1.jpg", data: JPEG }]), etag: '"a"' };
    const { fetchUrl } = server(files);
    const reader = new ArchiveReader(fetchUrl);
    await reader.index(ARCHIVES.macma);
    const other = Buffer.concat([JPEG, Buffer.alloc(10, 1)]);
    files.current = zipOf([{ name: "0.jpg", data: other }, { name: "1.jpg", data: other }]);
    files.etag = '"b"';
    expect(await reader.read(ARCHIVES.macma, "1.jpg", OPTIONS)).toEqual({ kind: "ok", bytes: other });
  });

  it("refuses an answer that is not a range", async () => {
    const fetchUrl = (): Promise<HttpResult> => Promise.resolve({
      status: 200, headers: {}, omittedHeaders: [], body: Buffer.alloc(0), durationMs: 1, attempts: 1, retries: [],
    });
    await expect(new ArchiveReader(fetchUrl).index(ARCHIVES.macma)).rejects.toThrow(ArchiveError);
  });
});

describe("endOfArchive", () => {
  it("finds the ZIP64 record a 13 GB file points to", () => {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(14_147n, 32);
    record.writeBigUInt64LE(953_169n, 40);
    record.writeBigUInt64LE(13_032_635_639n, 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(13_033_588_812n, 8);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    const tail = Buffer.concat([record, locator, end]);
    expect(endOfArchive(tail, 13_033_588_812)).toEqual({ count: 14_147, size: 953_169, offset: 13_032_635_639 });
    expect(endOfArchive(Buffer.concat([locator, end]), 13_033_588_832)).toEqual({ zip64RecordAt: 13_033_588_812 });
  });
});

describe("archivePhotoFetch", () => {
  it("answers 200 with the bytes, 404 for a name not in the file, 422 for an entry that cannot be read", async () => {
    const { fetchUrl } = server({ current: zipOf([{ name: "1.jpg", data: JPEG }, { name: "2.jpg", data: JPEG, crc: 1 }]), etag: '"a"' });
    const fetchPhoto = archivePhotoFetch(new ArchiveReader(fetchUrl));
    const at = (name: string) => fetchPhoto(new URL(`${ARCHIVE_ORIGIN}${ARCHIVES.easygifts}/${name}`), { method: "GET", ...OPTIONS });
    expect((await at("1.jpg")).status).toBe(200);
    expect((await at("1.jpg")).body).toEqual(JPEG);
    expect((await at("9.jpg")).status).toBe(404);
    expect((await at("2.jpg")).status).toBe(422);
  });
});
