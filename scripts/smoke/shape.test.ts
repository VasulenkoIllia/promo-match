import { describe, expect, it } from "vitest";
import { REDACTED } from "../../src/suppliers/secrets.js";
import { countRecords, describeShape, firstImageUrl, sampleOf, secretValues } from "./shape.js";

// Axpol's envelope with records keyed by productId, as in the supplier's Postman collection
const axpolList = {
  message: "",
  success: 1,
  data: {
    "9217": { CodeERP: "V0901-02", Foto02: "", InStock: "5 599" },
    "9219": { CodeERP: "V0901-03", Foto02: "V0901-03_b.jpg", InStock: "0" },
  },
};

describe("describeShape", () => {
  it("walks id-keyed records as one path and counts types, empty strings apart", () => {
    const fields = describeShape(axpolList);
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get("$.data")).toMatchObject({ types: { object: 1 }, minSize: 2, maxSize: 2 });
    expect(byPath.get("$.data.{id}.Foto02")).toMatchObject({ types: { empty: 1, string: 1 }, example: "V0901-03_b.jpg" });
    expect(byPath.has("$.data.9217")).toBe(false);
  });

  it("describes arrays with their sizes and item paths", () => {
    const fields = describeShape([{ sku: "A", variants: [1, 2] }, { sku: null, variants: [] }]);
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get("$")).toMatchObject({ types: { array: 1 }, minSize: 2, maxSize: 2 });
    expect(byPath.get("$[].sku")).toMatchObject({ types: { string: 1, null: 1 }, example: "A" });
    expect(byPath.get("$[].variants")).toMatchObject({ minSize: 0, maxSize: 2 });
  });

  it("never keeps an example from under a secret-looking key, at any depth", () => {
    const fields = describeShape({ data: { jwt: "eyJhbGciOi.payload.signature", token: { value: "abc.def" } } });
    const byPath = new Map(fields.map((field) => [field.path, field]));
    expect(byPath.get("$.data.jwt")?.example).toBe(REDACTED);
    expect(byPath.get("$.data.token.value")?.example).toBe(REDACTED);
  });

  it("scrubs a secret before cutting a long example", () => {
    const secret = "secret-value-1234";
    const fields = describeShape({ url: `${"x".repeat(110)}${secret}` }, [secret]);
    expect(fields.find((field) => field.path === "$.url")?.example).not.toContain("secret-v");
  });
});

describe("countRecords", () => {
  it("counts a root array, Axpol's id-keyed data and the only array of an object", () => {
    expect(countRecords([1, 2, 3])).toBe(3);
    expect(countRecords(axpolList)).toBe(2);
    expect(countRecords({ modified_at: "x", stock: [1, 2] })).toBe(2);
  });

  it("gives no count when the response does not say", () => {
    expect(countRecords({ data: { count: "10817" } })).toBeUndefined();
    expect(countRecords({ a: [1], b: [2] })).toBeUndefined();
    expect(countRecords(undefined)).toBeUndefined();
  });
});

describe("sampleOf", () => {
  it("keeps the first records at every level and replaces secret-looking values", () => {
    const sample = sampleOf({ data: { jwt: "token", uid: "86" }, items: [[1, 2, 3], [4]], map: axpolList.data }, 1);
    expect(sample).toEqual({
      data: { jwt: REDACTED, uid: "86" },
      items: [[1]],
      map: { "9217": axpolList.data["9217"] },
    });
  });

  it("cuts long texts", () => {
    const sample = sampleOf({ text: "x".repeat(5_000) }, 1) as { text: string };
    expect(sample.text.length).toBeLessThan(5_000);
    expect(sample.text.endsWith("...")).toBe(true);
  });
});

describe("secretValues", () => {
  it("finds values under secret-looking keys near the top", () => {
    expect(secretValues({ success: 1, data: { uid: "86", jwt: "eyJ.a.b" } })).toEqual(["eyJ.a.b"]);
    expect(secretValues([{ jwt: "x" }])).toEqual([]);
  });

  it("takes the access and refresh pair of a token answer, but not a key that only contains the word", () => {
    expect(secretValues({ access: "eyJ.access.x", refresh: "eyJ.refresh.y", access_level: "full" }))
      .toEqual(["eyJ.access.x", "eyJ.refresh.y"]);
  });
});

describe("firstImageUrl", () => {
  it("finds the first picture link at any depth, in record order", () => {
    const catalog = [
      { sku: "1", url: "https://example.com/page.html", variants: [{ images: [{ image_url: "https://cdn.example.com/a.JPG" }] }] },
      { sku: "2", image: "https://cdn.example.com/b.jpg" },
    ];
    expect(firstImageUrl(catalog)).toBe("https://cdn.example.com/a.JPG");
    expect(firstImageUrl({ products: [{ image: "5246-W.jpg" }] })).toBeUndefined();
  });

  it("skips plain http and a picture extension that is only in the query", () => {
    expect(firstImageUrl(["http://cdn.example.com/a.jpg", "https://apis.example.com/orders/1?x=a.jpg"])).toBeUndefined();
  });
});
