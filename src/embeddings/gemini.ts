// Google Gemini gemini-embedding-2 on the Gemini API, paid tier (docs/integrations.md, «Модель ембедінгів»):
// POST models/gemini-embedding-2:batchEmbedContents, key in x-goog-api-key (never in the URL). Each image or text is a
// Content of its own, so each gets its own vector. The model takes no task type: the task goes into the text.
import { checkVectors, estimatedTokens, numericFields, postJson, ProviderError } from "./api.js";
import { isRecord } from "../suppliers/normalize.js";
import type { EmbedResult, EmbeddingProvider, ImageInput, InputRole, PriceInput, TextInput } from "./provider.js";

const MODEL = "gemini-embedding-2";
// Another base only for the tests' local server
export const GEMINI_DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";
// 3072 by default; 1536 is one of the recommended sizes and fits pgvector's HNSW index (up to 2000). The embeddings
// guide says gemini-embedding-2 normalizes truncated sizes; the search uses cosine distance, which does not need it.
const DIMENSIONS = 1536;
// Prices 2026-10-29, ai.google.dev/gemini-api/docs/pricing, paid tier, standard (not the Batch API): text $0.20 per
// 1M tokens, an image $0.00012
const USD_PER_TEXT_TOKEN = 0.2 / 1_000_000;
const USD_PER_IMAGE = 0.000_12;
// "Maximum of 6 images per request" (embeddings guide); the guide gives no limit for texts in a batch
const MAX_IMAGES_PER_REQUEST = 6;
const MAX_TEXTS_PER_REQUEST = 32;
// Inline data of a Gemini request stays under 20 MB
const MAX_IMAGE_BYTES_PER_REQUEST = 12 * 1024 * 1024;

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

// The prompts of the embeddings guide: a document with its title, a query for search results
function textPart({ title, text }: TextInput, role: InputRole): Part {
  return { text: role === "query" ? `task: search result | query: ${text}` : `title: ${title ?? "none"} | text: ${text}` };
}

function vectorsOf(answer: unknown, count: number): EmbedResult {
  const embeddings = isRecord(answer) ? answer.embeddings : undefined;
  if (!Array.isArray(embeddings)) throw new ProviderError(`${MODEL}: the answer has no embeddings list`);
  const vectors = embeddings.map((item) => (isRecord(item) ? item.values : undefined));
  return {
    vectors: checkVectors(vectors, count, DIMENSIONS, MODEL),
    usage: numericFields(isRecord(answer) ? answer.usageMetadata : undefined),
  };
}

export function geminiProvider(apiKey: string, baseUrl = GEMINI_DEFAULT_URL): EmbeddingProvider {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models/${MODEL}:batchEmbedContents`);
  const call = async (parts: Part[], signal: AbortSignal) => {
    const body = {
      requests: parts.map((part) => ({
        model: `models/${MODEL}`, content: { parts: [part] }, output_dimensionality: DIMENSIONS,
      })),
    };
    return vectorsOf(await postJson(url, { "x-goog-api-key": apiKey }, body, signal), parts.length);
  };
  return {
    name: `${MODEL}/${DIMENSIONS}`,
    dimensions: DIMENSIONS,
    maxImagesPerRequest: MAX_IMAGES_PER_REQUEST,
    maxTextsPerRequest: MAX_TEXTS_PER_REQUEST,
    maxImageBytesPerRequest: MAX_IMAGE_BYTES_PER_REQUEST,
    priceUsd({ imagePixels, textChars }: PriceInput): number {
      return imagePixels.length * USD_PER_IMAGE + estimatedTokens(textChars) * USD_PER_TEXT_TOKEN;
    },
    // The guide says no task text goes with an image
    embedImages(images: ImageInput[], _role: InputRole, signal: AbortSignal) {
      return call(images.map((image) => ({
        inline_data: { mime_type: image.mimeType, data: image.bytes.toString("base64") },
      })), signal);
    },
    embedTexts(texts: TextInput[], role: InputRole, signal: AbortSignal) {
      return call(texts.map((text) => textPart(text, role)), signal);
    },
  };
}
