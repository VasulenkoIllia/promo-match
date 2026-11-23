// Each search setting on the search itself (src/search/settings.ts, search.ts): what it reads, pays for and ranks
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { NO_CONDITIONS } from "./conditions.js";
import { SearchInputError } from "./errors.js";
import type { QueryParse, QueryParser } from "./query-parse.js";
import type { Conditions } from "./query-parse-contract.js";
import { searchInput, type SearchInput } from "./request.js";
import { createSearchService, DailyBudget, QueryEmbedder } from "./search.js";
import { CODE_DEFAULT_SETTINGS, type SearchSettings, settingsInput } from "./settings.js";

// config.ts reads DATABASE_URL on import; the search itself does not need it here
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, required: () => "" }));

const IMAGE_VECTOR = "[1,0]";

// The image's vector and the text's differ, so a list knows which input it compares
function fakeProvider(): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, name: "gemini-embedding-2/1536", dimensions: 2, maxImagesPerRequest: 1, maxTextsPerRequest: 1, maxImageBytesPerRequest: 1,
    maxImagePixels: 1, priceUsd: () => 0,
    embedImages: () => {
      calls.push("image");
      return Promise.resolve({ vectors: [[1, 0]], usage: {} });
    },
    embedTexts: (texts) => {
      calls.push(`text ${texts[0]?.text}`);
      return Promise.resolve({ vectors: [[0, 1]], usage: {} });
    },
  };
}

interface Catalogue {
  // Each list's models, best first
  lists: { imagePhoto?: number[]; imageText?: number[]; textPhoto?: number[]; textText?: number[] };
  colors?: Record<number, string[]>;
  materials?: Record<number, string[]>;
  inCategory?: number[];
}

// A database whose nearest queries find the catalogue's lists, and which knows its models' colours, materials and the
// category drinkware.mugs (id 4)
function fakeDb({ lists, colors = {}, materials = {}, inCategory = [] }: Catalogue): PrismaClient {
  const ids = [...new Set(Object.values(lists).flat())];
  const nearest = (sql: string, values: unknown[]) => {
    const isPhoto = sql.includes("FROM photo_embedding");
    const isImage = values.includes(IMAGE_VECTOR);
    const found = (isPhoto ? (isImage ? lists.imagePhoto : lists.textPhoto) : (isImage ? lists.imageText : lists.textText)) ?? [];
    return found.map((modelId, index) => (isPhoto
      ? { modelId, photoId: modelId * 10, imageSha256: `p${modelId}`, distance: 0.1 + index / 100 }
      : { modelId, distance: 0.1 + index / 100 }));
  };
  const answer = (sql: string, values: unknown[]): unknown[] => {
    if (sql.includes("AS candidates")) return [{ candidates: 0 }];
    if (sql.includes("AS distance")) return nearest(sql, values);
    if (sql.includes("\"sourceName\"")) {
      return ids.map((id) => ({ id, sourceCode: "axpol", sourceName: "Axpol", code: `M${id}`, name: `Mug ${id}`, category: [], coverPhotoUrl: null }));
    }
    if (sql.includes("array_agg(DISTINCT v.color")) return Object.entries(colors).map(([modelId, names]) => ({ modelId: Number(modelId), colors: names }));
    if (sql.includes("volume_ml AS")) {
      return ids.map((id) => ({ id, volumeMl: null, materials: materials[id] ?? [], sizesCm: [], printTechniques: [], sheets: null, gsm: null }));
    }
    if (sql.includes("FROM category g")) return [{ code: "drinkware.mugs", categoryId: 4 }];
    if (sql.includes("source_category sc")) return inCategory.map((id) => ({ id }));
    return [];
  };
  return {
    $queryRaw: (query: readonly string[] | Prisma.Sql, ...values: unknown[]) => Promise.resolve(query instanceof Prisma.Sql
      ? answer(query.sql, query.values) : answer(query.join(""), values)),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
  } as unknown as PrismaClient;
}

const image = { bytes: Buffer.from("x"), info: { mimeType: "image/jpeg" as const, width: 10, height: 10 } };

