import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config.js";
import { BudgetReached } from "../embeddings/batch.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { NO_CONDITIONS } from "./conditions.js";
import { ModelNotConfigured } from "./errors.js";
import type { QueryParse, QueryParser } from "./query-parse.js";
import type { Conditions } from "./query-parse-contract.js";
import { searchInput, type SearchInput } from "./request.js";
import { canTellCloseness, createSearchService, DailyBudget, exactMaxRows, QueryEmbedder } from "./search.js";
import { EXACT_MAX_ROWS } from "./store.js";

// config.ts reads DATABASE_URL on import; the search itself does not need it here
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, required: () => "" }));

describe("DailyBudget", () => {
  it("stops a call past the day's limit and starts again the next day", () => {
    let day = "2026-10-29";
    const budget = new DailyBudget(0.001, "SEARCH_BUDGET_USD", () => day);
    budget.reserve(0.0006);
    expect(() => budget.reserve(0.0006)).toThrow(BudgetReached);
    expect(() => budget.reserve(0.0006)).toThrow(/SEARCH_BUDGET_USD/);
    day = "2026-10-30";
    expect(() => budget.reserve(0.0006)).not.toThrow();
  });
});

function fakeProvider(name: string): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, name, dimensions: 2, maxImagesPerRequest: 1, maxTextsPerRequest: 1, maxImageBytesPerRequest: 1, maxImagePixels: 1,
    priceUsd: ({ imagePixels, textChars }) => imagePixels.length * 0.0001 + textChars * 0.000_001,
    embedImages: (_images, role) => {
      calls.push(`image ${role}`);
      return Promise.resolve({ vectors: [[1, 0]], usage: {} });
    },
    embedTexts: (texts, role) => {
      calls.push(`text ${role} ${texts[0]?.text}`);
      return Promise.resolve({ vectors: [[0, 1]], usage: {} });
    },
  };
}

const image = { bytes: Buffer.from("x"), info: { mimeType: "image/jpeg" as const, width: 10, height: 10 } };

describe("canTellCloseness", () => {
  const named = { status: "ok", products: ["washing machine"] } as unknown as QueryParse;
  const nothing = { status: "ok", products: [] } as unknown as QueryParse;

  it("tells for a text alone when the reading names a product", () => {
    expect(canTellCloseness({ filters: {} }, named)).toBe(true);
    expect(canTellCloseness({ filters: { sources: [] } }, named)).toBe(true);
  });

  it("stays silent on a query of a fact alone, an unread text or a photo", () => {
    expect(canTellCloseness({ filters: {} }, nothing)).toBe(false);
    expect(canTellCloseness({ filters: {} }, null)).toBe(false);
    expect(canTellCloseness({ filters: {}, image }, named)).toBe(false);
  });

  it("stays silent beside a filter of any kind", () => {
    expect(canTellCloseness({ filters: { minStock: 500 } }, named)).toBe(false);
    expect(canTellCloseness({ filters: { materials: ["glass"] } }, named)).toBe(false);
    expect(canTellCloseness({ filters: { volumeMl: { min: 500 } } }, named)).toBe(false);
  });
});

