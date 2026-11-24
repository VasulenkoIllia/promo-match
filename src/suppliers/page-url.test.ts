import { describe, expect, it } from "vitest";
import { supplierPageUrl } from "./page-url.js";

describe("supplierPageUrl", () => {
  it.each([
    ["V2233-03", "https://axpol.com/de/search/v2233-03.html"],
    ["P762.649", "https://axpol.com/de/search/p762649.html"],
    ["T9703.001.XS", "https://axpol.com/de/search/t9703001xs.html"],
    ["V2389/A-11", "https://axpol.com/de/search/v2389a-11.html"],
  ])("takes the dots and slashes out of the Axpol code %s on the German site", (sku, url) => {
    expect(supplierPageUrl("axpol", "V2233", { sku, externalId: null })).toBe(url);
  });

  it("names a Midocean page by the code and variant_id", () => {
    expect(supplierPageUrl("midocean", "MO9268", { sku: "MO9268-37", externalId: "10208918" }))
      .toBe("https://www.midocean.com/mo9268-37-zid10208918");
  });

  it("has no Midocean page without a variant_id", () => {
    expect(supplierPageUrl("midocean", "MO9268", { sku: "MO9268-37", externalId: null })).toBeNull();
  });

  it("names a Makito page by the model's code, not the variant's", () => {
    expect(supplierPageUrl("makito", "21008", { sku: "21008000000", externalId: "21008" }))
      .toBe("https://makito.es/epages/Makito.sf/en_GB/?ObjectPath=/Shops/Makito/Products/21008");
  });

  it("names an Inspirion page by the variant's article", () => {
    expect(supplierPageUrl("inspirion", "3331809", { sku: "56-0603190", externalId: null }))
      .toBe("https://www.inspirion.eu/de-en/product/56-0603190");
  });

  it("sends to the Macma search by the variant's code", () => {
    expect(supplierPageUrl("macma", "14469", { sku: "1446903", externalId: null }))
      .toBe("https://www.macma.de/en/search?search=1446903");
  });

  it.each(["bluecollection", "easygifts", "anda", "competitor"])("has no page for %s, a source without a rule", (source) => {
    expect(supplierPageUrl(source, "A1", { sku: "A1", externalId: "1" })).toBeNull();
  });

  it("escapes what a feed puts in a code", () => {
    expect(supplierPageUrl("axpol", "A B", { sku: "A B?x", externalId: null })).toBe("https://axpol.com/de/search/a%20b%3Fx.html");
    expect(supplierPageUrl("makito", "1/2&x", { sku: "1", externalId: null }))
      .toBe("https://makito.es/epages/Makito.sf/en_GB/?ObjectPath=/Shops/Makito/Products/1%2F2%26x");
    expect(supplierPageUrl("macma", "1", { sku: "1&a=b#c", externalId: null })).toBe("https://www.macma.de/en/search?search=1%26a%3Db%23c");
  });
});