function reading(products: string[], suggested: { colors?: string[]; sharedCategories?: string[] } = {},
  conditions: Conditions = NO_CONDITIONS): QueryParse {
  return {
    status: "ok", model: "claude-haiku-5-5", englishText: products.join("; "), products, conditions: products.map(() => conditions),
    suggestedFilters: { sharedCategories: [], colors: [], materials: [], price: null, ...suggested } as never, dropped: [], usage: null,
  };
}

function run(catalogue: Catalogue, input: Pick<SearchInput, "text" | "image">, settings: Partial<SearchSettings> = {},
  parse: QueryParse = reading(["red mug"])) {
  const provider = fakeProvider();
  const texts: string[] = [];
  const parser: Pick<QueryParser, "parse"> = {
    parse: (text) => {
      texts.push(text);
      return Promise.resolve(parse);
    },
  };
  const service = createSearchService(fakeDb(catalogue), new QueryEmbedder(new DailyBudget(1), () => provider), parser);
  const searched = searchInput({ ...input, filters: {}, ...settingsInput({ ...CODE_DEFAULT_SETTINGS, ...settings }) });
  return { provider, texts, response: service.search(searched, AbortSignal.timeout(1000)) };
}

const idsOf = async ({ response }: ReturnType<typeof run>) => (await response).results.map((result) => result.modelId);

// The photo list against the three others
const disagreeing: Catalogue = { lists: { imagePhoto: [1, 2, 3, 4], imageText: [4, 3, 2, 1], textPhoto: [4, 3, 2, 1], textText: [4, 3, 2, 1] } };
const both = { text: "червона чашка", image };

describe("the code's defaults", () => {
  it("rank as the search did before the switches", async () => {
    const before = createSearchService(fakeDb(disagreeing), new QueryEmbedder(new DailyBudget(1), fakeProvider), {
      parse: () => Promise.resolve(reading(["red mug"])),
    });
    const old = await before.search(searchInput({ ...both, filters: {} }), AbortSignal.timeout(1000));
    const now = await run(disagreeing, both).response;
    expect(now.results.map(({ modelId, score, lists }) => ({ modelId, score, lists })))
      .toEqual(old.results.map(({ modelId, score, lists }) => ({ modelId, score, lists })));
    expect(now.results.map((result) => result.modelId)).toEqual([4, 3, 2, 1]);
  });
});

describe("«Порядок, коли є фото»", () => {
  it("lets the photo-to-photo list order the results when it weighs more or decides", async () => {
    expect(await idsOf(run(disagreeing, both))).toEqual([4, 3, 2, 1]);
    expect(await idsOf(run(disagreeing, both, { photoOrder: "photo-heavier" }))).toEqual([1, 2, 3, 4]);
    expect(await idsOf(run(disagreeing, both, { photoOrder: "photo-decides" }))).toEqual([1, 2, 3, 4]);
  });

  it("puts what the photo did not find after what it found when it decides", async () => {
    const catalogue = { lists: { imagePhoto: [1, 2], imageText: [3], textPhoto: [3], textText: [3] } };
    expect(await idsOf(run(catalogue, both))).toEqual([3, 1, 2]);
    expect(await idsOf(run(catalogue, both, { photoOrder: "photo-decides" }))).toEqual([1, 2, 3]);
  });
});

describe("the lists", () => {
  it("reads no list turned off: the photo against the model texts", async () => {
    const search = run(disagreeing, both, { hasImageTextList: false });
    expect((await search.response).lists).toEqual(["image-photo", "text-photo", "text-text"]);
  });

  it("reads one text list without the other", async () => {
    expect((await run(disagreeing, both, { hasTextPhotoList: false }).response).lists).toEqual(["image-photo", "image-text", "text-text"]);
    expect((await run(disagreeing, both, { hasTextTextList: false }).response).lists).toEqual(["image-photo", "image-text", "text-photo"]);
  });

  it("neither reads nor pays for the text when both text lists are off", async () => {
    const search = run(disagreeing, both, { hasTextPhotoList: false, hasTextTextList: false });
    expect((await search.response).lists).toEqual(["image-photo", "image-text"]);
    expect(search.provider.calls).toEqual(["image"]);
    expect(search.texts).toEqual([]);
  });

  it("refuses a query whose every list is off before anything is paid for", async () => {
    const search = run(disagreeing, { text: "червона чашка" }, { hasTextPhotoList: false, hasTextTextList: false });
    await expect(search.response).rejects.toThrow(SearchInputError);
    await expect(search.response).rejects.toThrow("the search settings turn off every list of this query: text-photo, text-text");
    expect(search.provider.calls).toEqual([]);
    expect(search.texts).toEqual([]);
  });
});

