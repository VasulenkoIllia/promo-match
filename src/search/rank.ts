// The pure part of the search (stage 4): nearest photos and texts grouped to product models, then the lists fused into
// one ranking by reciprocal rank fusion (RRF). RRF reads ranks, not similarities, because cosine similarities of Gemini
// and Voyage are on different scales, and the quality test of stage 8 compares the models by the same method.
import type { SearchModelName } from "./models.js";

// A list pairs a query input with what it is compared to: the reference photo or the query text, against catalogue
// photos or model texts (all four in one vector space)
export const LIST_NAMES = ["image-photo", "image-text", "text-photo", "text-text"] as const;
export type ListName = (typeof LIST_NAMES)[number];

export function isListName(value: string): value is ListName {
  return (LIST_NAMES as readonly string[]).includes(value);
}

// The constant of RRF from its paper (Cormack et al., 2009): a model's score is the sum of 1 / (k + rank) over lists
export const RRF_K = 60;
// Matched photos shown for a model
export const PHOTOS_PER_RESULT = 3;
const SCORE_DIGITS = 6;
// Knuth's multiplicative hash constant
const TIE_HASH = 2_654_435_761;

// A tie says nothing of either model, and ids follow the order of the imports: the lower id would hand every tie to the
// source imported first. A hash of the id keeps the output stable and knows no source.
export function tieOrder(modelId: number): number {
  return Math.imul(modelId, TIE_HASH) >>> 0;
}

export interface PhotoHit {
  modelId: number;
  photoId: number;
  // The picture's bytes: suppliers list the same picture under several URLs of one model
  imageSha256: string;
  // Cosine distance, 0 to 2
  distance: number;
}

export interface TextHit {
  modelId: number;
  distance: number;
}

export interface MatchedPhoto {
  photoId: number;
  imageSha256: string;
  similarity: number;
}

// A model in one list: 1-based rank by its best match
export interface ListEntry {
  modelId: number;
  rank: number;
  similarity: number;
  photos: MatchedPhoto[];
}

export interface FusedModel {
  modelId: number;
  score: number;
  lists: Partial<Record<ListName, { rank: number; similarity: number }>>;
  photos: MatchedPhoto[];
  // The code the text named it by (src/search/codes.ts), and how many models of the results that code named
  matchedCode?: string;
  matchedCodeModels?: number;
  // The product of the query that gave it its place (interleave); none for a model only a code found
  productIndex?: number;
}

function similarity(distance: number): number {
  return Number((1 - distance).toFixed(SCORE_DIGITS));
}

// Matched photos of a model: the best few, each picture once
function addPhoto(photos: MatchedPhoto[], photo: MatchedPhoto): void {
  if (photos.length < PHOTOS_PER_RESULT && !photos.some((each) => each.imageSha256 === photo.imageSha256)) {
    photos.push(photo);
  }
}

// Hits come nearly in order (pgvector's relaxed iterative scan): sorted again, then a model ranks by its best photo
export function rankPhotoHits(hits: PhotoHit[]): ListEntry[] {
  const byModel = new Map<number, ListEntry>();
  const nearestFirst = [...hits].sort((left, right) =>
    left.distance - right.distance || tieOrder(left.modelId) - tieOrder(right.modelId));
  for (const hit of nearestFirst) {
    let entry = byModel.get(hit.modelId);
    if (!entry) {
      entry = { modelId: hit.modelId, rank: byModel.size + 1, similarity: similarity(hit.distance), photos: [] };
      byModel.set(hit.modelId, entry);
    }
    addPhoto(entry.photos, { photoId: hit.photoId, imageSha256: hit.imageSha256, similarity: similarity(hit.distance) });
  }
  return [...byModel.values()];
}

// One text vector per model, so the order of the hits is the ranking
export function rankTextHits(hits: TextHit[]): ListEntry[] {
  return [...hits].sort((left, right) => left.distance - right.distance || tieOrder(left.modelId) - tieOrder(right.modelId))
    .map((hit, index) => ({ modelId: hit.modelId, rank: index + 1, similarity: similarity(hit.distance), photos: [] }));
}

