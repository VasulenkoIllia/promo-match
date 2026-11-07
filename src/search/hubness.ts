// A candidate correction of the lists for hubs, source-blind (report «Критичний аналіз пошуку 2026-11-06», section 1,
// outside git). An item close to everything is a hub: a model text whose name only says the kind ("Ball pen"), or a
// large studio photo, stands near any query of its kind, and the sources write and shoot differently. A list then ranks
// by similarity minus alpha × the item's mean similarity to the nearest items of other models on the query's side: the
// photos for the reference photo's lists, the texts for the text's (CSLS, Conneau et al. 2018). A model in a photo list
// ranks by its best photo after the correction. Only the order within a list moves: the similarities stay for the
// confidence and the closeness bound. Off unless a run of the independent test asks for it (README «Незалежний тест»).
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { IN_SCOPE, IN_SEARCH } from "../embeddings/store.js";
import type { SearchModelName } from "./models.js";
import { type ListEntry, type ListName, tieOrder } from "./rank.js";
import { indexSql } from "./store.js";

// The neighbours a score averages, as in the report's model
const HUB_NEIGHBOURS = 10;
// Items scored per statement, two index reads each: Prisma gives up on a transaction after 5 s
const BATCH_ITEMS = 100;
const STATEMENT_TIMEOUT = "4s";
const EF_SEARCH = 100;
const MAX_SCAN_TUPLES = 20_000;

// An item's mean similarity to the nearest photos of other models, and to their texts: by model id for a text, by photo
// id for a photo
export interface HubScores {
  toPhotos: Map<number, number>;
  toTexts: Map<number, number>;
}

export interface Hubness {
  model: SearchModelName;
  // 0 leaves those lists as they are
  textAlpha: number;
  photoAlpha: number;
  texts: HubScores;
  photos: HubScores;
}

function scoreOf(scores: Map<number, number>, id: number, what: string): number {
  const score = scores.get(id);
  if (score === undefined) throw new Error(`no hub score for ${what} ${id}`);
  return score;
}

// The list again in the corrected order, ranks from 1. Every item has its scores when they are read at a run's start, so
// one without is embedded since: the search fails rather than rank it unscored, above every hub.
export function correctHubs(name: ListName, entries: ListEntry[], hubness: Hubness): ListEntry[] {
  const isPhotoList = name.endsWith("-photo");
  const alpha = isPhotoList ? hubness.photoAlpha : hubness.textAlpha;
  if (!alpha) return entries;
  const side = isPhotoList ? hubness.photos : hubness.texts;
  const scores = name.startsWith("image-") ? side.toPhotos : side.toTexts;
  return entries.map((entry) => {
    const score = isPhotoList
      ? Math.max(...entry.photos.map((photo) => photo.similarity - alpha * scoreOf(scores, photo.photoId, "the photo")))
      : entry.similarity - alpha * scoreOf(scores, entry.modelId, "the text of model");
    return { entry, score };
  }).sort((left, right) => right.score - left.score || tieOrder(left.entry.modelId) - tieOrder(right.entry.modelId))
    .map(({ entry }, index) => ({ ...entry, rank: index + 1 }));
}

interface HubRow {
  id: number;
  toPhotos: number | null;
  toTexts: number | null;
}

// The nearest neighbours through the index, as the search's index lists read them (src/search/store.ts, scanSettings)
function hubSettings(): Prisma.Sql {
  return Prisma.sql`SELECT set_config('hnsw.ef_search', ${String(EF_SEARCH)}, true),
    set_config('hnsw.iterative_scan', 'relaxed_order', true),
    set_config('hnsw.max_scan_tuples', ${String(MAX_SCAN_TUPLES)}, true),
    set_config('enable_sort', 'off', true),
    set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
}

// The two scores of each item of a batch (columns id, model_id, embedding): the photos and texts compared are those a
// search with no filter reads
function scoresSql(model: SearchModelName, batch: Prisma.Sql): Prisma.Sql {
  const { name, cast } = indexSql(model);
  return Prisma.sql`
    WITH batch AS (${batch})
    SELECT b.id,
      (SELECT avg(1 - x.distance) FROM (
        SELECT e.embedding::${cast} <=> b.embedding::${cast} AS distance
        FROM photo_embedding e JOIN photo p ON p.id = e.photo_id JOIN product_model m ON m.id = p.model_id
        WHERE e.embedding_model = ${name} AND ${IN_SCOPE} AND ${IN_SEARCH} AND p.model_id <> b.model_id
        ORDER BY e.embedding::${cast} <=> b.embedding::${cast} LIMIT ${HUB_NEIGHBOURS}) x)::float8 AS "toPhotos",
      (SELECT avg(1 - y.distance) FROM (
        SELECT u.embedding::${cast} <=> b.embedding::${cast} AS distance
        FROM text_embedding u JOIN product_model m ON m.id = u.model_id
        WHERE u.embedding_model = ${name} AND m.is_active AND u.model_id <> b.model_id
        ORDER BY u.embedding::${cast} <=> b.embedding::${cast} LIMIT ${HUB_NEIGHBOURS}) y)::float8 AS "toTexts"
    FROM batch b ORDER BY b.id`;
}

// The next texts of the model after a model id
export function textScoresSql(model: SearchModelName, afterId: number): Prisma.Sql {
  return scoresSql(model, Prisma.sql`
    SELECT t.model_id AS id, t.model_id, t.embedding FROM text_embedding t
    WHERE t.embedding_model = ${indexSql(model).name} AND t.model_id > ${afterId}
    ORDER BY t.model_id LIMIT ${BATCH_ITEMS}`);
}

// The next photos a search reads after a photo id
export function photoScoresSql(model: SearchModelName, afterId: number): Prisma.Sql {
  return scoresSql(model, Prisma.sql`
    SELECT p.id, p.model_id, e.embedding FROM photo_embedding e
    JOIN photo p ON p.id = e.photo_id JOIN product_model m ON m.id = p.model_id
    WHERE e.embedding_model = ${indexSql(model).name} AND ${IN_SCOPE} AND ${IN_SEARCH} AND p.id > ${afterId}
    ORDER BY p.id LIMIT ${BATCH_ITEMS}`);
}

// Every item, keyset by id. Read only.
async function readScores(db: PrismaClient, sqlAfter: (afterId: number) => Prisma.Sql, what: string): Promise<HubScores> {
  const scores: HubScores = { toPhotos: new Map(), toTexts: new Map() };
  let afterId = 0;
  for (;;) {
    const [, rows] = await db.$transaction([db.$queryRaw(hubSettings()), db.$queryRaw<HubRow[]>(sqlAfter(afterId))]);
    const last = rows.at(-1);
    if (!last) return scores;
    for (const { id, toPhotos, toTexts } of rows) {
      if (toPhotos === null || toTexts === null) throw new Error(`no neighbours for ${what} ${id}`);
      scores.toPhotos.set(id, toPhotos);
      scores.toTexts.set(id, toTexts);
    }
    afterId = last.id;
  }
}

// The scores a run's alphas need: about a minute for 15.6 thousand texts, a few for 45 thousand photos
export async function readHubness(db: PrismaClient, model: SearchModelName, textAlpha: number, photoAlpha: number):
  Promise<Hubness> {
  const none: HubScores = { toPhotos: new Map(), toTexts: new Map() };
  const texts = textAlpha ? await readScores(db, (afterId) => textScoresSql(model, afterId), "the text of model") : none;
  const photos = photoAlpha ? await readScores(db, (afterId) => photoScoresSql(model, afterId), "the photo") : none;
  return { model, textAlpha, photoAlpha, texts, photos };
}
