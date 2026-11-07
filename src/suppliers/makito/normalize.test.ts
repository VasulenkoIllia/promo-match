import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { categoryOf, makitoPrices, makitoStock, normalizeMakito, perPiece, variantCodeOf } from "./normalize.js";
import { makitoAreaTechniques, makitoPrintTechniques, mergePrintFacts } from "./print-names.js";

const ASSETS = "https://apis.makito.es/catalog/assets";

describe("perPiece", () => {
  it("moves the point on the digits, without a float", () => {
    expect(perPiece("1500.00", 3)).toBe("1.5");
    expect(perPiece("120.00", 3)).toBe("0.12");
    expect(perPiece("30.00", 3)).toBe("0.03");
    expect(perPiece("4385.5", 3)).toBe("4.3855");
    expect(perPiece("12", 0)).toBe("12");
    expect(perPiece("12000", 3)).toBe("12");
  });
});

describe("makitoPrices", () => {
  it("prices a piece from the price of 1000, the smallest quantity primary", () => {
    const checks = new Checks();
    const prices = makitoPrices({
      material: "15255", currency: "EUR", baseQuantity: "1000",
      scales: [{ quantity: "500", amount: "110.00" }, { quantity: "1", amount: "120.00" }],
    }, checks);
    expect(prices).toEqual([
      { kind: "net", currency: "EUR", minQuantity: 1, amount: "0.12", isPrimary: true, validUntil: null },
      { kind: "net", currency: "EUR", minQuantity: 500, amount: "0.11", isPrimary: false, validUntil: null },
    ]);
    expect(checks.counts).toEqual({});
  });

  it("refuses a base it cannot divide by and counts it", () => {
    const checks = new Checks();
    expect(makitoPrices({ material: "1", currency: "EUR", baseQuantity: "250", scales: [{ quantity: "1", amount: "5" }] }, checks))
      .toEqual([]);
    expect(makitoPrices({ material: "2", currency: "euro", baseQuantity: "1000", scales: [] }, checks)).toEqual([]);
    expect(checks.counts).toEqual({
      "prices per a quantity that is not a power of ten": 1, "prices without an ISO currency": 1,
    });
  });

  it("counts what the column rounds and leaves out a price that rounds to nothing", () => {
    const checks = new Checks();
    const prices = makitoPrices({
      material: "3", currency: "EUR", baseQuantity: "1000",
      scales: [
        { quantity: "1", amount: "1.55" }, { quantity: "100", amount: "0.05" }, { quantity: "200", amount: "1.50" },
        { quantity: "200", amount: "1.40" },
      ],
    }, checks);
    expect(prices.map((price) => price.amount)).toEqual(["0.00155", "0.0015"]);
    expect(checks.counts).toEqual({
      "prices rounded to 4 places": 1, "prices below 0.0001 a piece": 1, "price scales with a repeated quantity": 1,
    });
  });
});

describe("makitoStock", () => {
  it("reads the stock now and the dated arrivals in date order", () => {
    const checks = new Checks();
    const stock = makitoStock([
      { material: "11017000000", quantity: 170000, availableDate: "2027-02-11T00:00:00Z" },
      { material: "11017000000", quantity: 20 },
      { material: "11017000000", quantity: 36000, availableDate: "2026-11-23T00:00:00Z" },
    ], "2026-11-04T18:00:13Z", checks, "11017000000");
    expect(stock).toEqual({
      inStock: 20, reserved: null, onOrder: null, nextArrivalQuantity: 36000, nextArrivalDate: "2026-11-23", leadTime: null,
      arrivals: [{ date: "2026-11-23", quantity: 36000 }, { date: "2027-02-11", quantity: 170000 }],
      sourceUpdatedAt: "2026-11-04T18:00:13Z",
    });
    expect(makitoStock(undefined, null, checks, "x")).toBeNull();
  });
});

