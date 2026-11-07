// The embedding provider behind one interface (project card, «Люки»): the worker, the sample comparison and later the
// search call it the same way, and a provider is one module here. Every vector is stored with the provider's name.
// Contract and prices: docs/integrations.md, «Модель ембедінгів».
import { ConfigError, required } from "../config.js";
import { geminiProvider } from "./gemini.js";
import type { ImageMimeType } from "./image.js";
import { VOYAGE_DEFAULT_URL, voyageProvider } from "./voyage.js";

export interface ImageInput {
  bytes: Buffer;
  mimeType: ImageMimeType;
}

// title: the model's shared category; text: the rest of its text. A query has no title.
export interface TextInput {
  title: string | null;
  text: string;
}

// A catalogue photo or text is a document, a search request is a query: some providers prompt them differently
export type InputRole = "document" | "query";

export interface EmbedResult {
  vectors: number[][];
  // What the provider reported, for the report; the budget counts the list price before the call
  usage: Record<string, number>;
}

// What a call is priced by: the pixels of each image (width × height) and the characters of all texts
export interface PriceInput {
  imagePixels: number[];
  textChars: number;
}

// The embed calls return one vector per input, in input order, each checked by checkVectors (src/embeddings/api.ts)
export interface EmbeddingProvider {
  // Stored with every vector: the provider's model and the dimension, e.g. "voyage-multimodal-3.5/1024"
  readonly name: string;
  readonly dimensions: number;
  readonly maxImagesPerRequest: number;
  readonly maxTextsPerRequest: number;
  // Image bytes per request, before base64 makes them a third larger
  readonly maxImageBytesPerRequest: number;
  // List price in USD, from the pricing page and date in the provider's module
  priceUsd(input: PriceInput): number;
  embedImages(images: ImageInput[], role: InputRole, signal: AbortSignal): Promise<EmbedResult>;
  embedTexts(texts: TextInput[], role: InputRole, signal: AbortSignal): Promise<EmbedResult>;
}

export const PROVIDER_CODES = ["voyage", "gemini"] as const;
export type ProviderCode = (typeof PROVIDER_CODES)[number];

export function isProviderCode(value: string): value is ProviderCode {
  return (PROVIDER_CODES as readonly string[]).includes(value);
}

// The provider EMBED_PROVIDER names; undefined when it is not set (a dry run then prices every provider)
export function providerCodeFromEnv(): ProviderCode | undefined {
  const code = process.env.EMBED_PROVIDER;
  if (!code) return undefined;
  if (!isProviderCode(code)) throw new ConfigError(`EMBED_PROVIDER must be one of ${PROVIDER_CODES.join(", ")}, got "${code}"`);
  return code;
}

// With isPricingOnly no key is needed: a dry run only prices, it never calls
export function providerFromEnv(code: ProviderCode, isPricingOnly = false): { provider: EmbeddingProvider; apiKey: string } {
  switch (code) {
    case "voyage": {
      const apiKey = isPricingOnly ? "" : required("VOYAGE_API_KEY");
      const baseUrl = process.env.VOYAGE_API_URL || VOYAGE_DEFAULT_URL;
      if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== "https:") {
        throw new ConfigError(`VOYAGE_API_URL must be an https address, got "${baseUrl}"`);
      }
      return { provider: voyageProvider(apiKey, baseUrl), apiKey };
    }
    case "gemini": {
      const apiKey = isPricingOnly ? "" : required("GEMINI_API_KEY");
      return { provider: geminiProvider(apiKey), apiKey };
    }
  }
}

// The spending limit of one run in USD (EMBED_BUDGET_USD): a run that would pass it stops before the call
export function budgetFromEnv(): number {
  const raw = required("EMBED_BUDGET_USD");
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`EMBED_BUDGET_USD must be a positive number, got "${raw}"`);
  return value;
}
