import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError, pause, request, retryWaitMs } from "./http.js";

type Handler = (request: IncomingMessage, response: ServerResponse, hit: number) => void;

let server: Server | undefined;

// A local server answering by the number of the hit (1, 2, ...), so a test sees what a retry brings
async function serve(handler: Handler): Promise<URL> {
  let hits = 0;
  server = createServer((req, res) => {
    hits += 1;
    handler(req, res, hits);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/api/?key=secret-key`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    req.on("end", () => resolve(text));
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

afterEach(async () => {
  const current = server;
  if (!current) return;
  current.closeAllConnections();
  await new Promise((resolve) => current.close(resolve));
  server = undefined;
});

const options = { method: "GET" as const, timeoutMs: 1_000, maxBytes: 1_024, backoffMs: 1 };

describe("request", () => {
  it("returns the status, the body and only the headers worth keeping", async () => {
    const url = await serve((_req, res) => {
      res.setHeader("set-cookie", "session=abc");
      res.setHeader("link", "<https://api.example/?key=secret-key>; rel=next");
      res.setHeader("x-ratelimit-remaining", "99");
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
    const result = await request(url, options);
    expect(result).toMatchObject({ status: 200, attempts: 1, retries: [] });
    expect(result.body.toString()).toBe('{"ok":true}');
    expect(result.headers).toMatchObject({ "x-ratelimit-remaining": "99", "content-type": "application/json" });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers.link).toBeUndefined();
    expect(result.omittedHeaders).toEqual(expect.arrayContaining(["set-cookie", "link"]));
  });

  it("retries a 5xx once and says why", async () => {
    const url = await serve((_req, res, hit) => {
      res.statusCode = hit === 1 ? 503 : 200;
      res.end(String(hit));
    });
    const result = await request(url, options);
    expect(result).toMatchObject({ status: 200, attempts: 2, retries: ["HTTP 503"] });
  });

  it("retries a 429 with its Retry-After and returns it when it repeats", async () => {
    const url = await serve((_req, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end();
    });
    const result = await request(url, options);
    expect(result).toMatchObject({ status: 429, attempts: 2, retries: ["HTTP 429 retry-after=0"] });
  });

  it("does not retry a 4xx", async () => {
    const url = await serve((_req, res) => {
      res.statusCode = 401;
      res.end("denied");
    });
    const result = await request(url, options);
    expect(result).toMatchObject({ status: 401, attempts: 1 });
  });

  it("retries a dropped connection and sends the whole form again", async () => {
    const forms: string[] = [];
    const url = await serve((req, res, hit) => {
      void readBody(req).then((text) => {
        forms.push(text);
        if (hit === 1) res.socket?.destroy();
        else res.end("ok");
      });
    });
    const form = new FormData();
    form.set("method", "Customer.Login");
    const result = await request(url, { ...options, method: "POST", body: form });
    expect(result).toMatchObject({ status: 200, attempts: 2 });
    expect(forms).toHaveLength(2);
    expect(forms.every((text) => text.includes("Customer.Login"))).toBe(true);
  });

  it("fails after the timeout on every attempt", async () => {
    const url = await serve(() => {
      // Never answers
    });
    const error = await failure(request(url, { ...options, timeoutMs: 50 }));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "timed out after 50 ms", attempts: 2, retries: ["timed out after 50 ms"] });
  });

  it("times out a body that stops after the headers", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    const error = await failure(request(url, { ...options, timeoutMs: 100, maxAttempts: 1 }));
    expect(error).toMatchObject({ message: "timed out after 100 ms", attempts: 1 });
  });

  it("stops reading a body over the cap, keeps its status and does not retry it", async () => {
    let isClosed = false;
    const url = await serve((_req, res) => {
      res.on("close", () => {
        isClosed = true;
      });
      res.writeHead(200, { "content-length": String(1_000_000) });
      res.write("x".repeat(4_096));
    });
    const error = await failure(request(url, options));
    expect(error).toMatchObject({ message: "response is over 1024 bytes", attempts: 1, response: { status: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isClosed).toBe(true);
  });

  it("does not retry a header value fetch refuses", async () => {
    const url = await serve((_req, res) => res.end());
    const error = await failure(request(url, { ...options, headers: { "x-key": "ключ" } }));
    expect(error).toMatchObject({ attempts: 1, retries: [] });
  });

  it("does not follow a redirect and keeps its target without the query", async () => {
    const url = await serve((_req, res) => {
      res.statusCode = 301;
      res.setHeader("location", "https://elsewhere.example/api/?key=secret-key");
      res.end();
    });
    const result = await request(url, options);
    expect(result).toMatchObject({ status: 301, location: "https://elsewhere.example/api/" });
    expect(result.headers.location).toBeUndefined();
    // The full target only for a caller that follows it on purpose
    expect(result.redirectUrl?.href).toBe("https://elsewhere.example/api/?key=secret-key");
  });
});

describe("a stop from outside", () => {
  it("ends a retry wait with the stop's own reason", async () => {
    const url = await serve((_req, res) => res.writeHead(503).end());
    const controller = new AbortController();
    const reason = new Error("stopped by SIGTERM");
    setTimeout(() => controller.abort(reason), 50);
    const startedMs = Date.now();
    const error = await failure(request(url, { ...options, backoffMs: 10_000, signal: controller.signal }));
    expect(error).toBe(reason);
    expect(Date.now() - startedMs).toBeLessThan(5_000);
  });

  it("ends a pause the same way", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped by SIGINT");
    controller.abort(reason);
    expect(await failure(pause(10_000, controller.signal))).toBe(reason);
  });
});

describe("retryWaitMs", () => {
  it("reads seconds, caps a long wait and falls back on a broken value", () => {
    expect(retryWaitMs("2", 5)).toBe(2_000);
    expect(retryWaitMs("3600", 5)).toBe(30_000);
    expect(retryWaitMs("soon", 5)).toBe(5);
    expect(retryWaitMs(null, 5)).toBe(5);
  });
});
