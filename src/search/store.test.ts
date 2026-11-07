import { describe, expect, it } from "vitest";

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { SearchTimedOut } from "./errors.js";
import {
  countCandidates, countCandidatesSql, filterOptions, type NearestQuery, nearestPhotosSql, nearestTextsSql,
  readNearestPhotos, sharedCategoryTree,
} from "./store.js";

describe("nearest queries", () => {
  it("name the model's partial index and cast as literals and pass the vector and filters as parameters", () => {
    const sql = nearestPhotosSql({
      model: "voyage-multimodal-3.5/1024", vector: [0.25, -0.5], limit: 288, freshRuns: { 1: 8, 2: 11 }, scan: "index",
      filters: { sources: ["axpol"], categories: [{ source: "axpol", path: ["DRINKWARE"] }], minStock: 500 },
    });
    expect(sql.text).toContain("e.embedding_model = 'voyage-multimodal-3.5/1024'");
    expect(sql.text).toContain("e.embedding::halfvec(1024) <=> $1::halfvec(1024)");
    expect(sql.values).toEqual(["[0.25,-0.5]", 3, 3, '["axpol"]', '[{"source":"axpol","path":["DRINKWARE"]}]', '{"1":8,"2":11}', 500, 288]);
  });

  it("take the shared categories as the ids of their categories, matched by the model's whole path", () => {
    const sql = nearestTextsSql({
      model: "gemini-embedding-2/1536", vector: [1], limit: 100, freshRuns: {}, filters: { sharedCategoryIds: [4, 7] },
      scan: "index",
    });
    expect(sql.text).toContain("sc.source_id = m.source_id AND sc.path = m.category->'en'");
    expect(sql.text).toContain("sc.category_id = ANY($2::integer[])");
    expect(sql.values).toEqual(["[1]", [4, 7], 100]);
  });

  it("let no model pass a shared category filter that resolved to no category", () => {
    const sql = nearestTextsSql({
      model: "gemini-embedding-2/1536", vector: [1], limit: 100, freshRuns: {}, filters: { sharedCategoryIds: [] },
      scan: "index",
    });
    expect(sql.text).toContain("FROM source_category sc");
    expect(sql.values).toEqual(["[1]", [], 100]);
  });

  it("leave out the filters not asked for", () => {
    const sql = nearestTextsSql({
      model: "gemini-embedding-2/1536", vector: [1], limit: 100, filters: {}, freshRuns: {}, scan: "index",
    });
    expect(sql.text).toContain("t.embedding::halfvec(1536) <=> $1::halfvec(1536)");
    expect(sql.text).not.toContain("jsonb_to_recordset");
    expect(sql.text).not.toContain("source_category");
    expect(sql.text).not.toContain("in_stock");
    expect(sql.values).toEqual(["[1]", 100]);
  });

  it("read a text variant's vectors only for the model that made them, and photos always of the model", () => {
    const query: NearestQuery = {
      model: "gemini-embedding-2/1536", textVariant: "gemini-embedding-2-brand-free/1536", vector: [1], limit: 100,
      filters: {}, freshRuns: {}, scan: "exact",
    };
    expect(nearestTextsSql(query).text).toContain("t.embedding_model = 'gemini-embedding-2-brand-free/1536'");
    expect(nearestTextsSql(query).text).toContain("t.embedding::halfvec(1536) <=> $1::halfvec(1536)");
    expect(countCandidatesSql("text", query, 20_000).text).toContain("t.embedding_model = 'gemini-embedding-2-brand-free/1536'");
    expect(nearestPhotosSql(query).text).toContain("e.embedding_model = 'gemini-embedding-2/1536'");
    expect(() => nearestTextsSql({ ...query, model: "voyage-multimodal-3.5/1024" })).toThrow("not text vectors of");
  });

  it("order an index list by the distance the index has, and rank every candidate of an exact one", () => {
    const query: NearestQuery = {
      model: "gemini-embedding-2/1536", vector: [1], limit: 288, freshRuns: {}, filters: { sharedCategoryIds: [4] },
      scan: "index",
    };
    expect(nearestPhotosSql(query).text).not.toContain("WITH");
    const exact = nearestPhotosSql({ ...query, scan: "exact" });
    expect(exact.text).toMatch(/WITH candidates AS MATERIALIZED \(SELECT p\.model_id[\s\S]*\)\s+SELECT \* FROM candidates ORDER BY distance LIMIT \$\d+$/);
    // The candidates themselves have no order, so nothing in them can go through the HNSW index
    expect(exact.text.match(/ORDER BY/g)).toHaveLength(1);
    expect(exact.values).toEqual(["[1]", 3, 3, [4], 288]);
  });
});

