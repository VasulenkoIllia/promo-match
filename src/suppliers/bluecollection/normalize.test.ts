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
  discount_prices: true, price_source: "discount", no_discount: false,
});
const promotion = (index: string, tiers: unknown[] = [{ from_qty: 1, pln: "0.20", eur: "0.05" }]) => ({
  index, active: true, is_current: true, no_discount: true, tiers,
});
const categories = [{ id: 3, pl: "Do pisania", en: "Stationery and other" }];
const subcategories = [{ id: 99, pl: "Wkłady", en: null, category: 3 }];

describe("modelCodeOf", () => {
  it("drops the colour after the last dash, an index without one is its own model", () => {
    expect(["02003-03", "01234-03A", "03016", "12345A"].map(modelCodeOf)).toEqual(["02003", "01234", "03016", "12345A"]);
  });
});

describe("bluecollectionPrices", () => {
  const euro = (net: string) => [
    { kind: "net", currency: "EUR", minQuantity: 1, amount: net, isPrimary: true, validUntil: null },
    { kind: "catalog", currency: "EUR", minQuantity: 1, amount: "0.12", isPrimary: false, validUntil: null },
  ];

  it("takes our discount off the EUR catalogue price where discount_prices says it applies, whatever the account's currency", () => {
    const checks = new Checks();
    expect(bluecollectionPrices(product("02003-03", "niebieski"), undefined, checks)).toEqual(euro("0.066"));
    expect(bluecollectionPrices({ ...product("x", ""), currency: "EUR", purchase_price: "0.07" }, undefined, checks)).toEqual(euro("0.066"));
    expect(checks.counts).toEqual({});
  });

  it("keeps the whole EUR catalogue price without the discount, and on a mark it cannot read", () => {
    const checks = new Checks();
    const base = { ...product("x", ""), discount_prices: false, price_source: "base", purchase_price: "0.50" };
    expect(bluecollectionPrices(base, undefined, checks)).toEqual(euro("0.12"));
    expect(bluecollectionPrices({ ...base, discount_prices: "yes" }, undefined, checks)).toEqual(euro("0.12"));
    expect(checks.counts).toEqual({ "discount_prices values other than true or false": 1 });
  });

  it("prices a current promotion by its EUR price for one piece, no discount on it", () => {
    const checks = new Checks();
    const promo = { ...product("x", ""), price_source: "promo", no_discount: true };
    expect(bluecollectionPrices(promo, promotion("x"), checks)).toEqual(euro("0.05"));
    const tiers = [{ from_qty: 100, eur: "0.04" }, { from_qty: 1, eur: "0.045" }];
    expect(bluecollectionPrices(promo, promotion("x", tiers), checks)).toEqual(euro("0.045"));
    expect(checks.counts).toEqual({});
  });

  it("keeps the regular price for one piece when a promotion starts at a larger lot", () => {
    const checks = new Checks();
    const tiers = [{ from_qty: 500, eur: "0.04" }, { from_qty: 1000, eur: "0.03" }];
    expect(bluecollectionPrices(product("x", ""), promotion("x", tiers), checks)).toEqual(euro("0.066"));
    expect(checks.counts).toEqual({ "promotions only from more than one piece, the regular price taken": 1 });
  });

  it("falls back to the rule, and says so, when a promotion has no EUR price or a promo price has no promotion", () => {
    const checks = new Checks();
    const promo = { ...product("x", ""), price_source: "promo", no_discount: true };
    expect(bluecollectionPrices(promo, promotion("x", [{ from_qty: 1, pln: "0.20", eur: null }]), checks)).toEqual(euro("0.066"));
    expect(bluecollectionPrices(promo, undefined, checks)).toEqual(euro("0.066"));
    expect(checks.counts).toEqual({
      "promotions without an EUR price, the regular price taken": 1, "promo prices without a current promotion": 1,
    });
  });

  it("counts a promotion above the regular price, one without tiers and one that does not say it is current", () => {
    const checks = new Checks();
    expect(bluecollectionPrices(product("x", ""), promotion("x", [{ from_qty: 1, eur: "0.10" }]), checks)).toEqual(euro("0.10"));
    expect(bluecollectionPrices(product("x", ""), { ...promotion("x"), tiers: null }, checks)).toEqual(euro("0.066"));
    expect(checks.counts).toEqual({
      "promotions above the regular price, the promotion taken": 1, "promotions without tiers": 1,
    });
    const products = [product("02003-03", "niebieski")];
    const undated = { ...promotion("02003-03"), is_current: undefined };
    const past = { ...promotion("02003-03"), is_current: false };
    const catalog = normalizeBluecollection({ products, categories, subcategories, promotions: [past, undated, promotion("02003-03")] });
    expect(catalog.models[0]?.variants[0]?.prices[0]?.amount).toBe("0.05");
    expect(catalog.checks).toMatchObject({ "promotions not current, left out": 1, "promotions without is_current or active": 1 });
    expect(catalog.checks["promotions records with a repeated index"]).toBeUndefined();
  });

  it("has no net price without an EUR catalogue price, unless a promotion gives one", () => {
    const checks = new Checks();
    const bare = { ...product("x", ""), prices: [{ pln: "0.50", eur: null }] };
    expect(bluecollectionPrices(bare, undefined, checks)).toEqual([]);
    expect(bluecollectionPrices(bare, promotion("x"), checks)).toEqual([euro("0.05")[0]]);
    expect(bluecollectionPrices({ ...product("x", ""), prices: [{ eur: 1e-7 }] }, undefined, checks)).toEqual([
      { kind: "catalog", currency: "EUR", minQuantity: 1, amount: "1e-7", isPrimary: false, validUntil: null },
    ]);
    expect(checks.counts).toEqual({ "EUR catalogue prices not in plain digits": 1 });
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
    const catalog = normalizeBluecollection({ products, categories, subcategories, promotions: [] });
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
    const catalog = normalizeBluecollection({ products: [withBoth, withAdditional, withNeither], categories, subcategories, promotions: [] });
    expect(catalog.models.map((model) => [model.code, model.material])).toEqual([
      ["19218", { en: "plastic" }],
      ["19575", { en: "metal, leather-like material (PU)", pl: "metal", cs: "kov" }],
      ["19600", {}],
    ]);
  });

  it("leaves out the supplier's printed catalogues and counts them", () => {
    const printed = { ...product("26810", "biały"), subcategory: 154 };
    const samples = { ...product("26900", "biały"), subcategory: 155 };
    const catalog = normalizeBluecollection({ products: [product("02004", "fuksjowy"), printed, samples], categories, subcategories, promotions: [] });
    expect(catalog.models.map((model) => model.code)).toEqual(["02004", "26900"]);
    expect(catalog.checks).toMatchObject({ "printed catalogues left out": 1 });
    expect(catalog.examples["printed catalogues left out"]).toEqual(["26810"]);
  });

  it("stops on an empty product or category list", () => {
    expect(() => normalizeBluecollection({ products: [], categories, subcategories, promotions: [] })).toThrow("products: no records");
    expect(() => normalizeBluecollection({ products: [product("1-1", "")], categories: [], subcategories, promotions: [] })).toThrow("categories");
  });

  it("takes a day without promotions, keeps the current ones as raw records and counts the rest", () => {
    const products = [product("02003-03", "niebieski"), product("02003-12", "czarny")];
    const promotions = [promotion("02003-03"), { ...promotion("02003-12"), is_current: false }, promotion("99999")];
    const catalog = normalizeBluecollection({ products, categories, subcategories, promotions });
    expect(catalog.models[0]?.variants.map((variant) => variant.prices[0]?.amount)).toEqual(["0.05", "0.066"]);
    expect(catalog.raw.filter((raw) => raw.feed === "promo-prices").map((raw) => raw.externalId)).toEqual(["02003-03", "99999"]);
    expect(catalog.fetched).toMatchObject({ promotions: 2 });
    expect(catalog.checks).toMatchObject({ "promotions not current, left out": 1, "promotions of an index not in the products": 1 });
    expect(() => normalizeBluecollection({ products, categories, subcategories, promotions: null })).toThrow("promotions: no array");
  });
});
