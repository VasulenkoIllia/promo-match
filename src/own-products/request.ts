// The input of the own products API (stage 6): the JSON schemas of src/own-products/routes.ts, then what they cannot
// check. Ids are integer columns: past the bound the database would fail instead of answering that nothing is there.
import { OwnProductLinkType } from "../generated/prisma/enums.js";
import { MAX_LIMIT } from "../search/request.js";
import { OwnProductInputError } from "./errors.js";

const MAX_ID = 2_147_483_647;
const MAX_NAME_CHARS = 200;
const MAX_CODE_CHARS = 60;
// Postgres text cannot hold it: the insert would fail with a 500
const NO_NUL = "^[^\\u0000]*$";
const ID = { type: "integer", minimum: 1, maximum: MAX_ID } as const;

export const ownProductBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", maxLength: MAX_NAME_CHARS, pattern: NO_NUL },
    code: { type: "string", maxLength: MAX_CODE_CHARS, pattern: NO_NUL },
  },
} as const;

export interface OwnProductBody {
  name: string;
  code?: string;
}

export const linkParamsSchema = {
  type: "object",
  required: ["ownProductId", "modelId"],
  properties: { ownProductId: ID, modelId: ID },
} as const;

export interface LinkParams {
  ownProductId: number;
  modelId: number;
}

export const linkBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: { type: { type: "string", enum: Object.values(OwnProductLinkType) } },
} as const;

export interface LinkBody {
  type: OwnProductLinkType;
}

// ?modelIds=1&modelIds=2: the models a search shows, at most its limit
export const modelLinksQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["modelIds"],
  properties: { modelIds: { type: "array", items: ID, minItems: 1, maxItems: MAX_LIMIT } },
} as const;

export interface ModelLinksQuery {
  modelIds: number[];
}

export interface NewOwnProduct {
  name: string;
  code: string | null;
}

function tidied(text: string | undefined): string {
  return text?.replaceAll(/\s+/g, " ").trim() ?? "";
}

export function parseOwnProduct(body: OwnProductBody): NewOwnProduct {
  const name = tidied(body.name);
  if (!name) throw new OwnProductInputError("give the product a name");
  return { name, code: tidied(body.code) || null };
}
