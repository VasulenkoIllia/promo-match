import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAxpol } from "./axpol.js";
import { runMidocean } from "./midocean.js";
import type { Run } from "./run.js";

const env = {
  axpolLogin: "b2b-login",
  axpolPassword: "b2b-password",
  axpolApiKey: "axpol-api-key",
  midoceanApiKey: "midocean-api-key",
  makitoClientId: "makito-client-id",
  makitoClientSecret: "makito-client-secret",
  inspirionApiKey: "inspirion-api-key",
  bluecollectionUsername: "bluecollection-user",
  bluecollectionPassword: "bluecollection-password",
};
const TEN_MINUTES_MS = 600_000;
const claims = Buffer.from(JSON.stringify({ iat: 1_682_424_454, exp: 1_682_425_054 })).toString("base64url");
const JWT = `eyJhbGciOiJIUzI1NiJ9.${claims}.signature-part`;

interface Call {
  host: string;
  method: string;
  userAgent?: string;
  apiKeyHeader?: string;
}

// What a mocked server answers: by host and Axpol method ("login" for the POST)
type Answer = (call: Call, logins: number) => Response;

let dirs: string[] = [];
let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (data: unknown) => json({ message: "", success: 1, data });
const wrongPassword = () => json({ message: "Wrong password", success: 0 });
const forbidden = () => new Response("<html>Forbidden</html>", { status: 403 });

function serve(answer: Answer): void {
  let logins = 0;
  vi.stubGlobal("fetch", (input: URL, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const isLogin = init.method === "POST";
    if (isLogin) logins += 1;
    const call: Call = {
      host: input.host,
      method: isLogin ? "login" : input.searchParams.get("method") ?? input.pathname,
      userAgent: headers["User-Agent"],
      apiKeyHeader: headers["x-Gateway-APIKey"],
    };
    calls.push(call);
    return Promise.resolve(answer(call, logins));
  });
}

// A working Axpol read: a count or one record
function axpolRead(call: Call): Response {
  if (call.method.endsWith(".Count")) return envelope({ count: "10 817" });
  return envelope({ "9217": { CodeERP: "V0901-02", NetPricePLN: "12,5" } });
}

function newRun(): Run {
  const dir = mkdtempSync(join(tmpdir(), "smoke-test-"));
  dirs.push(dir);
  return { env, dir, results: [], secrets: Object.values(env) };
}

function filesText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

const steps = (run: Run) => run.results.map((row) => `${row.host} ${row.step} ${row.isOk ? "ok" : "fail"}`);
const failedRequired = (run: Run) => run.results.filter((row) => row.isRequired && !row.isOk);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  calls = [];
});

