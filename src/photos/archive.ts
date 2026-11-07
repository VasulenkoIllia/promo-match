// The photos of Macma and Easy Gifts through the server (src/photos/routes.ts): entries of a ZIP archive on
// data.promotray.de (src/suppliers/macma/archive.ts), which the browser cannot open. The bytes are not cached here: the
// browser keeps a photo for a day, and an entry is one range read of about 1 MB with no request limit known.
import { inspectImage, MAX_IMAGE_BYTES } from "../embeddings/image.js";
import { ARCHIVE_ORIGIN, archivePhotoOf, type ArchiveReader } from "../suppliers/macma/archive.js";
import type { SupplierPhotos } from "./proxy.js";

// A person waits for it: one attempt
const TIMEOUT_MS = 15_000;

// path is what follows the host in the photo's address: database_macma/jpg_database_macma.zip/1261803.jpg
export function createArchivePhotos(reader: ArchiveReader): SupplierPhotos {
  return {
    async read(path) {
      const address = `${ARCHIVE_ORIGIN}/${path}`;
      const target = URL.canParse(address) ? archivePhotoOf(new URL(address)) : null;
      if (!target) return { kind: "missing" };
      try {
        const answer = await reader.read(target.path, target.name, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES, maxAttempts: 1 });
        if (answer.kind === "missing") return answer;
        // The browser shows a photo of any size; the type comes from the bytes
        const info = inspectImage(answer.bytes, Number.POSITIVE_INFINITY);
        return typeof info === "string" ? { kind: "failed", reason: info } : { kind: "ok", bytes: answer.bytes, mimeType: info.mimeType };
      } catch (error) {
        return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
