import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { bluecollectionPrintTechniques, markingNames } from "./dictionaries.js";
import { bluecollectionPrices, modelCodeOf, normalizeBluecollection } from "./normalize.js";

// Records shaped like client-products of 2026-11-04; prices made up
const additional = (colour: string, extra: Record<string, unknown> = {}) => Object.entries({
  color_product: colour, color_code: "13", ean_code: "5905179623393", dimensions: "104.00 x 3.00 x 0.00",
  unit_weight: "0.0010", country_origin: "Chiny", capacity_ml: "", ...extra,
}).map(([item, value]) => ({ item, value }));
const product = (index: string, colour: string, marking: unknown[] = [], options: string[] = []) => ({
  id: 2247, index, quantity: 1733, active: true, category: 3, subcategory: 99,
  names: [{ language: "pl", title: "Wkład typ X20" }, { language: "en", title: "Refill - X20 type" }, { language: "cz", title: "Náplň" }],
  descriptions: [{ language: "en", text: "Refill which allows you to use your pen longer." }],
  madeof: [{ language: "en", text: "plastic" }], marking,
  marking_data: [{ marking_place: [{ code: "M01", name_pl: "Przód", marking_option: options.map((code) => ({ option_code: code, max_colors: 1 })) }] }],
  additional: additional(colour), future_delivery: [{ quantity: 5000, date: "2027-02-19" }, { quantity: 200, date: "2026-12-11" }],
  image: [{ url: `https://bluecollection.eu/assets/img/${index}.jpg` }, { url: "https://bluecollection.eu/assets/img/shared.jpg" }],
  prices: [{ pln: "0.50", eur: "0.12" }], currency: "PLN", catalogue_price: "0.50", purchase_price: "0.30", sync_flags: {},
});
const categories = [{ id: 3, pl: "Do pisania", en: "Stationery and other" }];
const subcategories = [{ id: 99, pl: "Wkłady", en: null, category: 3 }];

describe("modelCodeOf", () => {
  it("drops the colour after the last dash, an index without one is its own model", () => {
    expect(["02003-03", "01234-03A", "03016", "12345A"].map(modelCodeOf)).toEqual(["02003", "01234", "03016", "12345A"]);
  });
});

describe("bluecollectionPrices", () => {
  it("makes the purchase price primary and the catalogue price of the account's currency its neighbour", () => {
    const checks = new Checks();
    expect(bluecollectionPrices(product("02003-03", "niebieski"), checks)).toEqual([
      { kind: "net", currency: "PLN", minQuantity: 1, amount: "0.30", isPrimary: true, validUntil: null },
      { kind: "catalog", currency: "PLN", minQuantity: 1, amount: "0.50", isPrimary: false, validUntil: null },
    ]);
    expect(bluecollectionPrices({ ...product("x", ""), purchase_price: null }, checks)).toMatchObject([{ kind: "catalog", isPrimary: false }]);
    expect(bluecollectionPrices({ ...product("x", ""), currency: "zł" }, checks)).toEqual([]);
    expect(checks.counts).toEqual({ "prices without an ISO currency": 1 });
  });
});

describe("bluecollectionPrintTechniques", () => {
  it("reads the Polish names and the letters of the option codes, a screen transfer as a transfer", () => {
    expect(markingNames("Tampodruk(60.00x50.00)(Przód, tył),Sitodruk Transfer F1(190.00x100.00)(Przód)"))
      .toEqual(["Tampodruk", "Sitodruk Transfer F1"]);
    expect(bluecollectionPrintTechniques(["Tampodruk(60.00x50.00)(Przód),Sitodruk Transfer F1(1x1)(Tył)"], ["G5", "T1", "U5"]))
      .toEqual(["digital", "embossing", "laser", "pad", "transfer"]);
    expect(bluecollectionPrintTechniques(["Nadruk 3D(1x1)(Przód)"], ["X9"])).toEqual(["unconfirmed"]);
  });
});

describe("normalizeBluecollection", () => {
  it("groups the colours of a model, translates the Polish colour and reads sizes, weight and country", () => {
    const products = [
      product("02003-03", "niebieski", [{ language: "pl", text: "Tampodruk(60.00x50.00)(Przód)" }]),
      product("02003-12", "czarny", [], ["G5"]),
      product("02004", "fuksjowy"),
    ];
    const catalog = normalizeBluecollection({ products, categories, subcategories });
    expect(catalog.models.map((model) => [model.code, model.variants.map((variant) => variant.sku)]))
      .toEqual([["02003", ["02003-03", "02003-12"]], ["02004", ["02004"]]]);
    const [model] = catalog.models;
    expect(model).toMatchObject({
      name: { en: "Refill - X20 type", pl: "Wkład typ X20", cs: "Náplň" }, material: { en: "plastic" },
      category: { en: ["Stationery and other", "Wkłady"] }, categoryCode: "99", dimensions: "104 x 3 mm",
      weightGrams: "1", countryOfOrigin: "CN", printTechniques: ["laser", "pad"],
    });
    expect(model?.variants[0]).toMatchObject({
      color: { en: "blue", pl: "niebieski" }, colorCode: "13", ean: "5905179623393", externalId: "2247",
      stock: { inStock: 1733, nextArrivalDate: "2026-12-11", nextArrivalQuantity: 200 },
    });
    expect(model?.photos.find((photo) => photo.url.endsWith("shared.jpg"))?.variantLinks)
      .toEqual([{ sku: "02003-03", position: 1 }, { sku: "02003-12", position: 1 }]);
    expect(catalog.models[1]?.variants[0]?.color).toEqual({ pl: "fuksjowy" });
    expect(catalog.checks).toMatchObject({ "colours without an English name": 1, "categories without an English name": 2 });
  });

  it("takes the material from madeof, or from the additional values of the first colour when madeof has none", () => {
    const materials = { material_en: "metal, leather-like material (PU)", material_pl: "metal", material_cz: "kov", material_detailed: "x" };
    const withBoth = { ...product("19218-02", "czarny"), additional: additional("czarny", materials) };
    const withAdditional = { ...withBoth, index: "19575", madeof: [] };
    const withNeither = { ...product("19600", "czarny"), madeof: [] };
    const catalog = normalizeBluecollection({ products: [withBoth, withAdditional, withNeither], categories, subcategories });
    expect(catalog.models.map((model) => [model.code, model.material])).toEqual([
      ["19218", { en: "plastic" }],
      ["19575", { en: "metal, leather-like material (PU)", pl: "metal", cs: "kov" }],
      ["19600", {}],
    ]);
  });

  it("leaves out the supplier's printed catalogues and counts them", () => {
    const printed = { ...product("26810", "biały"), subcategory: 154 };
    const samples = { ...product("26900", "biały"), subcategory: 155 };
    const catalog = normalizeBluecollection({ products: [product("02004", "fuksjowy"), printed, samples], categories, subcategories });
    expect(catalog.models.map((model) => model.code)).toEqual(["02004", "26900"]);
    expect(catalog.checks).toMatchObject({ "printed catalogues left out": 1 });
    expect(catalog.examples["printed catalogues left out"]).toEqual(["26810"]);
  });

  it("stops on an empty product or category list", () => {
    expect(() => normalizeBluecollection({ products: [], categories, subcategories })).toThrow("products: no records");
    expect(() => normalizeBluecollection({ products: [product("1-1", "")], categories: [], subcategories })).toThrow("categories");
  });
});
