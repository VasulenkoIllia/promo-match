import { describe, expect, it } from "vitest";
import { supplierPageUrl } from "./page-url.js";

describe("supplierPageUrl", () => {
  it.each([
    ["V2233-03", "https://axpol.com/pl/search/v2233-03.html"],
    ["P762.649", "https://axpol.com/pl/search/p762649.html"],
    ["T9703.001.XS", "https://axpol.com/pl/search/t9703001xs.html"],
    ["V2389/A-11", "https://axpol.com/pl/search/v2389a-11.html"],
  ])("takes the dots and slashes out of the Axpol code %s", (sku, url) => {
    expect(supplierPageUrl("axpol", { sku, externalId: null })).toBe(url);
  });

  it("names a Midocean page by the code and variant_id", () => {
    expect(supplierPageUrl("midocean", { sku: "MO9268-37", externalId: "10208918" }))
      .toBe("https://www.midocean.com/mo9268-37-zid10208918");
  });

  it("has no Midocean page without a variant_id", () => {
    expect(supplierPageUrl("midocean", { sku: "MO9268-37", externalId: null })).toBeNull();
  });

  it("has no page for a source without a rule", () => {
    expect(supplierPageUrl("competitor", { sku: "A1", externalId: "1" })).toBeNull();
  });

  it("escapes what a feed puts in a code", () => {
    expect(supplierPageUrl("axpol", { sku: "A B?x", externalId: null })).toBe("https://axpol.com/pl/search/a%20b%3Fx.html");
  });
});
