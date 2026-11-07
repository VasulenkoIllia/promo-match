// The photos of Macma and Easy Gifts: no feed links them, but Macma's downloads (data.promotray.de, no login) keep them
// in a ZIP file per brand under the names BILDNAME gives (docs/integrations.md, «Macma і Easy Gifts»). The files are
// 13 and 7 GB, so a photo is read by HTTP ranges: the end of the file and its directory once, then that entry alone,
// checked by its CRC. Read only.
import { crc32, inflateRawSync } from "node:zlib";
import { request, type HttpResult, type RequestOptions, type UrlFetch } from "../http.js";

export const ARCHIVE_ORIGIN = "https://data.promotray.de";
// The only files read, by source; their photos are addressed <file>/<entry> (archivePhotoUrl)
export const ARCHIVES = {
  macma: "/database_macma/jpg_database_macma.zip",
  easygifts: "/database_easy/jpg_database_easygifts.zip",
} as const;
export type ArchiveSource = keyof typeof ARCHIVES;
const ARCHIVE_PATHS = new Set<string>(Object.values(ARCHIVES));
const ENTRY_NAME = /^[\w.-]+\.jpe?g$/i;

// The end record, its ZIP64 locator and record, and a comment of up to 65 535 bytes all fit
const TAIL_BYTES = 70_000;
// 0.95 MB for 14 147 entries (Macma, 2026-11-05)
const MAX_DIRECTORY_BYTES = 16 * 1_048_576;
// A local header repeats the name and may carry another extra field than the directory says
const LOCAL_HEADER_SLACK = 1_024;
const INDEX_TIMEOUT_MS = 60_000;
const INDEX_ATTEMPTS = 3;
// The server keeps the directory this long; an entry read that meets another file (ETag, header, CRC) loads it again
const INDEX_MAX_AGE_MS = 6 * 3_600_000;
const PARTIAL_CONTENT = 206;
const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_END_SIZE = 56;
const DIRECTORY_SIGNATURE = 0x02014b50;
const DIRECTORY_HEADER_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_EXTRA = 0x0001;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;
const ENCRYPTED_FLAG = 0x1;
const UTF8_NAME_FLAG = 0x800;

export interface ArchiveEntry {
  offset: number;
  compressedSize: number;
  size: number;
  method: number;
  crc: number;
  isEncrypted: boolean;
}

export interface ArchiveIndex {
  etag: string | null;
  entries: Map<string, ArchiveEntry>;
  directoryBytes: number;
  loadedAtMs: number;
}

export interface DirectoryPlace {
  offset: number;
  size: number;
  count: number;
}

export type EntryAnswer = { kind: "ok"; bytes: Buffer } | { kind: "missing" };

// Not a ZIP this code reads, or an entry that cannot be taken out of it
export class ArchiveError extends Error {}

export function archivePhotoUrl(source: ArchiveSource, name: string): string {
  return `${ARCHIVE_ORIGIN}${ARCHIVES[source]}/${name}`;
}

// The file and entry of a photo address, or null for any other address
export function archivePhotoOf(url: URL): { path: string; name: string } | null {
  if (url.origin !== ARCHIVE_ORIGIN || url.search || url.hash || url.username || url.password) return null;
  const cut = url.pathname.lastIndexOf("/");
  const path = url.pathname.slice(0, cut);
  const name = url.pathname.slice(cut + 1);
  return ARCHIVE_PATHS.has(path) && ENTRY_NAME.test(name) ? { path, name } : null;
}

// Where the directory is, from the last bytes of the file; a ZIP64 file says it in a record before the end record,
// which may lie before the tail (then zip64RecordAt is its offset in the file)
export function endOfArchive(tail: Buffer, tailStart: number): DirectoryPlace | { zip64RecordAt: number } {
  let at = tail.length - END_SIZE;
  while (at >= 0 && !(tail.readUInt32LE(at) === END_SIGNATURE && at + END_SIZE + tail.readUInt16LE(at + 20) <= tail.length)) at -= 1;
  if (at < 0) throw new ArchiveError("no end of a ZIP file in its last bytes");
  const count = tail.readUInt16LE(at + 10);
  const size = tail.readUInt32LE(at + 12);
  const offset = tail.readUInt32LE(at + 16);
  if (count !== MAX_U16 && size !== MAX_U32 && offset !== MAX_U32) return { offset, size, count };
  const locator = at - ZIP64_LOCATOR_SIZE;
  if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) throw new ArchiveError("a ZIP64 file without its locator");
  const recordAt = Number(tail.readBigUInt64LE(locator + 8));
  return recordAt >= tailStart ? zip64Place(tail.subarray(recordAt - tailStart)) : { zip64RecordAt: recordAt };
}