describe("runAxpol", () => {
  it("logs in, reads every feed, checks the other base and keeps no secret in the output", async () => {
    serve((call) => {
      if (call.method === "login") return envelope({ uid: "86", jwt: JWT });
      return axpolRead(call);
    });
    const run = newRun();
    await runAxpol(run);
    expect(steps(run)).toEqual([
      "axpol.com.pl Customer.Login (plain) ok",
      "axpol.com.pl Product.Count ok",
      "axpol.com.pl Product.List ok",
      "axpol.com.pl Stock.Count ok",
      "axpol.com.pl Stock.List ok",
      "axpol.com.pl Printing.Count ok",
      "axpol.com.pl Printing.List ok",
      "axpol.com Customer.Login (plain) ok",
      "axpol.com Product.Count ok",
    ]);
    expect(run.results.find((row) => row.step === "Product.Count")?.total).toBe(10_817);
    expect(run.results.find((row) => row.step === "Product.List")?.records).toBe(1);
    expect(failedRequired(run)).toEqual([]);
    expect(run).toMatchObject({ jwtTtlSeconds: 600, axpolBase: "axpol.com.pl" });
    const text = filesText(run.dir);
    expect(text).toContain("V0901-02");
    for (const secret of [...Object.values(env), JWT]) expect(text).not.toContain(secret);
  });

  it("repeats a refused login with the collection's browser User-Agent", async () => {
    serve((call) => {
      if (call.host === "axpol.com") return forbidden();
      if (call.method !== "login") return axpolRead(call);
      return call.userAgent ? envelope({ uid: "86", jwt: JWT }) : forbidden();
    });
    const run = newRun();
    await runAxpol(run);
    expect(steps(run).slice(0, 3)).toEqual([
      "axpol.com.pl Customer.Login (plain) fail",
      "axpol.com.pl Customer.Login (collection) ok",
      "axpol.com.pl Product.Count ok",
    ]);
    expect(calls.filter((call) => call.method !== "login").every((call) => call.userAgent)).toBe(true);
    expect(failedRequired(run)).toEqual([]);
  });

  it("stops at a rejected login without data, so the password is not tried on the other base", async () => {
    serve(wrongPassword);
    const run = newRun();
    await runAxpol(run);
    expect(calls).toHaveLength(1);
    expect(run.results.map((row) => [row.step, row.isRequired, row.isOk, row.note])).toEqual([
      ["Customer.Login (plain)", false, false, "rejected by Axpol: Wrong password"],
      ["login", true, false, "no base logged in"],
    ]);
  });

  it("fails a login that succeeds without a token", async () => {
    serve((call) => (call.host === "axpol.com" ? forbidden() : envelope({ uid: "86" })));
    const run = newRun();
    await runAxpol(run);
    expect(run.results[0]).toMatchObject({ isOk: false, note: "success without data.jwt and data.uid" });
    expect(failedRequired(run)).toHaveLength(1);
  });

  it("fails reads without data: a count that is not a number, an empty page", async () => {
    serve((call) => {
      if (call.host === "axpol.com") return forbidden();
      if (call.method === "login") return envelope({ uid: "86", jwt: JWT });
      return call.method.endsWith(".Count") ? envelope({ count: "" }) : envelope([]);
    });
    const run = newRun();
    await runAxpol(run);
    expect(failedRequired(run).map((row) => [row.step, row.note])).toEqual([
      ["Product.Count", "no positive whole number in data.count"],
      ["Product.List", "no records"],
      ["Stock.Count", "no positive whole number in data.count"],
      ["Stock.List", "no records"],
      ["Printing.Count", "no positive whole number in data.count"],
      ["Printing.List", "no records"],
    ]);
  });

  it("renews the JWT before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve((call) => {
      if (call.host === "axpol.com") return forbidden();
      if (call.method === "login") return envelope({ uid: "86", jwt: JWT });
      if (call.method === "Product.List") vi.setSystemTime(Date.now() + TEN_MINUTES_MS);
      return axpolRead(call);
    });
    const run = newRun();
    await runAxpol(run);
    expect(steps(run).slice(2, 5)).toEqual([
      "axpol.com.pl Product.List ok",
      "axpol.com.pl Customer.Login (renew) ok",
      "axpol.com.pl Stock.Count ok",
    ]);
    expect(failedRequired(run)).toEqual([]);
  });

  it("skips the remaining reads after a failed renewal and logs in nowhere else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serve((call, logins) => {
      if (call.method === "login") return logins === 1 ? envelope({ uid: "86", jwt: JWT }) : wrongPassword();
      if (call.method === "Product.List") vi.setSystemTime(Date.now() + TEN_MINUTES_MS);
      return axpolRead(call);
    });
    const run = newRun();
    await runAxpol(run);
    expect(calls.filter((call) => call.method === "login")).toHaveLength(2);
    expect(calls.some((call) => call.host === "axpol.com")).toBe(false);
    expect(failedRequired(run).map((row) => [row.step, row.note])).toEqual([
      ["Customer.Login (renew)", "rejected by Axpol: Wrong password"],
      ["Stock.Count", "skipped: JWT renewal failed"],
      ["Stock.List", "skipped: JWT renewal failed"],
      ["Printing.Count", "skipped: JWT renewal failed"],
      ["Printing.List", "skipped: JWT renewal failed"],
    ]);
  });
});

