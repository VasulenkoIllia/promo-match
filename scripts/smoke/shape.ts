import { isRecord } from "../../src/suppliers/normalize.js";
import { REDACTED, scrub } from "../../src/suppliers/secrets.js";

// What the smoke test keeps from a supplier response: its shape (paths, types, sizes), the first records and
// nothing secret.
export interface FieldShape {
  // $ is the response, [] an array item, {id} a record of an object keyed by id (Axpol's data)
  path: string;
  // How many times each type was seen here: string, empty (""), number, boolean, null, object, array
  types: Record<string, number>;
  // Smallest and largest array or id-keyed object seen here
  minSize?: number;
  maxSize?: number;
  example?: string;
}

// Records walked per array or id-keyed object: enough for the optional fields, bounded on a full dump
const MAX_ITEMS_PER_LEVEL = 2_000;
const MAX_EXAMPLE_CHARS = 120;
const MAX_SAMPLE_STRING_CHARS = 2_000;
// A login answer keeps its token near the top
const SECRET_SEARCH_DEPTH = 3;
// signedUrl: Midocean's presigned S3 links carry temporary AWS credentials; access and refresh: the JWT pair of Blue
// Collection's token answer
const SECRET_KEY = /jwt|token|password|secret|api.?key|signed.?url|^access$|^refresh$/i;
const ID_KEY = /^\d+$/;
const IMAGE_PATH = /\.(?:jpe?g|png|webp)$/i;


// Axpol returns records as an object keyed by productId, not as an array
export function isIdMap(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => ID_KEY.test(key));
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === "") return "empty";
  return typeof value;
}

// Scrubbed before the cut: a secret across the cut would otherwise stay as a prefix
function cut(text: string, maxChars: number, secrets: readonly string[]): string {
  const clean = scrub(text, secrets);
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
}

// Values under secret-looking keys (the JWT of a login answer), so they are scrubbed wherever else they appear
export function secretValues(value: unknown, depth = SECRET_SEARCH_DEPTH): string[] {
  if (depth < 0 || !isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    SECRET_KEY.test(key) && typeof item === "string" ? [item] : secretValues(item, depth - 1));
}

export function describeShape(root: unknown, secrets: readonly string[] = []): FieldShape[] {
  const fields = new Map<string, FieldShape>();
  const visit = (value: unknown, path: string, isSecret: boolean): void => {
    const type = typeOf(value);
    let field = fields.get(path);
    if (!field) {
      field = { path, types: {} };
      fields.set(path, field);
    }
    field.types[type] = (field.types[type] ?? 0) + 1;
    const isMap = isIdMap(value);
    const items = Array.isArray(value) ? value : isMap ? Object.values(value) : undefined;
    if (items) {
      field.minSize = Math.min(field.minSize ?? items.length, items.length);
      field.maxSize = Math.max(field.maxSize ?? items.length, items.length);
      const itemPath = isMap ? `${path}.{id}` : `${path}[]`;
      for (const item of items.slice(0, MAX_ITEMS_PER_LEVEL)) visit(item, itemPath, isSecret);
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`, isSecret || SECRET_KEY.test(key));
    } else if (field.example === undefined && type !== "empty" && type !== "null") {
      field.example = isSecret ? REDACTED : cut(String(value), MAX_EXAMPLE_CHARS, secrets);
    }
  };
  visit(root, "$", false);
  return [...fields.values()];
}

// Records in a response: a root array, Axpol's data keyed by productId, or the only array of a root object
export function countRecords(body: unknown): number | undefined {
  if (Array.isArray(body)) return body.length;
  if (!isRecord(body)) return undefined;
  if (isIdMap(body.data)) return Object.keys(body.data).length;
  const arrays = Object.values(body).filter((value): value is unknown[] => Array.isArray(value));
  return arrays.length === 1 ? arrays[0]?.length : undefined;
}

// An https link whose path, not query, ends in a picture extension: only such a link is opened by the photo probe
function isImageLink(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    return IMAGE_PATH.test(new URL(value).pathname);
  } catch {
    // Not a URL at all, so not a picture link
    return false;
  }
}

// The first picture link of a feed, in record order, for the photo probe: where a supplier keeps it differs
export function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return isImageLink(value) ? value : undefined;
  const items = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const item of items) {
    const url = firstImageUrl(item);
    if (url) return url;
  }
  return undefined;
}

// The first records at every level, long texts cut, values under secret-looking keys replaced
export function sampleOf(value: unknown, limit: number, secrets: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.slice(0, limit).map((item) => sampleOf(item, limit, secrets));
  if (isRecord(value)) {
    const entries = isIdMap(value) ? Object.entries(value).slice(0, limit) : Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, item]) => [key, SECRET_KEY.test(key) ? REDACTED : sampleOf(item, limit, secrets)]),
    );
  }
  if (typeof value === "string" && value.length > MAX_SAMPLE_STRING_CHARS) {
    return cut(value, MAX_SAMPLE_STRING_CHARS, secrets);
  }
  return value;
}
