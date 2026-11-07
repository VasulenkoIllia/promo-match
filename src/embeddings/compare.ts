// Retrieval metrics of the sample comparison (scripts/compare-embeddings.ts): each query ranks all documents by cosine
// similarity, and a hit is a document of the query's own model. Recall@k: the share of queries with a hit in the
// first k; MRR: the mean of 1 / rank of the first hit.
export const RECALL_AT = [1, 5, 10] as const;

export interface Doc {
  id: string;
  // The product model the document belongs to
  key: string;
  vector: number[];
}

export interface Query {
  // A document that is the query itself (the same photo) and so never counts
  selfId?: string;
  key: string;
  vector: number[];
}

export interface Metrics {
  queries: number;
  recall: Record<`@${(typeof RECALL_AT)[number]}`, number>;
  mrr: number;
  // Queries whose model ranked worst, for a look at the photos; rank null: not among the documents at all
  worst: { key: string; rank: number | null }[];
}

const DIGITS = 3;
const WORST_SHOWN = 5;

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

export function cosine(left: number[], right: number[]): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += (left[index] ?? 0) * (right[index] ?? 0);
  const denominator = norm(left) * norm(right);
  return denominator ? dot / denominator : 0;
}

// The 1-based rank of the first document of the query's model; Infinity when the documents hold none
export function firstHitRank(query: Query, docs: Doc[]): number {
  const ranked = docs.filter((doc) => doc.id !== query.selfId)
    .map((doc) => ({ key: doc.key, score: cosine(query.vector, doc.vector) }))
    .sort((left, right) => right.score - left.score);
  const index = ranked.findIndex((doc) => doc.key === query.key);
  return index < 0 ? Number.POSITIVE_INFINITY : index + 1;
}

function round(value: number): number {
  return Number(value.toFixed(DIGITS));
}

export function retrievalMetrics(queries: Query[], docs: Doc[]): Metrics {
  const ranks = queries.map((query) => ({ key: query.key, rank: firstHitRank(query, docs) }));
  const share = (k: number) => (ranks.length ? round(ranks.filter(({ rank }) => rank <= k).length / ranks.length) : 0);
  return {
    queries: ranks.length,
    recall: { "@1": share(1), "@5": share(5), "@10": share(10) },
    mrr: ranks.length ? round(ranks.reduce((sum, { rank }) => sum + 1 / rank, 0) / ranks.length) : 0,
    worst: [...ranks].sort((left, right) => right.rank - left.rank).slice(0, WORST_SHOWN)
      .map(({ key, rank }) => ({ key, rank: Number.isFinite(rank) ? rank : null })),
  };
}
