import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { axpolPrices, axpolStock, normalizeAxpol, splitCode } from "./normalize.js";

// Records shaped like Product.List, Stock.List and Printing.List of the smoke test; prices made up
function product(productId: string, codeErp: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId, CodeERP: codeErp, EAN: "", Brand: "", TitlePL: "Notatnik A5", TitleEN: "A5 notebook", TitleDE: "", TitleFR: "",
    DescriptionEN: "PU notebook &amp; pen", MaterialEN: "PU", MainCategoryEN: "OFFICE", SubCategoryEN: "notebooks",
    MainCategoryPL: "BIURO", SubCategoryPL: "", ColorEN: "black", ColorPL: "czarny", Dimensions: "1,5 x 14,5 x 21,5 cm.",
    ItemWeightG: "19,5", CountryOfOrigin: "CN", Page: "424", Film: "",
    NetPricePLN: "3,40", CatalogPricePLN: "5.10", FinalNetPrice: 0,
    InStock: "56", reserved: "0", onOrder: "2", nextDelivery: "7 000", Days: "2-3",
    Foto: [`https://files.axpol.com/fotohr/${codeErp.toLowerCase()}__b_1.jpg`, "https://files.axpol.com/foto_add_view/shared.jpg"],
    ...extra,
  };
}

const products = new Map([
  ["6052", product("6052", "P773.425")],
  ["6051", product("6051", "P773.421")],
  ["11632", product("11632", "V6520-00", { TitleEN: "Bamboo pen", Foto: [] })],
  ["9000", product("9000", "SOLO1", { NetPricePLN: "0" })],
  ["9001", product("9001", "P773.425")],
]);
const stock = new Map([
  ["6051", { CodeERP: "P773.421", InStock: "3 030", reserved: "1", onOrder: "", nextDelivery: "20 000", Days: "2-3" }],
  ["6052", { CodeERP: "P773.425", InStock: "0", reserved: "0", onOrder: "0", nextDelivery: "", Days: "" }],
  ["7777", { CodeERP: "GONE.1", InStock: "5" }],
]);
const printing = new Map([
  ["11632", { productId: "11632", CodeERP: "V6520-00", Print: [{ PositionId: 1, Position: "opakowanie - przód", Size: "30x50", Technique: ["TF1", ""] }] }],
]);

describe("splitCode", () => {
  it("reads the code schemes of the full catalogue", () => {
    expect(splitCode("T9105.001.XL")).toEqual({ model: "T9105", color: "001", size: "XL" });
    expect(splitCode("V6520-00")).toEqual({ model: "V6520", color: "00", size: null });
    expect(splitCode("HE332-16")).toEqual({ model: "HE332", color: "16", size: null });
    expect(splitCode("V7330/A-05")).toEqual({ model: "V7330/A", color: "05", size: null });
    expect(splitCode("P322.081")).toEqual({ model: "P322.08", color: "1", size: null });
    expect(splitCode("P322.4901")).toEqual({ model: "P322.490", color: "1", size: null });
  });

  it("keeps a code it cannot read as a model of its own", () => {
    expect(splitCode("symbol")).toEqual({ model: "symbol", color: null, size: null });
    expect(splitCode("P322.A")).toEqual({ model: "P322.A", color: null, size: null });
    expect(splitCode("-5")).toEqual({ model: "-5", color: null, size: null });
  });
});

describe("axpolPrices", () => {
  it("makes NetPricePLN primary and keeps the others beside it, without zero prices", () => {
    expect(axpolPrices({ NetPricePLN: "3,40", CatalogPricePLN: "5.10", FinalNetPrice: 0 }, new Checks())).toEqual([
      { kind: "net", currency: "PLN", minQuantity: 1, amount: "3.40", isPrimary: true, validUntil: null },
      { kind: "catalog", currency: "PLN", minQuantity: 1, amount: "5.10", isPrimary: false, validUntil: null },
    ]);
    expect(axpolPrices({ NetPricePLN: "", FinalNetPrice: 9.5 }, new Checks())).toEqual([
      { kind: "final", currency: "PLN", minQuantity: 1, amount: "9.5", isPrimary: false, validUntil: null },
    ]);
  });

  it("counts a price it cannot read, but not a price of 0", () => {
    const checks = new Checks();
    expect(axpolPrices({ CodeERP: "V1-00", NetPricePLN: "n/a", CatalogPricePLN: "-3", FinalNetPrice: "0,00" }, checks)).toEqual([]);
    expect(checks.counts).toEqual({ "unreadable NetPricePLN prices": 1, "unreadable CatalogPricePLN prices": 1 });
    expect(checks.examples["unreadable NetPricePLN prices"]).toEqual(["V1-00"]);
  });
});