describe("runMidocean", () => {
  it("sends the key in its header and judges each feed by its records", async () => {
    serve((call) => {
      if (call.method.includes("printpricelist")) return new Response("denied", { status: 401 });
      if (call.method.includes("printdata")) return json({ techniques: [1], positions: [2] });
      if (call.method.includes("pricelist")) return json({ currency: "EUR", price: [] });
      return json([{ master_code: "AR1804" }, { master_code: "KC3314" }]);
    });
    const run = newRun();
    await runMidocean(run);
    expect(calls.every((call) => call.apiKeyHeader === env.midoceanApiKey)).toBe(true);
    expect(run.results.map((row) => [row.step, row.isOk, row.records ?? row.note])).toEqual([
      ["products", true, 2],
      ["stock", true, 2],
      ["pricelist", false, 0],
      ["printdata", true, "several arrays, records not counted (see shape.json)"],
      ["printpricelist", false, "not 200"],
    ]);
    expect(filesText(run.dir)).not.toContain(env.midoceanApiKey);
  });

  it("follows a presigned link to S3 without the API key and keeps its credentials out of the output", async () => {
    const productsFile = "https://midocean-prd-final-product-files-prd.s3.eu-west-1.amazonaws.com/en/json/en_2_0.json"
      + "?X-Amz-Security-Token=token-value&X-Amz-Signature=signature-value";
    const stockFile = "https://midocean-prd-atp-prd.s3.amazonaws.com/atp.json"
      + "?AWSAccessKeyId=ASIAKEYVALUE&Signature=sig-value&x-amz-security-token=token-value";
    const redirect = (body: string, location: string) =>
      new Response(body, { status: 303, headers: { location, "content-type": "application/json" } });
    serve((call) => {
      if (call.host.endsWith(".amazonaws.com")) return json([{ master_code: "AR1804" }]);
      if (call.method.includes("products")) return redirect(productsFile, productsFile);
      if (call.method.includes("stock")) return redirect(JSON.stringify({ preSignedUrl: stockFile }), stockFile);
      return json([{ sku: "AR1804-03" }]);
    });
    const run = newRun();
    await runMidocean(run);
    expect(steps(run).slice(0, 4)).toEqual([
      "api.midocean.com products ok",
      "midocean-prd-final-product-files-prd.s3.eu-west-1.amazonaws.com products file ok",
      "api.midocean.com stock ok",
      "midocean-prd-atp-prd.s3.amazonaws.com stock file ok",
    ]);
    expect(failedRequired(run)).toEqual([]);
    const fileCalls = calls.filter((call) => call.host.endsWith(".amazonaws.com"));
    expect(fileCalls).toHaveLength(2);
    expect(fileCalls.every((call) => call.apiKeyHeader === undefined)).toBe(true);
    const text = filesText(run.dir);
    for (const value of ["token-value", "signature-value", "sig-value", "ASIAKEYVALUE"]) expect(text).not.toContain(value);
  });

  it.each([
    "https://files.example/catalog.json",
    "https://attacker-bucket.s3.amazonaws.com/en_2_0.json",
    "https://midocean-prd.s3.amazonaws.com.evil.example/en_2_0.json",
    "http://midocean-prd.s3.amazonaws.com/en_2_0.json",
    "https://midocean-prd.s3.amazonaws.com:8443/en_2_0.json",
    "https://user:pass@midocean-prd.s3.amazonaws.com/en_2_0.json",
  ])("does not follow %s", async (location) => {
    serve((call) => {
      if (call.method.includes("products")) return new Response("", { status: 303, headers: { location } });
      return json([{ sku: "AR1804-03" }]);
    });
    const run = newRun();
    await runMidocean(run);
    expect(calls.filter((call) => !call.host.startsWith("api.midocean.com"))).toEqual([]);
    const [products] = run.results;
    expect(products).toMatchObject({ step: "products", isOk: false });
    expect(products?.note).toMatch(/; redirect not to a Midocean file on S3, not followed$/);
    expect(products?.note).not.toContain("pass");
  });

  it("fails a redirect without Location", async () => {
    serve((call) => (call.method.includes("products") ? new Response("", { status: 303 }) : json([{ sku: "x" }])));
    const run = newRun();
    await runMidocean(run);
    expect(run.results[0]).toMatchObject({ step: "products", isOk: false, note: "redirect without Location" });
  });

  it("fails the file when S3 refuses it and keeps the echoed credentials out of the output", async () => {
    const link = "https://midocean-prd-atp-prd.s3.amazonaws.com/atp.json"
      + "?AWSAccessKeyId=ASIAKEYVALUE&Signature=sig-value&x-amz-security-token=token%2Fvalue";
    serve((call) => {
      if (call.host.endsWith(".amazonaws.com")) {
        const xml = "<Error><Code>AccessDenied</Code><AWSAccessKeyId>ASIAKEYVALUE</AWSAccessKeyId>"
          + "<SignatureProvided>sig-value</SignatureProvided><Token-0>token/value</Token-0></Error>";
        return new Response(xml, { status: 403, headers: { "content-type": "application/xml" } });
      }
      if (call.method.includes("stock")) return new Response("", { status: 303, headers: { location: link } });
      return json([{ sku: "x" }]);
    });
    const run = newRun();
    await runMidocean(run);
    expect(failedRequired(run).map((row) => [row.step, row.note])).toEqual([["stock file", "not 200"]]);
    const text = filesText(run.dir);
    expect(text).toContain("AccessDenied");
    for (const value of ["ASIAKEYVALUE", "sig-value", "token/value", "token%2Fvalue"]) expect(text).not.toContain(value);
  });
});
