import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InputRejected, ProviderError } from "./api.js";
import { geminiProvider } from "./gemini.js";
import { voyageProvider } from "./voyage.js";

interface Hit {
  headers: IncomingMessage["headers"];
  url: string;
  body: Record<string, unknown>;
}

type Answer = (hit: Hit, count: number) => { status: number; body: unknown; headers?: Record<string, string> };

let server: Server | undefined;

// A local API answering by the number of the hit, keeping what each request carried
async function serve(answer: Answer): Promise<{ base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    req.on("end", () => {
      const hit = { headers: req.headers, url: req.url ?? "", body: JSON.parse(text) as Record<string, unknown> };
      hits.push(hit);
      const { status, body, headers } = answer(hit, hits.length);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/v1`, hits };
}

afterEach(async () => {
  const current = server;
  if (!current) return;
  current.closeAllConnections();
  await new Promise((resolve) => current.close(resolve));
  server = undefined;
});

const signal = new AbortController().signal;
const image = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" as const };

function vector(dimensions: number, value: number): number[] {
  return new Array<number>(dimensions).fill(value);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("voyageProvider", () => {
  it("sends images as base64 data URLs with the role and sorts the vectors by index", async () => {
    const { base, hits } = await serve(() => ({
      status: 200,
      body: {
        data: [{ index: 1, embedding: vector(1024, 0.2) }, { index: 0, embedding: vector(1024, 0.1) }],
        usage: { image_pixels: 2_000_000, total_tokens: 3571, note: "x" },
      },
    }));
    const result = await voyageProvider("voyage-key", base).embedImages([image, image], "document", signal);
    expect(result.vectors.map((item) => item[0])).toEqual([0.1, 0.2]);
    expect(result.usage).toEqual({ image_pixels: 2_000_000, total_tokens: 3571 });
    const [hit] = hits;
    expect(hit?.url).toBe("/v1/multimodalembeddings");
    expect(hit?.headers.authorization).toBe("Bearer voyage-key");
    expect(hit?.body).toMatchObject({ model: "voyage-multimodal-3.5", input_type: "document" });
    expect(hit?.body.inputs).toEqual([
      { content: [{ type: "image_base64", image_base64: "data:image/jpeg;base64,/9j/4A==" }] },
      { content: [{ type: "image_base64", image_base64: "data:image/jpeg;base64,/9j/4A==" }] },
    ]);
  });

  it("puts the title on the first line of a text", async () => {
    const { base, hits } = await serve(() => ({ status: 200, body: { data: [{ index: 0, embedding: vector(1024, 0) }] } }));
    await voyageProvider("k", base).embedTexts([{ title: "Bamboo pen", text: "Material: bamboo" }], "query", signal);
    expect(hits[0]?.body.inputs).toEqual([{ content: [{ type: "text", text: "Bamboo pen\nMaterial: bamboo" }] }]);
    expect(hits[0]?.body.input_type).toBe("query");
  });

  it("retries a 503 and takes the next answer", async () => {
    const { base, hits } = await serve((_hit, count) => (count === 1
      ? { status: 503, body: { detail: "busy" }, headers: { "retry-after": "0" } }
      : { status: 200, body: { data: [{ index: 0, embedding: vector(1024, 1) }] } }));
    const result = await voyageProvider("k", base).embedTexts([{ title: null, text: "mug" }], "query", signal);
    expect(result.vectors).toHaveLength(1);
    expect(hits).toHaveLength(2);
  });

  it("tells a refused input (400) from a provider that cannot be used (401)", async () => {
    const refused = await serve(() => ({ status: 400, body: { detail: "image could not be decoded" } }));
    const error = await failure(voyageProvider("k", refused.base).embedImages([image], "document", signal));
    expect(error).toBeInstanceOf(InputRejected);
    expect((error as Error).message).toContain("image could not be decoded");
    server?.closeAllConnections();
    server?.close();
    const denied = await serve(() => ({ status: 401, body: { detail: "invalid key" } }));
    expect(await failure(voyageProvider("k", denied.base).embedImages([image], "document", signal)))
      .toBeInstanceOf(ProviderError);
  });

  it("refuses an answer with a wrong dimension, a missing index or not JSON", async () => {
    const answers = [
      { data: [{ index: 0, embedding: vector(512, 0) }] },
      { data: [{ embedding: vector(1024, 0) }] },
      { data: [{ index: 0, embedding: vector(1024, 0) }, { index: 0, embedding: vector(1024, 1) }] },
      { data: [{ index: 0, embedding: [...vector(1023, 0), Number.NaN] }] },
      "<html>gateway</html>",
    ];
    let next = 0;
    const { base } = await serve(() => ({ status: 200, body: answers[next++] }));
    for (let count = 0; count < answers.length; count += 1) {
      expect(await failure(voyageProvider("k", base).embedTexts([{ title: null, text: "x" }], "query", signal)))
        .toBeInstanceOf(ProviderError);
    }
    expect(next).toBe(answers.length);
  });

  it("refuses a repeated index, which would leave one input without a vector", async () => {
    const { base } = await serve(() => ({
      status: 200, body: { data: [{ index: 0, embedding: vector(1024, 0) }, { index: 0, embedding: vector(1024, 1) }] },
    }));
    const texts = [{ title: null, text: "a" }, { title: null, text: "b" }];
    const error = await failure(voyageProvider("k", base).embedTexts(texts, "query", signal));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain("unique index");
  });

  it("prices images between 50,000 and 2,000,000 pixels and texts by characters", () => {
    const provider = voyageProvider("k", "https://example.invalid");
    expect(provider.priceUsd({ imagePixels: [1_000_000], textChars: 0 })).toBeCloseTo(0.0006, 10);
    expect(provider.priceUsd({ imagePixels: [10_000, 16_000_000], textChars: 0 })).toBeCloseTo(0.000_03 + 0.0012, 10);
    expect(provider.priceUsd({ imagePixels: [], textChars: 3_000_000 })).toBeCloseTo(0.12, 10);
  });
});

describe("geminiProvider", () => {
  it("sends one Content per image with the dimension and the key in a header", async () => {
    const { base, hits } = await serve(() => ({
      status: 200, body: { embeddings: [{ values: vector(1536, 0.5) }], usageMetadata: { promptTokenCount: 258 } },
    }));
    const result = await geminiProvider("gemini-key", base).embedImages([image], "query", signal);
    expect(result.vectors[0]).toHaveLength(1536);
    expect(result.usage).toEqual({ promptTokenCount: 258 });
    const [hit] = hits;
    expect(hit?.url).toBe("/v1/models/gemini-embedding-2:batchEmbedContents");
    expect(hit?.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(hit?.body.requests).toEqual([{
      model: "models/gemini-embedding-2", output_dimensionality: 1536,
      content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: "/9j/4A==" } }] },
    }]);
  });

  it("writes the task into the text: a titled document, a search query", async () => {
    const { base, hits } = await serve(() => ({
      status: 200, body: { embeddings: [{ values: vector(1536, 0) }, { values: vector(1536, 0) }] },
    }));
    const provider = geminiProvider("k", base);
    await provider.embedTexts([{ title: "Mug", text: "Material: ceramic" }, { title: null, text: "x" }], "document", signal);
    await failure(provider.embedTexts([{ title: null, text: "red mug" }], "query", signal));
    const texts = hits.map((hit) => (hit.body.requests as { content: { parts: { text: string }[] } }[])
      .map((request) => request.content.parts[0]?.text));
    expect(texts).toEqual([
      ["title: Mug | text: Material: ceramic", "title: none | text: x"],
      ["task: search result | query: red mug"],
    ]);
  });

  it("refuses an answer with fewer vectors than inputs", async () => {
    const { base } = await serve(() => ({ status: 200, body: { embeddings: [{ values: vector(1536, 0) }] } }));
    expect(await failure(geminiProvider("k", base).embedImages([image, image], "document", signal)))
      .toBeInstanceOf(ProviderError);
  });

  it("prices a flat rate per image", () => {
    expect(geminiProvider("k").priceUsd({ imagePixels: [490_000, 1_000_000], textChars: 0 })).toBeCloseTo(0.000_24, 10);
  });
});
