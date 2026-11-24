// Reduced copies of the catalogue photos (owner's decision 2026-11-24, docs/decisions.md): the embeddings run makes one
// from the bytes it downloads for the vector, and the screen shows it from this server instead of the supplier's link,
// which is slow at times or gives no photo (feedback item 12, docs/requirements.md). A file per picture, named by the
// sha256 of the supplier's bytes, in PHOTO_STORE_DIR on a volume of its own: derived data that a run makes again, so it
// is in no backup (docs/integrations.md, «Сховище зменшених фото»).
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// The longest side: a card is 230 px wide, 460 at twice the density (owner's decision 2026-11-24)
export const THUMB_SIDE = 480;
const WEBP_QUALITY = 80;
export const STORED_PHOTO_PATH = "/api/photos/stored/";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_PATTERN = /^([0-9a-f]{64})\.webp$/;
// Files go into folders by the first two characters: 256 folders of under a thousand files each at 200 thousand photos
const FOLDER_CHARS = 2;
// Files checked at once by missingThumbs: tens of thousands per source in a few seconds
const CHECK_CONCURRENCY = 64;

// A PNG is decoded whole (a JPEG shrinks on load): 120 million pixels are about 0.5 GB, and the worker has 2 GB. The
// largest catalogue photo seen is 10417×10417 (Easy Gifts, 2026-11-05); past the bound the copy fails and the photo is
// marked failed.
const MAX_COPY_PIXELS = 120_000_000;

// The worker makes copies one page after another: libvips' own cache would only hold memory
sharp.cache(false);

// A failure of the store itself (a full or read-only disk, a folder not writable): the run stops, for every source alike
export class PhotoStoreError extends Error {}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Only a sha256 names a file: no other text reaches a path
export function thumbFile(storeDir: string, sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`not a sha256: ${JSON.stringify(sha256.slice(0, 80))}`);
  return path.join(storeDir, sha256.slice(0, FOLDER_CHARS), `${sha256}.webp`);
}

// The screen's address of a copy; null for none, or for a value that is no sha256
export function thumbUrl(sha256: string | null): string | null {
  return sha256 !== null && SHA256_PATTERN.test(sha256) ? `${STORED_PHOTO_PATH}${sha256}.webp` : null;
}

// The sha256 a file name of the route names, or null: nothing but <sha256>.webp reaches the disk
export function shaOfName(name: string): string | null {
  return FILE_PATTERN.exec(name)?.[1] ?? null;
}

// Turned by the photo's EXIF, at most THUMB_SIDE on its longer side, never enlarged; transparency stays (the card is
// white). Throws for bytes libvips cannot read.
export async function makeThumb(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { failOn: "error", limitInputPixels: MAX_COPY_PIXELS })
    .rotate()
    .resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

// The folder is there and the worker may write into it: checked before a run downloads anything
export async function checkStore(storeDir: string): Promise<void> {
  try {
    await mkdir(storeDir, { recursive: true });
    await access(storeDir, constants.W_OK);
  } catch (error) {
    throw new PhotoStoreError(`PHOTO_STORE_DIR ${storeDir} is not writable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// The copy of the picture with this sha256, made unless its file is there already (the same picture under another
// photo). Written next to its place and renamed, so a reader never gets half a file. Null once the copy is there, the
// reason when libvips cannot read the bytes; a disk that refuses the write throws.
export async function storeThumb(storeDir: string, sha256: string, bytes: Buffer): Promise<string | null> {
  const file = thumbFile(storeDir, sha256);
  if (await exists(file).catch((error: unknown) => {
    throw new PhotoStoreError(`${file} not readable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  })) return null;
  let thumb: Buffer;
  try {
    thumb = await makeThumb(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(partial, thumb);
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new PhotoStoreError(`reduced copy not written to ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error });
  }
  return null;
}

// The copy's bytes, or null when there is none; an empty file (a crash between write and rename) counts as none
export async function readThumb(storeDir: string, sha256: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(thumbFile(storeDir, sha256));
    return bytes.length ? bytes : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// Of these sha256, those with no file in the store: copies the database marks while their files are gone (a volume lost
// or not mounted when they were made), so a run makes them again
export async function missingThumbs(storeDir: string, sha256s: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const unique = [...new Set(sha256s)];
  for (let start = 0; start < unique.length; start += CHECK_CONCURRENCY) {
    const batch = unique.slice(start, start + CHECK_CONCURRENCY);
    const found = await Promise.all(batch.map((sha256) => exists(thumbFile(storeDir, sha256))));
    batch.forEach((sha256, index) => {
      if (!found[index]) missing.add(sha256);
    });
  }
  return missing;
}
