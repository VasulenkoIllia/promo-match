// The input of a search (stage 4), the same for the API (src/search/routes.ts) and the CLI (scripts/search.ts): a
// reference photo, a text or both, the embedding model, filters and how many models to return. The API's body is
// checked by the JSON schema below first; parseSearchBody then reads what the schema cannot (the image itself).
import { CATEGORY_CODE_PATTERN } from "../categories/codes.js";
import { type ImageInfo, inspectImage } from "../embeddings/image.js";
import { MATERIAL_CODES } from "../suppliers/materials.js";
import { CONDITION_PASS, type ConditionPass } from "./condition-pass.js";
import type { Demotion } from "./conditions.js";
import { SearchInputError } from "./errors.js";
import { DEFAULT_SEARCH_MODEL, SEARCH_MODEL_NAMES, type SearchModelName } from "./models.js";
import { LIST_NAMES, type ListName } from "./rank.js";
import type { SearchFilters } from "./store.js";
import type { SearchTuning } from "./tuning.js";

const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;
export const MAX_TEXT_CHARS = 1_000;
// The web app of stage 5 crops and shrinks the photo first; a phone photo as it is still fits
export const MAX_QUERY_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_QUERY_IMAGE_BYTES / 3) * 4;
const DATA_URL_PREFIX = /^data:image\/(?:jpeg|png);base64,/;
// Room for the base64 image and the rest of the body
export const SEARCH_BODY_LIMIT_BYTES = MAX_IMAGE_BASE64_CHARS + 64 * 1024;
const MAX_SOURCE_FILTERS = 50;
const MAX_CATEGORY_FILTERS = 50;
const MAX_CATEGORY_DEPTH = 5;
const MAX_NAME_CHARS = 200;
const MAX_MIN_STOCK = 10_000_000;
const MAX_VOLUME_ML = 1_000_000;
const MAX_SIDE_CM = 100_000;
const MAX_SIDES = 3;
// A source's code (source.code, e.g. "axpol"): its shape here, whether the database knows it in the search
// (src/search/search.ts, checkSources). The codes are not imported from src/suppliers/registry.ts, which reads the
// environment on import.
const SOURCE_CODE = { type: "string", pattern: "^[a-z0-9_-]{1,40}$" } as const;
const SIDES = {
  type: "array", minItems: 1, maxItems: MAX_SIDES, items: { type: "number", exclusiveMinimum: 0, maximum: MAX_SIDE_CM },
} as const;

// The reference photo, in memory only: never written to the database, a log or a file
export interface QueryImage {
  bytes: Buffer;
  info: ImageInfo;
}

export interface SearchInput {
  text?: string;
  image?: QueryImage;
  model: SearchModelName;
  filters: SearchFilters;
  limit: number;
  // Which lists to fuse (src/search/rank.ts); by default every list the inputs allow. For the quality test (stage 8).
  lists?: ListName[];
  // Claude reads the text first (src/search/query-parse.ts); false embeds it as it is, for the quality test too
  parseQuery: boolean;
  // A code in the text is looked up first (src/search/codes.ts); false leaves it to the lists, for the quality test: a hit
  // by the code itself would say nothing of the search
  matchCodes: boolean;
  // How far a model falls for what the query asks of it (src/search/conditions.ts); by default DEFAULT_DEMOTION. For the
  // independent test.
  demotion?: Demotion;
  // What a text beside a photo does when it only names a category (src/search/category-word.ts); by default
  // DEFAULT_CATEGORY_LIFT. For the independent test.
  categoryLift?: number | null;
  // The lists again over the models that fit what the query asks (src/search/condition-pass.ts): CONDITION_PASS from the
  // screen's switch (conditionPass true in the body), the independent test's own settings, or off (undefined, null)
  conditionPass?: ConditionPass | null;
  // What a run of the independent test tries on the ranking (src/search/tuning.ts); off by default
  tuning?: Partial<SearchTuning>;
}

