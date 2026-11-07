// The input of the grades API (docs/integrations.md, «Оцінки»): the JSON schemas of src/grades/routes.ts. What the search
// said of the model comes back from the screen that showed it: the server keeps no searches.
import { ResultGradeValue } from "../generated/prisma/enums.js";
import { MAX_LIMIT, MAX_TEXT_CHARS, searchBodySchema, type SearchBody } from "../search/request.js";
import { LIST_NAMES, type ListName } from "../search/rank.js";

const MAX_ID = 2_147_483_647;
const MAX_PERCENT = 100;
const MAX_CODE_CHARS = 200;
const MAX_CONDITIONS = 10;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
// Postgres text cannot hold it: the insert would fail with a 500
const NO_NUL = "^[^\\u0000]*$";
const LIST_HIT = {
  type: "object",
  additionalProperties: false,
  required: ["rank", "similarity"],
  properties: { rank: { type: "integer", minimum: 1 }, similarity: { type: "number" } },
} as const;

export const gradeParamsSchema = {
  type: "object",
  required: ["searchId", "modelId"],
  properties: {
    searchId: { type: "string", pattern: UUID },
    modelId: { type: "integer", minimum: 1, maximum: MAX_ID },
  },
} as const;

export interface GradeParams {
  searchId: string;
  modelId: number;
}

export const gradeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["grade", "hasPhoto", "model", "filters", "rank", "lists"],
  properties: {
    grade: { type: "string", enum: Object.values(ResultGradeValue) },
    text: { type: "string", minLength: 1, maxLength: MAX_TEXT_CHARS, pattern: NO_NUL },
    hasPhoto: { type: "boolean" },
    model: searchBodySchema.properties.model,
    filters: searchBodySchema.properties.filters,
    rank: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    confidencePercent: { type: "integer", minimum: 0, maximum: MAX_PERCENT, nullable: true },
    lists: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(LIST_NAMES.map((name) => [name, LIST_HIT])),
    },
    conditionMatch: {
      type: "object",
      nullable: true,
      maxProperties: MAX_CONDITIONS,
      additionalProperties: { type: "string", enum: ["fits", "unknown", "against", null], nullable: true },
    },
    matchedCode: { type: "string", maxLength: MAX_CODE_CHARS, pattern: NO_NUL, nullable: true },
  },
} as const;

export interface GradeBody {
  grade: ResultGradeValue;
  // Left out: a search by photo alone
  text?: string;
  hasPhoto: boolean;
  model: NonNullable<SearchBody["model"]>;
  filters: NonNullable<SearchBody["filters"]>;
  rank: number;
  confidencePercent?: number | null;
  lists: Partial<Record<ListName, { rank: number; similarity: number }>>;
  conditionMatch?: Record<string, string | null> | null;
  matchedCode?: string | null;
}