describe("countCandidates", () => {
  const query = { model: "voyage-multimodal-3.5/1024" as const, freshRuns: {}, filters: { sources: ["axpol"] } };

  it("counts a list's candidates under the same filters, stopping one past the limit asked", () => {
    const photos = countCandidatesSql("photo", query, 2880);
    expect(photos.text).toContain("FROM photo_embedding e");
    expect(photos.text).toContain("e.embedding_model = 'voyage-multimodal-3.5/1024'");
    expect(photos.text).toMatch(/LIMIT \$\d+\) c$/);
    expect(photos.values).toEqual([3, 3, '["axpol"]', 2881]);
    expect(countCandidatesSql("text", query, 1000).text).toContain("FROM text_embedding t");
  });

  it("reads the count with a statement timeout only, and refuses an answer without one", async () => {
    const asked: Prisma.Sql[] = [];
    const db = (answer: unknown[]) => ({
      $queryRaw: (sql: Prisma.Sql) => {
        asked.push(sql);
        return sql;
      },
      $transaction: () => Promise.resolve([[], answer]),
    }) as unknown as PrismaClient;
    await expect(countCandidates(db([{ candidates: 12 }]), "text", query, 1000)).resolves.toBe(12);
    expect(asked[0]?.text).toContain("statement_timeout");
    expect(asked[0]?.text).not.toContain("hnsw");
    await expect(countCandidates(db([]), "text", query, 1000)).rejects.toThrow("the count of text candidates returned");
  });
});

describe("readNearestPhotos", () => {
  const query: NearestQuery = {
    model: "gemini-embedding-2/1536", vector: [1], limit: 100, filters: {}, freshRuns: {}, scan: "index",
  };

  it("lets an exact list sort, and keeps the index settings for an index list", async () => {
    const settings: string[] = [];
    const db = {
      $queryRaw: (sql: Prisma.Sql) => sql,
      $transaction: ([first]: Prisma.Sql[]) => {
        settings.push(first?.text ?? "");
        return Promise.resolve([[], []]);
      },
    } as unknown as PrismaClient;
    await readNearestPhotos(db, query);
    await readNearestPhotos(db, { ...query, scan: "exact" });
    expect(settings[0]).toContain("set_config('enable_sort', 'off', true)");
    expect(settings[0]).toContain("hnsw.max_scan_tuples");
    expect(settings[1]).not.toContain("enable_sort");
    expect(settings[1]).toContain("statement_timeout");
  });
  const failingDb = (error: Error) => ({
    $queryRaw: (sql: Prisma.Sql) => sql, $transaction: () => Promise.reject(error),
  }) as unknown as PrismaClient;

  it("says a query past its statement timeout timed out, and passes other database errors on", async () => {
    const timedOut = new Prisma.PrismaClientKnownRequestError("canceling statement due to statement timeout", {
      code: "P2010", clientVersion: "7.10.0", meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
    });
    await expect(readNearestPhotos(failingDb(timedOut), query)).rejects.toThrow(SearchTimedOut);
    const missing = new Error("relation photo does not exist");
    await expect(readNearestPhotos(failingDb(missing), query)).rejects.toBe(missing);
  });
});

describe("sharedCategoryTree", () => {
  const name = (en: string) => ({ uk: en, en });

  it("puts the categories under their groups, which count their models", () => {
    expect(sharedCategoryTree([
      { code: "bags", groupCode: null, name: name("Bags"), models: 0 },
      { code: "drinkware", groupCode: null, name: name("Drinkware"), models: 0 },
      { code: "bags.backpacks", groupCode: "bags", name: name("Backpacks"), models: 250 },
      { code: "drinkware.mugs", groupCode: "drinkware", name: name("Mugs"), models: 94 },
      { code: "drinkware.bottles", groupCode: "drinkware", name: name("Bottles"), models: 0 },
      { code: "kids.plush", groupCode: "kids", name: name("Plush"), models: 3 },
    ])).toEqual([
      { code: "bags", name: name("Bags"), models: 250, categories: [{ code: "bags.backpacks", name: name("Backpacks"), models: 250 }] },
      { code: "drinkware", name: name("Drinkware"), models: 94, categories: [
        { code: "drinkware.mugs", name: name("Mugs"), models: 94 }, { code: "drinkware.bottles", name: name("Bottles"), models: 0 },
      ] },
    ]);
  });
});

