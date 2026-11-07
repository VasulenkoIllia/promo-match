// Voyage AI voyage-multimodal-3.5 (docs/integrations.md, «Модель ембедінгів»): POST <base>/multimodalembeddings,
// key in Authorization: Bearer. Keys made in MongoDB Atlas (AI Model APIs) go to ai.mongodb.com, keys of the old
// Voyage platform to api.voyageai.com: VOYAGE_API_URL picks.
import { checkVectors, estimatedTokens, numericFields, postJson, ProviderError } from "./api.js";
import { isRecord } from "../suppliers/normalize.js";
import type { EmbedResult, EmbeddingProvider, ImageInput, InputRole, PriceInput, TextInput } from "./provider.js";

export const VOYAGE_DEFAULT_URL = "https://ai.mongodb.com/v1";
const MODEL = "voyage-multimodal-3.5";
const DIMENSIONS = 1024;
// Prices 2026-10-29, mongodb.com/docs/voyageai/management/billing: text $0.12 per 1M tokens, images $0.60 per 1B
// pixels, each image billed as at least 50,000 and at most 2,000,000 pixels
const USD_PER_TEXT_TOKEN = 0.12 / 1_000_000;
const USD_PER_PIXEL = 0.6 / 1_000_000_000;
const MIN_BILLED_PIXELS = 50_000;
const MAX_BILLED_PIXELS = 2_000_000;
// The API takes 1,000 inputs and 320,000 tokens a request, an image counts a token per 560 pixels: 32 images of
// 1000×1000 pixels are about 57,000 tokens and 5 MB of base64
const MAX_IMAGES_PER_REQUEST = 32;
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_IMAGE_BYTES_PER_REQUEST = 12 * 1024 * 1024;

type ContentItem = { type: "text"; text: string } | { type: "image_base64"; image_base64: string };

function vectorsOf(answer: unknown, count: number): EmbedResult {
  const data = isRecord(answer) ? answer.data : undefined;
  if (!Array.isArray(data)) throw new ProviderError(`${MODEL}: the answer has no data list`);
  // Each embedding carries the index of its input; sorted by it, never trusted to come in order or only once
  const vectors: unknown[] = new Array<unknown>(data.length);
  const seen = new Set<number>();
  for (const item of data) {
    const index = isRecord(item) ? item.index : undefined;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= data.length || seen.has(index)
      || !isRecord(item)) {
      throw new ProviderError(`${MODEL}: an embedding without a valid, unique index`);
    }
    seen.add(index);
    vectors[index] = item.embedding;
  }
  return { vectors: checkVectors(vectors, count, DIMENSIONS, MODEL), usage: numericFields(isRecord(answer) ? answer.usage : undefined) };
}

export function voyageProvider(apiKey: string, baseUrl: string): EmbeddingProvider {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/multimodalembeddings`);
  const call = async (contents: ContentItem[][], role: InputRole, signal: AbortSignal) => {
    const body = { model: MODEL, input_type: role, inputs: contents.map((content) => ({ content })) };
    return vectorsOf(await postJson(url, { authorization: `Bearer ${apiKey}` }, body, signal), contents.length);
  };
  return {
    name: `${MODEL}/${DIMENSIONS}`,
    dimensions: DIMENSIONS,
    maxImagesPerRequest: MAX_IMAGES_PER_REQUEST,
    maxTextsPerRequest: MAX_TEXTS_PER_REQUEST,
    maxImageBytesPerRequest: MAX_IMAGE_BYTES_PER_REQUEST,
    priceUsd({ imagePixels, textChars }: PriceInput): number {
      const pixels = imagePixels.reduce((sum, count) =>
        sum + Math.min(Math.max(count, MIN_BILLED_PIXELS), MAX_BILLED_PIXELS), 0);
      return pixels * USD_PER_PIXEL + estimatedTokens(textChars) * USD_PER_TEXT_TOKEN;
    },
    embedImages(images: ImageInput[], role: InputRole, signal: AbortSignal) {
      return call(images.map((image) => [{
        type: "image_base64", image_base64: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      }]), role, signal);
    },
    embedTexts(texts: TextInput[], role: InputRole, signal: AbortSignal) {
      return call(texts.map(({ title, text }) => [{ type: "text", text: title ? `${title}\n${text}` : text }]), role, signal);
    },
  };
}