describe("QueryEmbedder", () => {
  it("embeds the text and the photo as queries, both priced together before the calls", async () => {
    const provider = fakeProvider("gemini-embedding-2/1536");
    const budget = new DailyBudget(1);
    const reserve = vi.spyOn(budget, "reserve");
    const embedder = new QueryEmbedder(budget, () => provider);
    const vectors = await embedder.embed("gemini-embedding-2/1536", { text: "red mug", image }, AbortSignal.timeout(1000));
    expect(vectors).toEqual({ image: [1, 0], text: [0, 1], priceUsd: reserve.mock.calls[0]?.[0] });
    expect(provider.calls.sort()).toEqual(["image query", "text query red mug"]);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]?.[0]).toBeCloseTo(0.000_107, 9);
  });

  it("makes neither call when the budget allows only one of them", async () => {
    const provider = fakeProvider("gemini-embedding-2/1536");
    const embedder = new QueryEmbedder(new DailyBudget(0.000_103), () => provider);
    await expect(embedder.embed("gemini-embedding-2/1536", { text: "red mug", image }, AbortSignal.timeout(1000)))
      .rejects.toThrow(BudgetReached);
    expect(provider.calls).toEqual([]);
  });

  it("stops the other call when one fails", async () => {
    let textSignal: AbortSignal | undefined;
    const provider: EmbeddingProvider = {
      ...fakeProvider("gemini-embedding-2/1536"),
      embedImages: () => Promise.reject(new Error("provider down")),
      embedTexts: (_texts, _role, signal) => {
        textSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const embedder = new QueryEmbedder(new DailyBudget(1), () => provider);
    await expect(embedder.embed("gemini-embedding-2/1536", { text: "mug", image }, AbortSignal.timeout(1000)))
      .rejects.toThrow("provider down");
    expect(textSignal?.aborted).toBe(true);
  });

  it("says a model without a key is not configured", async () => {
    const embedder = new QueryEmbedder(new DailyBudget(1), () => {
      throw new ConfigError("VOYAGE_API_KEY is not set");
    });
    expect(embedder.isConfigured("voyage-multimodal-3.5/1024")).toBe(false);
    await expect(embedder.embed("voyage-multimodal-3.5/1024", { text: "mug" }, AbortSignal.timeout(1000)))
      .rejects.toThrow(ModelNotConfigured);
  });

  it("refuses an unknown source before the paid call", async () => {
    const provider = fakeProvider("gemini-embedding-2/1536");
    const db = { $queryRaw: () => Promise.resolve([{ code: "axpol" }, { code: "midocean" }]) } as unknown as PrismaClient;
    const service = createSearchService(db, new QueryEmbedder(new DailyBudget(1), () => provider));
    const input = searchInput({
      text: "mug", filters: { sources: ["axpol"], categories: [{ source: "axpool", path: ["DRINKWARE"] }] },
    });
    await expect(service.search(input, AbortSignal.timeout(1000))).rejects.toThrow("unknown source: axpool");
    expect(provider.calls).toEqual([]);
  });

  type ByKind<T> = { photo: T; text: T };

  // A database that knows the source axpol, answers the code lookup with these rows and each count of candidates with
  // this many or this error (by the count's table), records the queries of the lists, and finds this many nearest
  // rows for a list, at most its LIMIT, or fails an exact list with exactError
  function categoryDb(rows: { code: string; categoryId: number | null }[],
    candidates: ByKind<number | Error> = { photo: 0, text: 0 }, found: ByKind<number> = { photo: 0, text: 0 },
    exactError?: Error) {
    const nearest: Prisma.Sql[] = [];
    const counts: Prisma.Sql[] = [];
    const kindOf = (query: Prisma.Sql) => (query.sql.includes("FROM photo_embedding") ? "photo" : "text");
    const db = {
      $queryRaw: (query: readonly string[] | Prisma.Sql) => {
        if (!(query instanceof Prisma.Sql)) {
          const text = query.join("");
          return Promise.resolve(text.includes("FROM category g") ? rows : text.includes("SELECT code FROM source") ? [{ code: "axpol" }] : []);
        }
        if (query.sql.includes("AS candidates")) {
          counts.push(query);
          const count = candidates[kindOf(query)];
          return count instanceof Error ? Promise.reject(count) : Promise.resolve([{ candidates: count }]);
        }
        if (!query.sql.includes("AS distance")) return Promise.resolve([]);
        nearest.push(query);
        if (exactError && query.sql.includes("MATERIALIZED")) return Promise.reject(exactError);
        const limit = Number(query.values.at(-1));
        return Promise.resolve(Array.from({ length: Math.min(found[kindOf(query)], limit) }, (_, index) => ({
          modelId: index + 1, photoId: index + 1, imageSha256: `${index}`, distance: 0.1,
        })));
      },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaClient;
    return { db, nearest, counts };
  }

  const drinkware = [{ code: "drinkware", categoryId: 4 }, { code: "drinkware", categoryId: 7 }];
  const embedder = () => new QueryEmbedder(new DailyBudget(1), () => fakeProvider("gemini-embedding-2/1536"));
  // limit 24: 288 photos and 100 texts
  const search = (db: PrismaClient, filters: SearchInput["filters"] = { sharedCategories: ["drinkware"] }) =>
    createSearchService(db, embedder()).search(searchInput({ text: "mug", limit: 24, filters }), AbortSignal.timeout(1000));
  const isExact = (query: Prisma.Sql | undefined) => query?.sql.includes("MATERIALIZED");

  it("fetches the same rows for any limit: a limit only cuts the ranking, so it keeps the order", async () => {
    const rowsFor = async (limit: number) => {
      const { db, nearest } = categoryDb(drinkware);
      await createSearchService(db, embedder()).search(searchInput({ text: "mug", limit, filters: { sharedCategories: ["drinkware"] } }), AbortSignal.timeout(1000));
      return nearest.map((query) => query.values.at(-1));
    };
    expect(await rowsFor(100)).toEqual(await rowsFor(12));
  });

  it("filters the nearest queries by the categories the codes stand for, each id once", async () => {
    const { db, nearest } = categoryDb([...drinkware, { code: "drinkware.mugs", categoryId: 4 }]);
    await search(db, { sharedCategories: ["drinkware", "drinkware.mugs"] });
    expect(nearest).toHaveLength(2);
    for (const query of nearest) expect(query.values).toContainEqual([4, 7]);
  });

  it("ranks a list exactly up to the most candidates, counted one past it, and through the index past that", async () => {
    const { db, nearest, counts } = categoryDb(drinkware, { photo: EXACT_MAX_ROWS, text: EXACT_MAX_ROWS + 1 });
    await search(db);
    // A category: up to EXACT_MAX_ROWS candidates for either kind
    expect(counts.map((query) => query.values.at(-1))).toEqual([EXACT_MAX_ROWS + 1, EXACT_MAX_ROWS + 1]);
    const [photos, texts] = nearest;
    expect(photos?.sql).toContain("FROM photo_embedding");
    expect(isExact(photos)).toBe(true);
    expect(texts?.sql).toContain("FROM text_embedding");
    expect(isExact(texts)).toBe(false);
  });

  it("counts each kind up to its own rows without a category", async () => {
    const { db, nearest, counts } = categoryDb([], { photo: 1_441, text: 500 });
    await search(db, { sources: ["axpol"] });
    expect(counts.map((query) => query.values.at(-1))).toEqual([1_441, 501]);
    expect(nearest.map(isExact)).toEqual([false, true]);
  });

  it("says the results are complete when an exact list finds fewer rows than asked and an index list fills its own", async () => {
    const { db } = categoryDb(drinkware, { photo: 5, text: EXACT_MAX_ROWS + 1 }, { photo: 5, text: 100 });
    expect((await search(db)).isComplete).toBe(true);
  });

  it("says the results may be incomplete when an index list stops one row short", async () => {
    const { db } = categoryDb(drinkware, { photo: 5, text: EXACT_MAX_ROWS + 1 }, { photo: 5, text: 99 });
    expect((await search(db)).isComplete).toBe(false);
  });

  const timedOut = new Prisma.PrismaClientKnownRequestError("canceling statement due to statement timeout", {
    code: "P2010", clientVersion: "7.10.0", meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
  });

  it("reads an exact list past its timeout through the index, and fails on any other error", async () => {
    const { db, nearest } = categoryDb(drinkware, { photo: 5, text: EXACT_MAX_ROWS + 1 }, { photo: 5, text: 100 }, timedOut);
    const response = await search(db);
    expect(nearest.map((query) => [query.sql.includes("FROM photo_embedding"), isExact(query)]))
      .toEqual([[true, true], [false, false], [true, false]]);
    // The photo list through the index found 5 of its 288 rows
    expect(response.isComplete).toBe(false);
    const lost = new Error("connection lost");
    await expect(search(categoryDb(drinkware, { photo: 5, text: 5 }, { photo: 5, text: 5 }, lost).db)).rejects.toBe(lost);
  });

  it("leaves a list to the index when its count runs past its timeout, and fails on any other error", async () => {
    const { db, nearest } = categoryDb(drinkware, { photo: timedOut, text: 5 }, { photo: 288, text: 5 });
    const response = await search(db);
    expect(nearest.map(isExact)).toEqual([false, true]);
    expect(response.isComplete).toBe(true);
    const lost = new Error("connection lost");
    await expect(search(categoryDb(drinkware, { photo: lost, text: 5 }).db)).rejects.toBe(lost);
  });

  it("ranks exactly without a category only when few candidates pass for the rows asked", () => {
    expect(exactMaxRows({ sharedCategoryIds: [4] }, 288)).toBe(EXACT_MAX_ROWS);
    expect(exactMaxRows({ categories: [{ source: "axpol", path: ["DRINKWARE"] }] }, 100)).toBe(EXACT_MAX_ROWS);
    expect(exactMaxRows({ sources: ["axpol"], minStock: 500 }, 288)).toBe(1_440);
    expect(exactMaxRows({}, 100)).toBe(500);
    expect(exactMaxRows({ minStock: 1 }, 1_000)).toBe(5_000);
  });

  it("refuses codes that stand for no category before the paid call", async () => {
    const provider = fakeProvider("gemini-embedding-2/1536");
    const { db } = categoryDb([{ code: "drinkware", categoryId: null }]);
    const service = createSearchService(db, new QueryEmbedder(new DailyBudget(1), () => provider));
    const input = searchInput({ text: "mug", filters: { sharedCategories: ["drinkware"] } });
    await expect(service.search(input, AbortSignal.timeout(1000))).rejects.toThrow("no categories in the shared category drinkware");
    expect(provider.calls).toEqual([]);
  });

  it("refuses a shared category the list does not have before the paid call", async () => {
    const provider = fakeProvider("gemini-embedding-2/1536");
    const db = {
      $queryRaw: (strings: readonly string[]) => Promise.resolve(strings.join("").includes("FROM category g")
        ? [{ code: "drinkware", categoryId: 4 }, { code: "drinkware", categoryId: 7 }] : []),
    } as unknown as PrismaClient;
    const service = createSearchService(db, new QueryEmbedder(new DailyBudget(1), () => provider));
    const input = searchInput({ text: "mug", filters: { sharedCategories: ["drinkware", "drinkware.cups", "toys"] } });
    await expect(service.search(input, AbortSignal.timeout(1000))).rejects.toThrow("unknown shared category: drinkware.cups, toys");
    expect(provider.calls).toEqual([]);
  });

  describe("with a code in the text", () => {
    const codeDb = {
      $queryRaw: (query: readonly string[] | Prisma.Sql) => {
        const sql = query instanceof Prisma.Sql ? query.sql : query.join("");
        if (sql.includes("lower(m.code)")) {
          return Promise.resolve([{ key: "it3787-09", modelId: 7, label: "midocean IT3787", isModelCode: false }]);
        }
        if (sql.includes("SELECT m.id FROM product_model")) return Promise.resolve([{ id: 7 }]);
        return Promise.resolve(sql.includes("AS candidates") ? [{ candidates: 0 }] : []);
      },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaClient;
    const parser = (texts: string[], englishText: string | null): Pick<QueryParser, "parse"> => ({
      parse: (text) => {
        texts.push(text);
        return Promise.resolve({
          status: "ok", model: "claude-haiku-5-5", englishText, products: englishText ? [englishText] : [],
          conditions: englishText ? [NO_CONDITIONS] : [], dropped: [], usage: null,
          suggestedFilters: { sharedCategories: [], colors: [], materials: [], price: null },
        });
      },
    });
    const searchText = (text: string, matchCodes?: boolean, englishText: string | null = "red bag") => {
      const provider = fakeProvider("gemini-embedding-2/1536");
      const texts: string[] = [];
      const service = createSearchService(codeDb, new QueryEmbedder(new DailyBudget(1), () => provider), parser(texts, englishText));
      const response = service.search(searchInput({ text, filters: {}, matchCodes }), AbortSignal.timeout(1000));
      return { provider, texts, response };
    };

    it("embeds no words Claude finds no product in beside a code", async () => {
      const { provider, texts, response } = searchText("Artikelnummer: IT3787-09", undefined, null);
      expect((await response).lists).toEqual([]);
      expect(texts).toEqual(["Artikelnummer:"]);
      expect(provider.calls).toEqual([]);
    });

    it("pays for nothing when the text is codes alone", async () => {
      const { provider, texts, response } = searchText("IT3787-09");
      const { lists, queryParse, costUsd } = await response;
      expect([lists, queryParse, costUsd]).toEqual([[], null, 0]);
      expect([provider.calls, texts]).toEqual([[], []]);
    });

    it("lets Claude and the embedding read the text without the code", async () => {
      const { provider, texts, response } = searchText("IT3787-09 in rot");
      await response;
      expect(texts).toEqual(["in rot"]);
      expect(provider.calls).toEqual(["text query red bag"]);
    });

    it("leaves the code in the text for the quality test", async () => {
      const { texts, response } = searchText("IT3787-09 in rot", false);
      await response;
      expect(texts).toEqual(["IT3787-09 in rot"]);
    });
  });

  describe("with the text read by Claude", () => {
    const englishParse: QueryParse = {
      status: "ok", model: "claude-haiku-5-5", englishText: "red ceramic mug", products: ["red ceramic mug"],
      conditions: [{ ...NO_CONDITIONS, materials: ["ceramic"] }],
      suggestedFilters: { sharedCategories: ["drinkware.mugs"], colors: ["red"], materials: ["ceramic"], price: null },
      dropped: [], usage: { inputTokens: 900, outputTokens: 40 },
    };
    const fakeParser = (answer: QueryParse) => {
      const texts: string[] = [];
      const parser: Pick<QueryParser, "parse"> = {
        parse: (text) => {
          texts.push(text);
          return Promise.resolve(answer);
        },
      };
      return { parser, texts };
    };
    const run = (parser: Pick<QueryParser, "parse">, input: Omit<Parameters<typeof searchInput>[0], "filters">) => {
      const provider = fakeProvider("gemini-embedding-2/1536");
      const service = createSearchService(categoryDb([]).db, new QueryEmbedder(new DailyBudget(1), () => provider), parser);
      return { provider, response: service.search(searchInput({ ...input, filters: {} }), AbortSignal.timeout(1000)) };
    };

    it("adds what the vectors and Claude's reading cost, and nothing for a reading kept from before", async () => {
      const { parser } = fakeParser(englishParse);
      const vectorUsd = "red ceramic mug".length * 0.000_001;
      const readUsd = (900 * 0.1 + 40 * 0.5) / 1_000_000;
      expect((await run(parser, { text: "чашка" }).response).costUsd).toBeCloseTo(vectorUsd + readUsd, 12);
      const kept = fakeParser({ ...englishParse, usage: null }).parser;
      expect((await run(kept, { text: "чашка" }).response).costUsd).toBeCloseTo(vectorUsd, 12);
    });

    it("counts every product's vector and the photo's", async () => {
      const { parser } = fakeParser({ ...englishParse, products: ["mug", "pen"], usage: null });
      const vectorsUsd = (3 + 3) * 0.000_001 + 0.0001;
      expect((await run(parser, { text: "чашка і ручка", image }).response).costUsd).toBeCloseTo(vectorsUsd, 12);
    });

    it("embeds the English text and returns the parse with its suggestions, applied to nothing", async () => {
      const { parser, texts } = fakeParser(englishParse);
      const { provider, response } = run(parser, { text: "червона керамічна чашка" });
      expect((await response).queryParse).toEqual(englishParse);
      expect(texts).toEqual(["червона керамічна чашка"]);
      expect(provider.calls).toEqual(["text query red ceramic mug"]);
    });

    it("embeds each product of the text on its own", async () => {
      const two = {
        ...englishParse, englishText: "thermo mug; plastic bottle", products: ["thermo mug", "plastic bottle"],
        conditions: [NO_CONDITIONS, NO_CONDITIONS],
      } as QueryParse;
      const { provider, response } = run(fakeParser(two).parser, { text: "термочашки й пластикові пляшки" });
      await response;
      expect(provider.calls.toSorted()).toEqual(["text query plastic bottle", "text query thermo mug"]);
    });

    it("embeds the text as it is when Claude was unavailable", async () => {
      const unavailable: QueryParse = {
        status: "unavailable", model: "claude-haiku-5-5", reason: "provider-failed", message: "HTTP 529 overloaded_error",
      };
      const { provider, response } = run(fakeParser(unavailable).parser, { text: "червона чашка" });
      expect((await response).queryParse).toEqual(unavailable);
      expect((await response).costUsd).toBeCloseTo("червона чашка".length * 0.000_001, 12);
      expect(provider.calls).toEqual(["text query червона чашка"]);
    });

    it("embeds the text as it is when it names nothing of the product, keeping the suggestions", async () => {
      const priceOnly = {
        ...englishParse, englishText: null, products: [], conditions: [],
        suggestedFilters: { sharedCategories: [], colors: [], materials: [], price: { min: null, max: 100, currency: "UAH" } },
      } as QueryParse;
      const { provider, response } = run(fakeParser(priceOnly).parser, { text: "до 100 грн" });
      expect((await response).queryParse).toEqual(priceOnly);
      expect(provider.calls).toEqual(["text query до 100 грн"]);
    });

    describe("beside a photo, a text that only names a category", () => {
      const word = {
        ...englishParse, englishText: "mug", products: ["mug"], conditions: [NO_CONDITIONS],
        suggestedFilters: { sharedCategories: ["drinkware.mugs"], colors: [], materials: [], price: null },
      } as QueryParse;

      it("adds no lists and no paid text", async () => {
        const { provider, response } = run(fakeParser(word).parser, { text: "чашка", image });
        const { lists, queryParse } = await response;
        expect(lists).toEqual(["image-photo", "image-text"]);
        expect(queryParse).toEqual(word);
        expect(provider.calls).toEqual(["image query"]);
      });

      it("keeps its lists with the rule off, without a photo, and for a text with a trait of its own", async () => {
        const allLists = ["image-photo", "image-text", "text-photo", "text-text"];
        const off = run(fakeParser(word).parser, { text: "чашка", image, categoryLift: null });
        expect((await off.response).lists).toEqual(allLists);
        const trait = run(fakeParser(englishParse).parser, { text: "червона чашка", image });
        expect((await trait.response).lists).toEqual(allLists);
        const textAlone = run(fakeParser(word).parser, { text: "чашка" });
        expect((await textAlone.response).lists).toEqual(["text-photo", "text-text"]);
      });
    });

    describe("what the cards say of the conditions", () => {
      interface FactRow {
        id: number; volumeMl: number | null; materials: string[]; sizesCm: number[]; printTechniques: string[]; sheets: number | null;
        gsm: number | null;
      }

      const thermoVector = "[1,1]";
      // Each product's phrase is its own vector, so a list of a product finds its own models
      const factsProvider = (): EmbeddingProvider => ({
        ...fakeProvider("gemini-embedding-2/1536"),
        embedTexts: (texts) => Promise.resolve({ vectors: [texts[0]?.text === "thermo mug" ? [1, 1] : [0, 1]], usage: {} }),
      });
      // A database whose text list finds byVector[the query's vector], best first, or `fitting` under a volume filter,
      // whose photo list finds nothing, and which records each read of the facts and of a text list
      const factsDb = (byVector: Record<string, number[]>, rows: FactRow[], fitting: number[] = []) => {
        const factReads: number[][] = [];
        const textReads: Prisma.Sql[] = [];
        const db = {
          $queryRaw: (query: readonly string[] | Prisma.Sql, ...values: unknown[]) => {
            const sql = query instanceof Prisma.Sql ? query.sql : query.join("");
            if (sql.includes("AS candidates")) return Promise.resolve([{ candidates: 0 }]);
            if (sql.includes("volume_ml AS")) {
              factReads.push(values[0] as number[]);
              return Promise.resolve(rows);
            }
            if (sql.includes("\"sourceName\"")) {
              return Promise.resolve(rows.map(({ id }) => ({
                id, sourceCode: "axpol", sourceName: "Axpol", code: `M${id}`, name: `Mug ${id}`, category: [], coverPhotoUrl: null,
              })));
            }
            if (!(query instanceof Prisma.Sql) || !sql.includes("t.embedding")) return Promise.resolve([]);
            textReads.push(query);
            const found = sql.includes("m.volume_ml") ? fitting
              : Object.entries(byVector).find(([vector]) => query.values.includes(vector))?.[1] ?? [];
            return Promise.resolve(found.map((modelId, index) => ({ modelId, distance: 0.1 * (index + 1) })));
          },
          $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
        } as unknown as PrismaClient;
        return { db, factReads, textReads };
      };
      const answer = (conditions: Conditions[], products = ["red ceramic mug"]) =>
        ({ ...englishParse, products, conditions }) as QueryParse;
      const searchModels = (db: PrismaClient, parse: QueryParse) => {
        const embedder = new QueryEmbedder(new DailyBudget(1), factsProvider);
        return createSearchService(db, embedder, fakeParser(parse).parser)
          .search(searchInput({ text: "чашка", filters: {} }), AbortSignal.timeout(1000));
      };
      const over800 = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
      const row = (id: number, volumeMl: number | null): FactRow =>
        ({ id, volumeMl, materials: [], sizesCm: [], printTechniques: [], sheets: null, gsm: null });
      const rows = [row(1, 300), row(2, null), row(3, 900)];
      const text = { "[0,1]": [1, 2, 3] };

      it("says fits, unknown and against by the catalogue", async () => {
        const { results } = await searchModels(factsDb(text, rows).db, answer([over800]));
        expect(results.map((result) => [result.modelId, result.conditionMatch?.volumeMl])).toEqual([[1, "against"], [2, "unknown"], [3, "fits"]]);
      });

      it("leaves the order and the scores as they were, whatever the catalogue says of the conditions", async () => {
        const asked = await searchModels(factsDb(text, rows).db, answer([over800]));
        const plain = await searchModels(factsDb(text, rows).db, answer([NO_CONDITIONS]));
        expect(asked.results.map(({ rank, modelId, score }) => ({ rank, modelId, score })))
          .toEqual(plain.results.map(({ rank, modelId, score }) => ({ rank, modelId, score })));
        expect(asked.results.map((result) => result.modelId)).toEqual([1, 2, 3]);
      });

      it("reads the facts of the models shown once, and nothing when the query has no conditions", async () => {
        const asked = factsDb(text, rows);
        await searchModels(asked.db, answer([over800]));
        expect(asked.factReads).toEqual([[1, 2, 3]]);
        const plain = factsDb(text, rows);
        const { results } = await searchModels(plain.db, answer([NO_CONDITIONS]));
        expect(plain.factReads).toEqual([]);
        expect(results.map((result) => result.conditionMatch)).toEqual([null, null, null]);
      });

      it("holds a model to the product whose list gave it its place", async () => {
        const db = factsDb({ [thermoVector]: [1, 2], "[0,1]": [3, 2] }, [row(1, 900), row(2, 300), row(3, 300)]).db;
        const { results } = await searchModels(db, answer([over800, NO_CONDITIONS], ["thermo mug", "plastic bottle"]));
        expect(results.map((result) => [result.modelId, result.conditionMatch?.volumeMl ?? null]))
          .toEqual([[1, "fits"], [3, null], [2, "against"]]);
      });

      describe("with the second pass over the models that fit", () => {
        const passing = { weight: 1, hasMaterials: false, hasPrint: false };
        const searchPassing = (db: PrismaClient, parse: QueryParse, filters: SearchInput["filters"] = {}) =>
          createSearchService(db, new QueryEmbedder(new DailyBudget(1), factsProvider), fakeParser(parse).parser)
            .search(searchInput({ text: "чашка", filters, conditionPass: passing }), AbortSignal.timeout(1000));
        const idsOf = (results: { modelId: number }[]) => results.map(({ modelId }) => modelId);
        const allRows = [...rows, row(4, 1000)];

        it("lifts a model that fits and brings in one the lists did not find, leaving out none", async () => {
          const { results } = await searchPassing(factsDb(text, allRows, [4, 3]).db, answer([over800]));
          expect(idsOf(results)).toEqual([3, 1, 4, 2]);
          expect(results.find((result) => result.modelId === 4)?.conditionMatch?.volumeMl).toBe("fits");
        });

        it("gives no vote to a model the filter let past that a card would not call fitting", async () => {
          const { results } = await searchPassing(factsDb(text, allRows, [2, 3]).db, answer([over800]));
          expect(idsOf(results)).toEqual([3, 1, 2]);
        });

        it("reads no second list when the query asks nothing the pass holds", async () => {
          const steel = { ...NO_CONDITIONS, materials: ["stainless-steel" as const] };
          const plain = factsDb(text, allRows, [4]);
          await searchPassing(plain.db, answer([NO_CONDITIONS]));
          expect(plain.textReads).toHaveLength(1);
          const material = factsDb(text, allRows, [4]);
          await searchPassing(material.db, answer([steel]));
          expect(material.textReads).toHaveLength(1);
        });

        it("reads no second list beside a fact the screen asks for", async () => {
          const filtered = factsDb(text, allRows, [3]);
          const { results } = await searchPassing(filtered.db, answer([over800]), { volumeMl: { min: 900 } });
          expect(filtered.textReads).toHaveLength(1);
          expect(idsOf(results)).toEqual([3]);
        });

        it("reads no second list by default, as the screen's switch is off, or when a run turns the pass off", async () => {
          for (const conditionPass of [undefined, null]) {
            const off = factsDb(text, allRows, [4]);
            const service = createSearchService(off.db, new QueryEmbedder(new DailyBudget(1), factsProvider), fakeParser(answer([over800])).parser);
            const { results } = await service.search(searchInput({ text: "чашка", filters: {}, conditionPass }), AbortSignal.timeout(1000));
            expect(off.textReads).toHaveLength(1);
            expect(idsOf(results)).toEqual([1, 2, 3]);
          }
        });

        it("holds each product to its own conditions, the first pass of the other as it was", async () => {
          const db = factsDb({ [thermoVector]: [1, 2], "[0,1]": [3, 2] }, allRows, [4]).db;
          const { results } = await searchPassing(db, answer([over800, NO_CONDITIONS], ["thermo mug", "plastic bottle"]));
          expect(idsOf(results)).toEqual([1, 3, 4, 2]);
        });
      });
    });

    it("refuses a model without its key before Claude is paid for", async () => {
      const { parser, texts } = fakeParser(englishParse);
      const embedder = new QueryEmbedder(new DailyBudget(1), () => {
        throw new ConfigError("VOYAGE_API_KEY is not set");
      });
      const service = createSearchService(categoryDb([]).db, embedder, parser);
      const input = searchInput({ text: "чашка", model: "voyage-multimodal-3.5/1024", filters: {} });
      await expect(service.search(input, AbortSignal.timeout(1000))).rejects.toThrow(ModelNotConfigured);
      expect(texts).toEqual([]);
    });

    it("reads nothing when the parse is off or no list uses the text", async () => {
      const { parser, texts } = fakeParser(englishParse);
      const off = run(parser, { text: "червона чашка", parseQuery: false });
      expect((await off.response).queryParse).toBeNull();
      expect(off.provider.calls).toEqual(["text query червона чашка"]);
      const photoOnly = run(parser, { text: "червона чашка", image, lists: ["image-photo"] });
      expect((await photoOnly.response).queryParse).toBeNull();
      expect(photoOnly.provider.calls).toEqual(["image query"]);
      expect(texts).toEqual([]);
    });
  });

  it("refuses a provider of another model than the vectors were made by", () => {
    const embedder = new QueryEmbedder(new DailyBudget(1), () => fakeProvider("voyage-multimodal-3.5/1024"));
    expect(() => embedder.provider("gemini-embedding-2/1536")).toThrow(/the provider of gemini-embedding-2\/1536 is voyage/);
  });

  it("offers the screen Gemini alone: Voyage has the vectors of two suppliers, and stays for the API and the CLI", async () => {
    const db = { $queryRaw: () => Promise.resolve([]) } as unknown as PrismaClient;
    const service = createSearchService(db, new QueryEmbedder(new DailyBudget(1), () => fakeProvider("gemini-embedding-2/1536")));
    expect((await service.options()).models.map((model) => model.name)).toEqual(["gemini-embedding-2/1536"]);
  });
});
