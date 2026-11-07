import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp, requestLine } from "./app.js";

describe("GET /health", () => {
  it("answers ok", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("errors", () => {
  it("answers 500 without the error details", async () => {
    const app = buildApp();
    app.get("/boom", () => {
      throw new Error("database password rejected");
    });
    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("password");
    await app.close();
  });

  it("keeps the status of a library error but not its message", async () => {
    const app = buildApp();
    app.get("/denied", () => {
      throw Object.assign(new Error("GET https://api.example.test/?key=k123 failed"), { statusCode: 403 });
    });
    const response = await app.inject({ method: "GET", url: "/denied" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    await app.close();
  });

  // 599 is the last status Fastify can send: a library status above it becomes a 500
  it.each([[599, 599], [600, 500]])("answers a library status %i with %i", async (thrown, sent) => {
    const app = buildApp();
    app.get("/upstream", () => {
      throw Object.assign(new Error(`upstream answered ${thrown}`), { statusCode: thrown });
    });
    const response = await app.inject({ method: "GET", url: "/upstream" });
    expect(response.statusCode).toBe(sent);
    expect(response.json()).toEqual({ error: "Internal Server Error" });
    await app.close();
  });

  it("answers 404 as JSON", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
    await app.close();
  });
});

describe("request line", () => {
  it("logs the path without its query", async () => {
    const app = buildApp();
    app.get("/orders", (request) => requestLine(request));
    const response = await app.inject({ method: "GET", url: "/orders?token=t1" });
    expect(response.json()).toMatchObject({ method: "GET", url: "/orders" });
    await app.close();
  });
});

describe("GET /ready", () => {
  it("answers ok when the database answers", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(1) });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("answers 503 when the database fails", async () => {
    const app = buildApp({ checkDatabase: () => Promise.reject(new Error("connection refused")) });
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    await app.close();
  });
});

describe("web app", () => {
  const webRoot = mkdtempSync(join(tmpdir(), "web-"));
  writeFileSync(join(webRoot, "index.html"), '<div id="root"></div>');
  writeFileSync(join(webRoot, ".secret"), "hidden-file-content");
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "assets", "app-1a2b.js"), "export {};");
  const app = buildApp({ webRoot });

  afterAll(async () => {
    await app.close();
    rmSync(webRoot, { recursive: true });
  });

  it.each(["/orders/42", "/login?next=https://example.test/report.pdf"])("serves the page for %s", async (url) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="root"');
  });

  it.each(["/api", "/api/missing?x=1", "/assets/missing.js"])("answers 404 for %s", async (url) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
  });

  it("caches hashed assets for good", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/app-1a2b.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("never serves hidden files", async () => {
    const response = await app.inject({ method: "GET", url: "/.secret" });
    expect(response.body).not.toContain("hidden-file-content");
  });
});