function bestRank(model: FusedModel): number {
  return Math.min(...Object.values(model.lists).map((list) => list.rank));
}

// Best first; a tie goes to the better best rank (ranks, not similarities: those of different lists are not comparable),
// then by tieOrder
export function sortFused(models: FusedModel[]): FusedModel[] {
  return [...models].map((model) => ({ ...model, score: Number(model.score.toFixed(SCORE_DIGITS)) }))
    .sort((left, right) => right.score - left.score || bestRank(left) - bestRank(right)
      || tieOrder(left.modelId) - tieOrder(right.modelId));
}

// The fused ranking. Matched photos: those of the reference photo first, then those of the text, each picture once.
export function fuseLists(lists: Partial<Record<ListName, ListEntry[]>>, limit: number): FusedModel[] {
  const fused = new Map<number, FusedModel>();
  for (const name of LIST_NAMES) {
    for (const entry of lists[name] ?? []) {
      let model = fused.get(entry.modelId);
      if (!model) {
        model = { modelId: entry.modelId, score: 0, lists: {}, photos: [] };
        fused.set(entry.modelId, model);
      }
      model.score += 1 / (RRF_K + entry.rank);
      model.lists[name] = { rank: entry.rank, similarity: entry.similarity };
      for (const photo of entry.photos) addPhoto(model.photos, photo);
    }
  }
  return sortFused([...fused.values()]).slice(0, limit);
}

// The ranking with the given models' scores multiplied by the factor
export function liftModels(fused: FusedModel[], modelIds: ReadonlySet<number>, factor: number): FusedModel[] {
  return sortFused(fused.map((model) => (modelIds.has(model.modelId) ? { ...model, score: model.score * factor } : model)));
}

// A second pass on top of a ranking: each rank in its lists adds a vote of this weight, and a model only it found comes
// in with those votes alone, its matched photos with it
export function addVotes(fused: FusedModel[], lists: ListEntry[][], weight: number): FusedModel[] {
  const voted = new Map(fused.map((model) => [model.modelId, { ...model, photos: [...model.photos] }]));
  for (const entry of lists.flat()) {
    const model = voted.get(entry.modelId) ?? { modelId: entry.modelId, score: 0, lists: {}, photos: [] };
    model.score += weight / (RRF_K + entry.rank);
    for (const photo of entry.photos) addPhoto(model.photos, photo);
    voted.set(entry.modelId, model);
  }
  return sortFused([...voted.values()]);
}

// Several products in one query: their rankings in turn, so none pushes the others out; a model once, at its best place
export function interleave(rankings: FusedModel[][], limit: number): FusedModel[] {
  const merged = new Map<number, FusedModel>();
  const deepest = Math.max(0, ...rankings.map((ranking) => ranking.length));
  for (let place = 0; place < deepest; place += 1) {
    for (const [productIndex, ranking] of rankings.entries()) {
      const model = ranking[place];
      if (model && !merged.has(model.modelId)) merged.set(model.modelId, { ...model, productIndex });
    }
  }
  return [...merged.values()].slice(0, limit);
}

// Whether the catalogue holds anything near a text: under this similarity of the nearest model text it does not. A scale
// is its model's own, so only a measured model says (README «Незалежний тест»).
const CLOSE_TEXT_SIMILARITY: Partial<Record<SearchModelName, number>> = { "gemini-embedding-2/1536": 0.7 };

// null: nothing to say, as for a photo, which finds what the text may not, or a code, which found its model
export function hasCloseText(model: SearchModelName, rankings: FusedModel[][], isByTextAlone: boolean): boolean | null {
  const bound = CLOSE_TEXT_SIMILARITY[model];
  const nearest = rankings.flat().flatMap(({ lists }) => lists["text-text"]?.similarity ?? []);
  return bound === undefined || !isByTextAlone || !nearest.length ? null : Math.max(...nearest) >= bound;
}