describe("filterOptions", () => {
  const name = (en: string) => ({ uk: en, en });

  it("counts the paths' models into their categories, and lists the paths without one", () => {
    const options = filterOptions([{ code: "axpol", name: "Axpol", hasStock: true }], [
      { id: 1, code: "drinkware", groupCode: null, name: name("Drinkware") },
      { id: 2, code: "drinkware.mugs", groupCode: "drinkware", name: name("Mugs") },
    ], [
      { source: "axpol", path: ["DRINKWARE", "ceramic mugs"], categoryId: 2, models: 24 },
      { source: "axpol", path: ["DRINKWARE", "other mugs"], categoryId: 2, models: 16 },
      { source: "axpol", path: ["DRINKWARE", "drinking jars"], categoryId: null, models: 1 },
      { source: "axpol", path: null, categoryId: null, models: 2 },
    ]);
    expect(options.sharedCategories).toEqual([
      { code: "drinkware", name: name("Drinkware"), models: 40, categories: [{ code: "drinkware.mugs", name: name("Mugs"), models: 40 }] },
    ]);
    expect(options.categories.map((row) => row.path)).toEqual([
      ["DRINKWARE", "ceramic mugs"], ["DRINKWARE", "other mugs"], ["DRINKWARE", "drinking jars"],
    ]);
    expect(options.unmappedCategories).toEqual([
      { source: "axpol", path: ["DRINKWARE", "drinking jars"], models: 1 }, { source: "axpol", path: [], models: 2 },
    ]);
  });
});

describe("the hard filters of facts", () => {
  const sqlOf = (filters: Parameters<typeof countCandidatesSql>[1]["filters"]) =>
    countCandidatesSql("text", { model: "gemini-embedding-2/1536", filters, freshRuns: {} }, 10);

  it("adds nothing when none is asked for", () => {
    expect(sqlOf({}).sql).not.toMatch(/volume_ml|materials|sizes_cm/);
  });

  it("bounds the capacity, which an unknown one does not pass", () => {
    const query = sqlOf({ volumeMl: { min: 400, max: 900 } });
    expect(query.sql).toContain("m.volume_ml >=");
    expect(query.sql).toContain("m.volume_ml <=");
    expect(query.values).toEqual(expect.arrayContaining([400, 900]));
  });

  it("compares the first material with the asked one and its kinds", () => {
    const query = sqlOf({ materials: ["plastic"] });
    expect(query.sql).toContain("m.materials[1] = ANY(");
    const related = query.values.find(Array.isArray) as string[];
    expect(related).toEqual(expect.arrayContaining(["plastic", "tritan", "pet", "nonwoven"]));
    expect(related).not.toContain("stainless-steel");
  });

  it("lets no broader material stand for the asked one: a model that says only metal confirms no stainless steel", () => {
    const query = sqlOf({ materials: ["stainless-steel"] });
    expect(query.values.find(Array.isArray)).toEqual(["stainless-steel"]);
  });

  it("lets no imitation stand for leather", () => {
    const query = sqlOf({ materials: ["leather"] });
    expect(query.values.find(Array.isArray)).toEqual(["leather"]);
  });

  it("casts the capacity's bounds, or a bound with room around an exact number does not fit the integer column", () => {
    expect(sqlOf({ volumeMl: { min: 112.5, max: 137.5 } }).sql).toMatch(/m\.volume_ml >= \?::numeric[\s\S]*m\.volume_ml <= \?::numeric/);
  });

  it("compares sides longest first, and asks for a known size", () => {
    const query = sqlOf({ sizeCm: { min: [35, 30] } });
    expect(query.sql).toContain("cardinality(m.sizes_cm) > 0");
    expect(query.sql.match(/m\.sizes_cm\[/g)).toHaveLength(4);
    expect(query.values).toEqual(expect.arrayContaining([35, 30]));
  });
});