export function zip64Place(record: Buffer): DirectoryPlace {
  if (record.length < ZIP64_END_SIZE || record.readUInt32LE(0) !== ZIP64_END_SIGNATURE) throw new ArchiveError("no ZIP64 end record");
  return { count: Number(record.readBigUInt64LE(32)), size: Number(record.readBigUInt64LE(40)), offset: Number(record.readBigUInt64LE(48)) };
}

// The sizes and the offset a directory header could not hold come in its ZIP64 field, in this order
function zip64Values(extra: Buffer, header: { size: number; compressedSize: number; offset: number }): typeof header {
  const result = { ...header };
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
    if (extra.readUInt16LE(at) !== ZIP64_EXTRA) continue;
    let value = at + 4;
    for (const key of ["size", "compressedSize", "offset"] as const) {
      if (result[key] !== MAX_U32) continue;
      if (value + 8 > extra.length) throw new ArchiveError("a ZIP64 field shorter than its header says");
      result[key] = Number(extra.readBigUInt64LE(value));
      value += 8;
    }
  }
  return result;
}

export function readDirectory(directory: Buffer, count: number): Map<string, ArchiveEntry> {
  const entries = new Map<string, ArchiveEntry>();
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + DIRECTORY_HEADER_SIZE > directory.length || directory.readUInt32LE(at) !== DIRECTORY_SIGNATURE) {
      throw new ArchiveError(`the directory ends at entry ${index + 1} of ${count}`);
    }
    const flags = directory.readUInt16LE(at + 8);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const nameStart = at + DIRECTORY_HEADER_SIZE;
    const name = directory.toString(flags & UTF8_NAME_FLAG ? "utf8" : "latin1", nameStart, nameStart + nameLength);
    const values = zip64Values(directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength), {
      size: directory.readUInt32LE(at + 24), compressedSize: directory.readUInt32LE(at + 20), offset: directory.readUInt32LE(at + 42),
    });
    entries.set(name, {
      ...values, method: directory.readUInt16LE(at + 10), crc: directory.readUInt32LE(at + 16),
      isEncrypted: Boolean(flags & ENCRYPTED_FLAG),
    });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The entry's bytes from a read that starts at its local header; null when the read was too short for its data
export function entryBytes(chunk: Buffer, name: string, entry: ArchiveEntry): Buffer | null {
  if (chunk.length < LOCAL_HEADER_SIZE || chunk.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ArchiveError(`${name}: no local header at its offset`);
  }
  const nameLength = chunk.readUInt16LE(26);
  if (chunk.toString("latin1", LOCAL_HEADER_SIZE, LOCAL_HEADER_SIZE + nameLength) !== Buffer.from(name).toString("latin1")) {
    throw new ArchiveError(`${name}: another entry at its offset`);
  }
  const start = LOCAL_HEADER_SIZE + nameLength + chunk.readUInt16LE(28);
  if (chunk.length < start + entry.compressedSize) return null;
  const data = chunk.subarray(start, start + entry.compressedSize);
  const bytes = entry.method === STORED ? data : inflated(data, name, entry.size);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new ArchiveError(`${name}: the bytes do not match its CRC`);
  return bytes;
}

function inflated(data: Buffer, name: string, size: number): Buffer {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
  } catch (error) {
    throw new ArchiveError(`${name}: not inflated (${error instanceof Error ? error.message : String(error)})`);
  }
}

function contentLength(answer: HttpResult): number {
  const total = /\/(\d+)$/.exec(answer.headers["content-range"] ?? "")?.[1];
  if (!total) throw new ArchiveError("a range answer without the file's length");
  return Number(total);
}

type ReadOptions = Pick<RequestOptions, "timeoutMs" | "maxAttempts" | "signal">;

export class ArchiveReader {
  private readonly indexes = new Map<string, Promise<ArchiveIndex>>();

  constructor(private readonly fetchUrl: UrlFetch = request, private readonly maxAgeMs = INDEX_MAX_AGE_MS) {}

  // The directory of a file, loaded once and shared by the reads at the same time
  async index(path: string, signal?: AbortSignal): Promise<ArchiveIndex> {
    const cached = this.indexes.get(path);
    if (cached) {
      const index = await cached;
      if (Date.now() - index.loadedAtMs < this.maxAgeMs) return index;
      if (this.indexes.get(path) === cached) this.indexes.delete(path);
    }
    let pending = this.indexes.get(path);
    if (!pending) {
      const loading = this.loadIndex(path, signal);
      // A failed load is not kept: the next read tries again
      loading.catch(() => {
        if (this.indexes.get(path) === loading) this.indexes.delete(path);
      });
      this.indexes.set(path, loading);
      pending = loading;
    }
    return pending;
  }

