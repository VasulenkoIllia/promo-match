// The texts of one source: one vector per active model, made again only when its text changed (text_hash)
import { scrub } from "../suppliers/secrets.js";
import { addExample, addUsage, embedSplitting } from "./batch.js";
import type { EmbedJob } from "./photos.js";
import type { TextInput } from "./provider.js";
import { type ModelTextRow, readModelTexts, writeTextVectors } from "./store.js";
import { modelText, textChars, textHash } from "./text.js";

// The text a vector is made of: the model's own, or a candidate shape of it (src/embeddings/brand-words.ts)
export type TextShape = (row: ModelTextRow) => TextInput | undefined;

// The vectors a run makes: under the provider's name from the model's text, or a candidate's beside them under a name
// of its own (src/search/models.ts, TEXT_VARIANTS)
export interface TextVectors {
  name: string;
  shape: TextShape;
}

export interface TextToEmbed {
  modelId: number;
  code: string;
  input: TextInput;
  hash: string;
}

export interface TextPlan {
  total: number;
  created: TextToEmbed[];
  changed: TextToEmbed[];
  unchanged: number;
  // No English name: nothing to embed
  withoutText: string[];
}

export function planTexts(rows: ModelTextRow[], shape: TextShape = modelText): TextPlan {
  const plan: TextPlan = { total: rows.length, created: [], changed: [], unchanged: 0, withoutText: [] };
  for (const row of rows) {
    const input = shape(row);
    if (!input) {
      plan.withoutText.push(row.code);
      continue;
    }
    const hash = textHash(input);
    if (row.textHash === hash) plan.unchanged += 1;
    else (row.textHash === null ? plan.created : plan.changed).push({ modelId: row.id, code: row.code, input, hash });
  }
  return plan;
}

export interface TextCounts {
  embedded: number;
  failed: number;
  // Calls made to the provider, refused ones included
  calls: number;
  usage: Record<string, number>;
  examples: string[];
}

export function emptyTextCounts(): TextCounts {
  return { embedded: 0, failed: 0, calls: 0, usage: {}, examples: [] };
}

export async function readTextPlan(job: Pick<EmbedJob, "db" | "sourceId">, embeddingModel: string,
  shape: TextShape = modelText): Promise<TextPlan> {
  return planTexts(await readModelTexts(job.db, job.sourceId, embeddingModel), shape);
}

// A refused text has no status column to keep: it is reported, and tried (and paid) again on the next run. The vectors
// got before a failure are written before it is thrown.
export async function embedTexts(job: EmbedJob, counts: TextCounts,
  vectors: TextVectors = { name: job.provider.name, shape: modelText }): Promise<TextPlan> {
  const { provider } = job;
  const plan = await readTextPlan(job, vectors.name, vectors.shape);
  const todo = [...plan.created, ...plan.changed].slice(0, job.limit);
  for (let start = 0; start < todo.length; start += provider.maxTextsPerRequest) {
    const batch = todo.slice(start, start + provider.maxTextsPerRequest);
    const result = await embedSplitting(batch, async (items) => {
      await job.beforeBatch();
      const chars = items.reduce((sum, item) => sum + textChars(item.input), 0);
      job.budget.reserve(provider.priceUsd({ imagePixels: [], textChars: chars }));
      counts.calls += 1;
      const answer = await provider.embedTexts(items.map((item) => item.input), "document", job.signal);
      addUsage(counts.usage, answer.usage);
      return answer.vectors;
    });
    counts.embedded += await writeTextVectors(job.db, vectors.name,
      [...result.vectors].map(([item, vector]) => ({ modelId: item.modelId, vector, textHash: item.hash })));
    counts.failed += result.rejected.size;
    for (const [item, error] of result.rejected) {
      addExample(counts.examples, scrub(`model ${item.code}: refused: ${error}`, job.secrets));
    }
    if (result.failure !== undefined) throw result.failure;
  }
  return plan;
}