describe("«Читати запит через AI»", () => {
  it("embeds the text as it is without Claude", async () => {
    const search = run(disagreeing, { text: "червона чашка" }, { isParseQuery: false });
    expect((await search.response).queryParse).toBeNull();
    expect(search.texts).toEqual([]);
    expect(search.provider.calls).toEqual(["text червона чашка"]);
  });
});

// Model 2 a little above model 1 by the text alone
const close: Catalogue = { lists: { textPhoto: [2, 1], textText: [2, 1] } };
const text = { text: "червона чашка" };
const scoreOf = async (search: ReturnType<typeof run>, modelId: number) =>
  (await search.response).results.find((result) => result.modelId === modelId)?.score ?? 0;

describe("«Піднімати названий колір»", () => {
  const red = { ...close, colors: { 1: ["Red"], 2: ["Black"] } };
  const parse = reading(["mug"], { colors: ["red"] });

  it("lifts the model of the colour asked by its level, and not at all when off", async () => {
    expect(await idsOf(run(red, text, { colorLift: "off" }, parse))).toEqual([2, 1]);
    expect(await idsOf(run(red, text, {}, parse))).toEqual([1, 2]);
    const off = await scoreOf(run(red, text, { colorLift: "off" }, parse), 1);
    expect(await scoreOf(run(red, text, {}, parse), 1)).toBeCloseTo(off * 1.1, 5);
    expect(await scoreOf(run(red, text, { colorLift: "strong" }, parse), 1)).toBeCloseTo(off * 1.5, 5);
  });
});

describe("«Піднімати названу категорію»", () => {
  it("lifts the models of the category a reader suggests by its level", async () => {
    const mugs = { ...close, inCategory: [1] };
    const parse = reading(["mug with a logo"], { sharedCategories: ["drinkware.mugs"] });
    expect(await idsOf(run(mugs, text, { categoryLift: "off" }, parse))).toEqual([2, 1]);
    expect(await idsOf(run(mugs, text, {}, parse))).toEqual([1, 2]);
    const off = await scoreOf(run(mugs, text, { categoryLift: "off" }, parse), 1);
    expect(await scoreOf(run(mugs, text, { categoryLift: "strong" }, parse), 1)).toBeCloseTo(off * 1.5, 5);
  });

  it("drops the lists of a text beside a photo that only names the category and lifts it, or treats it as any text when off", async () => {
    const mugs = { lists: { imagePhoto: [2, 1], imageText: [2, 1], textPhoto: [1], textText: [1] }, inCategory: [1] };
    const parse = reading(["mug"], { sharedCategories: ["drinkware.mugs"] });
    const weak = run(mugs, both, {}, parse);
    expect((await weak.response).lists).toEqual(["image-photo", "image-text"]);
    const off = await run(mugs, both, { categoryLift: "off" }, parse).response;
    expect(off.lists).toEqual(["image-photo", "image-text", "text-photo", "text-text"]);
    const plain = 1 / 62 + 1 / 62;
    expect(await scoreOf(weak, 1)).toBeCloseTo(plain * 3, 5);
    expect(await scoreOf(run(mugs, both, { categoryLift: "strong" }, parse), 1)).toBeCloseTo(plain * 5, 5);
  });
});

describe("«Опускати те, що запит виключає»", () => {
  it("sinks a model of the colour ruled out, and keeps its place when off", async () => {
    const black = { ...close, colors: { 1: ["Red"], 2: ["Black"] } };
    const parse = reading(["mug"], {}, { ...NO_CONDITIONS, excludedColors: ["black"] });
    expect(await idsOf(run(black, text, {}, parse))).toEqual([1, 2]);
    expect(await idsOf(run(black, text, { isExclusionSink: false }, parse))).toEqual([2, 1]);
  });
});