describe("axpolStock", () => {
  it("reads numbers with spaces and leaves the missing ones empty", () => {
    expect(axpolStock({ InStock: "3 030", reserved: "1", onOrder: "", nextDelivery: "20 000", Days: "2-3" }, new Checks())).toEqual({
      inStock: 3030, reserved: 1, onOrder: null, nextArrivalQuantity: 20_000, nextArrivalDate: null, leadTime: "2-3",
      arrivals: [], sourceUpdatedAt: null,
    });
    expect(axpolStock({ InStock: "" }, new Checks())).toBeNull();
    expect(axpolStock(undefined, new Checks())).toBeNull();
  });

  it("counts a quantity it cannot read", () => {
    const checks = new Checks();
    expect(axpolStock({ CodeERP: "V1-00", InStock: "lots" }, checks)).toBeNull();
    expect(checks.counts).toEqual({ "unreadable stock quantities": 1 });
  });
});

describe("normalizeAxpol", () => {
  const snapshot = normalizeAxpol({ products, stock, printing });
  const byCode = new Map(snapshot.models.map((model) => [model.code, model]));

  it("groups colours into models sorted by code", () => {
    expect(snapshot.models.map((model) => model.code)).toEqual(["P773.42", "SOLO1", "V6520"]);
    expect(byCode.get("P773.42")?.variants.map((variant) => variant.sku)).toEqual(["P773.421", "P773.425"]);
    expect(byCode.get("P773.42")?.variants[0]?.colorCode).toBe("1");
  });

  it("cleans the model's texts and numbers", () => {
    expect(byCode.get("P773.42")).toMatchObject({
      name: { pl: "Notatnik A5", en: "A5 notebook" },
      description: { en: "PU notebook & pen" },
      category: { en: ["OFFICE", "notebooks"], pl: ["BIURO"] },
      weightGrams: "19.5",
      brand: null,
    });
  });

  it("keeps one photo per URL with the variants that show it", () => {
    const photos = byCode.get("P773.42")?.photos ?? [];
    expect(photos.map((photo) => photo.url)).toEqual([
      "https://files.axpol.com/fotohr/p773.421__b_1.jpg",
      "https://files.axpol.com/foto_add_view/shared.jpg",
      "https://files.axpol.com/fotohr/p773.425__b_1.jpg",
    ]);
    expect(photos[1]?.variantLinks).toEqual([{ sku: "P773.421", position: 1 }, { sku: "P773.425", position: 1 }]);
  });

  it("joins stock and printing by CodeERP", () => {
    expect(byCode.get("P773.42")?.variants[0]?.stock?.inStock).toBe(3030);
    expect(byCode.get("V6520")?.variants[0]?.printing).toEqual([
      { positionId: 1, name: { pl: "opakowanie - przód" }, size: "30x50", techniques: ["TF1"] },
    ]);
  });

  it("keeps the unmapped fields as attributes, never the prices", () => {
    const attributes = byCode.get("P773.42")?.variants[0]?.attributes ?? {};
    expect(attributes).toEqual({ Page: "424" });
  });

  it("counts what the report should show", () => {
    expect(snapshot.checks).toMatchObject({
      "products with a repeated CodeERP": 1,
      "codes that are a model of their own (no colour or size)": 1,
      "variants without stock": 2,
      "variants without a net price": 1,
      "variants without photos": 1,
      "stock records without a product": 1,
    });
    expect(snapshot.examples["stock records without a product"]).toEqual(["GONE.1"]);
  });

  it("keeps every raw record by its feed and key", () => {
    expect(snapshot.raw.filter((raw) => raw.feed === "Product.List")).toHaveLength(5);
    expect(snapshot.raw.find((raw) => raw.feed === "Stock.List" && raw.externalId === "7777")).toBeDefined();
  });
});