describe("variantCodeOf", () => {
  it("takes the code from the folder of the variant's photo, else from ref, colour and size", () => {
    expect(variantCodeOf("12008C", { variant_image: `${ASSETS}/12008C/12009001000/principal/2008C-001-P.jpg` }))
      .toBe("12009001000");
    expect(variantCodeOf("15246", { variant_image: null, variant_colorcode: "003", variant_size: "000" })).toBe("15246003000");
    expect(variantCodeOf("13020", { variant_image: null, variant_colorcode: "008", variant_size: null })).toBeNull();
    expect(variantCodeOf("12008C", { variant_image: null, variant_colorcode: "227", variant_size: "000" })).toBeNull();
  });
});

describe("categoryOf", () => {
  it("takes the deepest kind of product, leaving out labels, ranges and print techniques", () => {
    expect(categoryOf([
      "Production > PRODUCTS > Sustainable Items > Sustainable Items",
      "Production > PRODUCTS > Summer And Beach > OUTDOOR SEASON",
      "Production > PRODUCTS > Writing > Pens > Pens",
      "Production > PRODUCTS > Marking Techniques > Marking Techniques > Pad Printing",
      "Production > PRODUCTS > Writing",
      "Production > Catalogues",
    ])).toEqual({ path: ["Writing", "Pens", "Pens"], techniques: ["Pad Printing"] });
    expect(categoryOf(["Production > PRODUCTS > Summer And Beach > OUTDOOR SEASON"]).path).toEqual(["Summer And Beach", "OUTDOOR SEASON"]);
    expect(categoryOf(["Production > PRODUCTS > News", "Production > "])).toEqual({ path: null, techniques: [] });
  });
});

describe("makitoPrintTechniques", () => {
  it("reads the technique names, a transfer before digital", () => {
    expect(makitoPrintTechniques(["Serigraphy", "Digital Transfer", "Digital 360º", "Circular Laser", "Thermo-Engraving"]))
      .toEqual(["digital", "embossing", "laser", "screen", "transfer", "wrap"]);
    expect(makitoPrintTechniques(["Catrichomy"])).toEqual(["unconfirmed"]);
  });
});

describe("makitoAreaTechniques", () => {
  // One name at a time: the order of the rules (a transfer before digital, 360 before digital, circular before screen) and
  // the wrap of a round print would not show in a union of many names
  it.each([
    ["PAD PRINTING K", ["pad"]],
    ["PAD PRINT MAT ESP B", ["pad"]],
    ["SCREEN PRINTING H SUNSHADE", ["screen"]],
    ["AUTOMATIC SCREEN E", ["screen"]],
    ["UMBRELLA SCREEN F", ["screen"]],
    ["CIRCULAR SCREEN B", ["screen", "wrap"]],
    ["SERIGRAFIA CIRCULAR I", ["screen", "wrap"]],
    ["LASER ENGRAVING 2", ["laser"]],
    ["LASER ENGRAVING - SPECIAL OFFER", ["laser"]],
    ["TRANSFER N1", ["transfer"]],
    ["DIGITAL TRANSFER PRINT (FULLCOLOR)", ["transfer"]],
    ["DTF2 (FULLCOLOR)", ["transfer"]],
    ["DIGITAL W3 (-25 cm2) (FULLCOLOR)", ["digital"]],
    ["DIGITAL PRINT", ["digital"]],
    ["DIGITAL 360 WR1 -5cm (FULLCOLOR)", ["digital", "wrap"]],
    ["EMBROIDERY W (FULLCOLOR)", ["embroidery"]],
    ["SUBLIMATION TECHNOLOGY SMALL SIZE (-100cm2) (FULLCOLOR)", ["sublimation"]],
    ["SUBLIMACION CIN", ["sublimation"]],
    ["DOMING - V1 -5 cm2 (FULLCOLOR)", ["doming"]],
    ["FULL COLOR + DOMING", ["doming"]],
  ])("reads the price list's name %s", (name, facts) => {
    expect(makitoAreaTechniques([name])).toEqual(facts);
  });

  it("leaves a name nothing explains, and an unknown id, unconfirmed", () => {
    for (const name of ["CUATRICOMIA PRINT X (FULLCOLOR)", "DRY WOODBURNING", "PRINTING 1 COLOR + SEWING + NON-WOVEN RIBBON", "CANVAS PRINT", ""]) {
      expect(makitoAreaTechniques([name]), name).toEqual(["unconfirmed"]);
    }
    expect(makitoAreaTechniques([])).toEqual([]);
  });
});