  // One entry; an answer from another version of the file (ETag, header, CRC) loads its directory again, once
  async read(path: string, name: string, options: ReadOptions & { maxBytes: number }): Promise<EntryAnswer> {
    if (!ARCHIVE_PATHS.has(path)) return { kind: "missing" };
    try {
      return await this.readOnce(path, name, options);
    } catch (error) {
      if (!(error instanceof StaleIndex)) throw error;
      this.indexes.delete(path);
      return this.readOnce(path, name, options);
    }
  }

  private async readOnce(path: string, name: string, options: ReadOptions & { maxBytes: number }): Promise<EntryAnswer> {
    const index = await this.index(path, options.signal);
    const entry = index.entries.get(name);
    if (!entry) return { kind: "missing" };
    if (entry.size > options.maxBytes) throw new ArchiveError(`${name} is ${entry.size} bytes, over ${options.maxBytes}`);
    if (entry.isEncrypted || (entry.method !== STORED && entry.method !== DEFLATED)) {
      throw new ArchiveError(`${name}: method ${entry.method}${entry.isEncrypted ? ", encrypted" : ""}`);
    }
    const length = LOCAL_HEADER_SIZE + Buffer.byteLength(name) + LOCAL_HEADER_SLACK + entry.compressedSize;
    let answer = await this.range(path, `${entry.offset}-${entry.offset + length - 1}`, length, options);
    if (index.etag && answer.headers.etag && answer.headers.etag !== index.etag) throw new StaleIndex();
    try {
      let bytes = entryBytes(answer.body, name, entry);
      if (!bytes) {
        // A local extra field longer than the slack: the read again, as long as the header says
        const start = LOCAL_HEADER_SIZE + answer.body.readUInt16LE(26) + answer.body.readUInt16LE(28);
        answer = await this.range(path, `${entry.offset}-${entry.offset + start + entry.compressedSize - 1}`, start + entry.compressedSize, options);
        bytes = entryBytes(answer.body, name, entry);
      }
      if (!bytes) throw new ArchiveError(`${name}: the answer is shorter than the entry`);
      return { kind: "ok", bytes };
    } catch (error) {
      if (error instanceof ArchiveError && index.etag === null) throw new StaleIndex();
      throw error;
    }
  }

  private async loadIndex(path: string, signal?: AbortSignal): Promise<ArchiveIndex> {
    const options = { timeoutMs: INDEX_TIMEOUT_MS, maxAttempts: INDEX_ATTEMPTS, signal };
    const tail = await this.range(path, `-${TAIL_BYTES}`, TAIL_BYTES, options);
    const tailStart = contentLength(tail) - tail.body.length;
    let place = endOfArchive(tail.body, tailStart);
    if ("zip64RecordAt" in place) {
      const at = place.zip64RecordAt;
      place = zip64Place((await this.range(path, `${at}-${at + ZIP64_END_SIZE - 1}`, ZIP64_END_SIZE, options)).body);
    }
    if (place.size > MAX_DIRECTORY_BYTES) throw new ArchiveError(`${path}: a directory of ${place.size} bytes`);
    const directory = place.size
      ? (await this.range(path, `${place.offset}-${place.offset + place.size - 1}`, place.size, options)).body : Buffer.alloc(0);
    return {
      etag: tail.headers.etag ?? null, entries: readDirectory(directory, place.count), directoryBytes: directory.length,
      loadedAtMs: Date.now(),
    };
  }

  private async range(path: string, bytes: string, maxBytes: number, options: ReadOptions): Promise<HttpResult> {
    const answer = await this.fetchUrl(new URL(path, ARCHIVE_ORIGIN), {
      ...options, method: "GET", headers: { Range: `bytes=${bytes}` }, maxBytes,
    });
    if (answer.status !== PARTIAL_CONTENT) throw new ArchiveError(`${path}: HTTP ${answer.status} to a range read`);
    return answer;
  }
}

// The file changed under its loaded directory
class StaleIndex extends Error {}

const MISSING = 404;
// Neither a block nor a peak (src/embeddings/image.ts, statusOutcome): the photo is marked failed
const UNREADABLE = 422;

// The embeddings worker's fetch for these photos (src/suppliers/registry.ts, photoFetchFor): the entry's bytes as an
// answer of 200, 404 for a name the file does not have, 422 for an entry that cannot be read; a network error is
// thrown as it is, so the photo waits for the next run
export function archivePhotoFetch(reader: ArchiveReader): UrlFetch {
  return async (url, options) => {
    const started = Date.now();
    const target = archivePhotoOf(url);
    let status = MISSING;
    let body: Buffer = Buffer.alloc(0);
    if (target) {
      try {
        const answer = await reader.read(target.path, target.name, options);
        if (answer.kind === "ok") {
          status = 200;
          body = answer.bytes;
        }
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        status = UNREADABLE;
      }
    }
    return { status, headers: {}, omittedHeaders: [], body, durationMs: Date.now() - started, attempts: 1, retries: [] };
  };
}