export const searchBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: MAX_TEXT_CHARS },
    // Base64 of a JPEG or PNG, or a data URL of one
    image: { type: "string", minLength: 1, maxLength: MAX_IMAGE_BASE64_CHARS + 32 },
    model: { type: "string", enum: SEARCH_MODEL_NAMES },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    parseQuery: { type: "boolean" },
    // The second pass over the models whose catalogue confirms what the query asks; off when left out
    conditionPass: { type: "boolean" },
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        // An empty list would mean no filter while it reads as "none": a filter not wanted is left out
        sources: { type: "array", items: SOURCE_CODE, minItems: 1, maxItems: MAX_SOURCE_FILTERS, uniqueItems: true },
        categories: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CATEGORY_FILTERS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["source", "path"],
            properties: {
              source: SOURCE_CODE,
              path: {
                type: "array", minItems: 1, maxItems: MAX_CATEGORY_DEPTH,
                items: { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS },
              },
            },
          },
        },
        // Codes of the shared category list: "drinkware" (a group) or "drinkware.mugs"
        sharedCategories: {
          type: "array", minItems: 1, maxItems: MAX_CATEGORY_FILTERS, uniqueItems: true,
          items: { type: "string", pattern: CATEGORY_CODE_PATTERN, maxLength: MAX_NAME_CHARS },
        },
        minStock: { type: "integer", minimum: 1, maximum: MAX_MIN_STOCK },
        volumeMl: {
          type: "object", additionalProperties: false, minProperties: 1,
          properties: {
            min: { type: "number", minimum: 0, maximum: MAX_VOLUME_ML }, max: { type: "number", minimum: 0, maximum: MAX_VOLUME_ML },
          },
        },
        materials: {
          type: "array", minItems: 1, maxItems: MATERIAL_CODES.length, uniqueItems: true,
          items: { type: "string", enum: MATERIAL_CODES },
        },
        // Sides in centimetres, longest first
        sizeCm: {
          type: "object", additionalProperties: false, minProperties: 1, properties: { min: SIDES, max: SIDES },
        },
      },
    },
  },
} as const;

export interface SearchBody {
  text?: string;
  image?: string;
  model?: SearchModelName;
  limit?: number;
  parseQuery?: boolean;
  conditionPass?: boolean;
  filters?: SearchFilters;
}

// The photo's type and size come from its bytes (src/embeddings/image.ts), never from a name or a header
export function queryImage(bytes: Buffer): QueryImage {
  if (!bytes.length) throw new SearchInputError("the image is empty");
  if (bytes.length > MAX_QUERY_IMAGE_BYTES) {
    throw new SearchInputError(`the image is ${bytes.length} bytes, over ${MAX_QUERY_IMAGE_BYTES}`);
  }
  const info = inspectImage(bytes);
  if (typeof info === "string") throw new SearchInputError(`the image cannot be used: ${info}`);
  return { bytes, info };
}

function decodeBase64(text: string): Buffer {
  const base64 = text.replace(DATA_URL_PREFIX, "");
  // Buffer.from skips characters outside the alphabet; such an image is refused rather than read in part
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new SearchInputError("the image is not base64");
  return Buffer.from(base64, "base64");
}

// Every list the inputs allow, or the lists asked for when each has its input
export function listsFor(input: Pick<SearchInput, "text" | "image" | "lists">): ListName[] {
  const allowed = LIST_NAMES.filter((name) => (name.startsWith("image-") ? input.image : input.text) !== undefined);
  if (!input.lists) return allowed;
  const missing = input.lists.filter((name) => !allowed.includes(name));
  if (missing.length) throw new SearchInputError(`no input for the lists ${missing.join(", ")}`);
  return LIST_NAMES.filter((name) => input.lists?.includes(name));
}

export function searchInput(input: Omit<SearchInput, "model" | "limit" | "parseQuery" | "matchCodes"> & Partial<SearchInput>):
  SearchInput {
  const text = input.text?.replaceAll(/\s+/g, " ").trim() || undefined;
  if (!text && !input.image) throw new SearchInputError("give a text, an image or both");
  const result: SearchInput = {
    ...input, text, model: input.model ?? DEFAULT_SEARCH_MODEL, limit: input.limit ?? DEFAULT_LIMIT,
    parseQuery: input.parseQuery ?? true, matchCodes: input.matchCodes ?? true,
  };
  listsFor(result);
  return result;
}

export function parseSearchBody(body: SearchBody): SearchInput {
  return searchInput({
    text: body.text,
    image: body.image === undefined ? undefined : queryImage(decodeBase64(body.image)),
    model: body.model,
    limit: body.limit,
    parseQuery: body.parseQuery,
    conditionPass: body.conditionPass ? CONDITION_PASS : null,
    filters: body.filters ?? {},
  });
}