describe("mergePrintFacts", () => {
  it("keeps the categories' techniques and adds the areas'", () => {
    expect(mergePrintFacts(["screen"], ["pad"])).toEqual(["pad", "screen"]);
    expect(mergePrintFacts(["unconfirmed"], ["pad"])).toEqual(["pad", "unconfirmed"]);
    expect(mergePrintFacts([], ["laser", "wrap"])).toEqual(["laser", "wrap"]);
  });

  it("takes the areas' unconfirmed only when nothing is known", () => {
    expect(mergePrintFacts(["screen"], ["unconfirmed"])).toEqual(["screen"]);
    expect(mergePrintFacts(["screen"], ["pad", "unconfirmed"])).toEqual(["pad", "screen"]);
    expect(mergePrintFacts([], ["unconfirmed"])).toEqual(["unconfirmed"]);
    expect(mergePrintFacts([], [])).toEqual([]);
  });
});

describe("normalizeMakito", () => {
  const feeds = {
    catalog: {
      generatedAt: "2026-11-04T01:02:39Z",
      products: [{
        ref: "15246", web_reference: "5246", name: "Komir", type: "Action Camera", description: "<p>Sports camera</p>",
        material: null, length: 120, height: 230, width: 58, diameter: null, weight: false, printcode: "K(4)",
        categories: [
          "Production > PRODUCTS > Technology And Accessories > Others > Cameras",
          "Production > PRODUCTS > Marking Techniques > Marking Techniques > Serigraphy",
        ],
        image: `${ASSETS}/15246/principal/5246-W.jpg`,
        detail_images: [`${ASSETS}/15246/details/5246-D1.jpg`],
        variants: [
          { variant_reference: "5246ROJS/T", variant_image: `${ASSETS}/15246/15246003000/principal/5246-003-P.jpg`,
            variant_colorcode: "003", variant_size: "000" },
          { variant_reference: "5246VERS/T", variant_image: null, variant_colorcode: "777", variant_size: "102" },
        ],
      }],
    },
    stock: { generatedAt: "2026-11-04T18:00:13Z", stocks: [{ material: "15246003000", quantity: 40 }, { material: "99999000000", quantity: 1 }] },
    prices: { priceList: [{ material: "15246", currency: "EUR", baseQuantity: "1000", scales: [{ quantity: "1", amount: "1500.00" }] }] },
    colors: [{ colorCode: "003", colorTitle: "Red" }],
    sizes: [{ sizeCode: "102", sizeTitle: "M" }],
  };

  it("joins the feeds by the codes Makito uses and counts what does not join", () => {
    const catalog = normalizeMakito(feeds);
    const [model] = catalog.models;
    expect(model?.code).toBe("5246");
    expect(model?.externalId).toBe("15246");
    expect(model?.name).toEqual({ en: "Action Camera Komir" });
    expect(model?.category).toEqual({ en: ["Technology And Accessories", "Others", "Cameras"] });
    expect(model?.dimensions).toBe("120 x 58 x 230 mm");
    expect(model?.printTechniques).toEqual(["screen"]);
    expect(model?.variants.map((variant) => [variant.sku, variant.color, variant.size, variant.stock?.inStock ?? null]))
      .toEqual([["15246003000", { en: "Red" }, null, 40], ["15246777102", {}, "M", null]]);
    expect(model?.variants[0]?.prices.map((price) => price.amount)).toEqual(["1.5"]);
    expect(model?.photos.map((photo) => [photo.url.replace(ASSETS, ""), photo.variantLinks])).toEqual([
      ["/15246/15246003000/principal/5246-003-P.jpg", [{ sku: "15246003000", position: 0 }]],
      ["/15246/principal/5246-W.jpg", [{ sku: "15246003000", position: 1 }, { sku: "15246777102", position: 0 }]],
      ["/15246/details/5246-D1.jpg", [{ sku: "15246003000", position: 2 }, { sku: "15246777102", position: 1 }]],
    ]);
    expect(catalog.checks).toEqual({
      "variants without a photo of their own": 1, "colour codes not in the colour list": 1, "variants without stock": 1,
      "stock records without a variant": 1,
    });
  });

  describe("print areas", () => {
    const printNames = { printPriceList: [{ id: "100123", code: "K", category: "PAD PRINTING K" }, { id: "100400", code: "L1", category: "LASER ENGRAVING 1" }] };
    const printConfig = { products: [{ id: "15246", areas: [{ id: "A1", techniques: "100123(4),100400" }] }] };
    const [product] = feeds.catalog.products;
    const noMarkingCategories = { products: [{ ...product, categories: ["Production > PRODUCTS > Technology And Accessories > Others > Cameras"] }] };

    it("adds the techniques of the areas to those of the categories and keeps the areas as raw records", () => {
      const catalog = normalizeMakito({ ...feeds, printConfig, printNames });
      expect(catalog.models[0]?.printTechniques).toEqual(["laser", "pad", "screen"]);
      expect(catalog.fetched).toMatchObject({ "print-config": 1, "print-price-list": 2 });
      expect(catalog.raw.filter((record) => record.feed === "print-config").map((record) => record.externalId)).toEqual(["15246"]);
      expect(catalog.warnings).toEqual([]);
    });

    it("gives a model that has no marking categories the techniques of its areas", () => {
      const catalog = normalizeMakito({ ...feeds, catalog: noMarkingCategories, printConfig, printNames });
      expect(catalog.models[0]?.printTechniques).toEqual(["laser", "pad"]);
    });

    it("counts a model print-config does not have and leaves its techniques as they were", () => {
      const catalog = normalizeMakito({ ...feeds, printConfig: { products: [{ id: "99999", areas: [] }] }, printNames });
      expect(catalog.models[0]?.printTechniques).toEqual(["screen"]);
      expect(catalog.checks["models not in print-config"]).toBe(1);
      expect(catalog.checks["models in print-config without areas"]).toBe(1);
    });

    it("warns, and falls back to the categories, on files that are not the ones they should be", () => {
      for (const broken of [{ printConfig: { products: [] }, printNames }, { printConfig, printNames: [] }]) {
        const catalog = normalizeMakito({ ...feeds, ...broken });
        expect(catalog.models[0]?.printTechniques).toEqual(["screen"]);
        expect(catalog.warnings).toHaveLength(1);
        expect(catalog.fetched).not.toHaveProperty("print-config");
      }
      expect(normalizeMakito(feeds).warnings).toEqual([]);
    });
  });

  it("leaves out a link of Makito's that is not a photo file and counts it", () => {
    const [product] = feeds.catalog.products;
    const catalog = normalizeMakito({
      ...feeds,
      catalog: { products: [{
        ...product, image: `${ASSETS}/14509/principal/`,
        detail_images: [`${ASSETS}/11114/11114193000/principal/11114-193-P.jpg, 1114-193-P.jpg`],
      }] },
    });
    expect(catalog.models[0]?.photos.map((photo) => photo.url)).toEqual([`${ASSETS}/15246/15246003000/principal/5246-003-P.jpg`]);
    expect(catalog.checks["photo links that are not a photo file"]).toBe(2);
  });

  it("stops on a feed that is not the file it should be", () => {
    expect(() => normalizeMakito({ ...feeds, stock: [] })).toThrow("stock: not an object");
    expect(() => normalizeMakito({ ...feeds, colors: { colors: [] } })).toThrow("colors: no array of records");
  });
});
