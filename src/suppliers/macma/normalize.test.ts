import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { macmaPrintTechniques } from "./dictionaries.js";
import { kindOf } from "./kinds.js";
import { categoryPath, macmaPrices, materialOf, normalizeMacmaFeed } from "./normalize.js";

function tiers(ek: string[], ka: string[], quantities: string[]): Record<string, string> {
  const row: Record<string, string> = { ARTIKELNR: "1039307" };
  for (let tier = 1; tier <= 9; tier += 1) {
    row[`EKPREIS${tier}`] = ek[tier - 1] ?? "0";
    row[`KAPREIS${tier}`] = ka[tier - 1] ?? "0";
    row[`REMENGE${tier}`] = quantities[tier - 1] ?? "0";
  }
  return row;
}

describe("macmaPrices", () => {
  it("reads the purchase and catalogue scales in EUR, the purchase price of the lowest quantity primary", () => {
    const checks = new Checks();
    const prices = macmaPrices(tiers(["0.04", "0.03"], ["0.06", "0.05"], ["500", "1000"]), checks);
    expect(prices).toEqual([
      { kind: "net", currency: "EUR", minQuantity: 500, amount: "0.04", isPrimary: true, validUntil: null },
      { kind: "catalog", currency: "EUR", minQuantity: 500, amount: "0.06", isPrimary: false, validUntil: null },
      { kind: "net", currency: "EUR", minQuantity: 1000, amount: "0.03", isPrimary: false, validUntil: null },
      { kind: "catalog", currency: "EUR", minQuantity: 1000, amount: "0.05", isPrimary: false, validUntil: null },
    ]);
    expect(checks.counts).toEqual({});
  });

  it("never makes a catalogue price primary, and counts a price without its quantity", () => {
    const checks = new Checks();
    const prices = macmaPrices(tiers(["0", "2.5"], ["3.9", "3.7"], ["0", "50"]), checks);
    expect(prices.filter((price) => price.isPrimary)).toEqual([expect.objectContaining({ kind: "net", amount: "2.5", minQuantity: 50 })]);
    expect(prices).toHaveLength(2);
    expect(checks.counts).toEqual({ "price tiers without a quantity": 1 });
  });
});

describe("materialOf", () => {
  it("puts the German list in words the material parser reads, keeping an unknown part as it is", () => {
    const checks = new Checks();
    expect(materialOf("Edelstahl,Polypropylen (PP),Kunststoff (ABS),Unbekannt", checks))
      .toEqual({ en: "stainless steel, polypropylene, ABS, Unbekannt", de: "Edelstahl,Polypropylen (PP),Kunststoff (ABS),Unbekannt" });
    expect(checks.counts).toEqual({ "materials without an English name": 1 });
  });
});

describe("categoryPath and kindOf", () => {
  it("takes the first section that is not a label and the kind of the name", () => {
    const checks = new Checks();
    expect(categoryPath({ SPARTE: "PRICE HITS|WRITING" }, "Metal ball pen LUDWIKA", checks, "1")).toEqual(["WRITING", "Ball pens"]);
    expect(categoryPath({ SPARTE: "BAGS" }, "Metal pendant ADRIAN", checks, "2")).toEqual(["BAGS"]);
    expect(checks.counts).toEqual({ "models without a kind": 1 });
  });

  it("reads what a name holds before what it is made of", () => {
    expect(kindOf("Pencil with rubber STEFAN")).toBe("Pencils");
    expect(kindOf("12 coloured pencils in a tube MIA")).toBe("Colouring & art");
    expect(kindOf("Plastic ballpen with highlighter and touch function EMMETT")).toBe("Stylus & multifunction pens");
    expect(kindOf("Candle in frosted glass with bamboo lid JOSEFA")).toBe("Candles & scents");
    expect(kindOf("Rain poncho that folds into a belt bag FAUSTO")).toBe("Ponchos & raincoats");
    expect(kindOf("Cardboard gift box")).toBe("Gift & paper bags");
    expect(kindOf("Glass lunchbox with bamboo lid KYLE")).toBe("Lunch boxes & cutlery");
    expect(kindOf("Cotton gymbag Budapest")).toBe("Drawstring bags");
  });
});

describe("macmaPrintTechniques", () => {
  it("reads the codes as the product pages of macma.de name them", () => {
    expect(macmaPrintTechniques(["T1", "L11", "C2", "DTF3"])).toEqual(["laser", "pad", "transfer", "wrap"]);
    expect(macmaPrintTechniques(["ST2", "HF", "HS", "DC0"])).toEqual(["digital", "embossing", "embroidery", "screen"]);
    expect(macmaPrintTechniques(["ETN1", "0"])).toEqual([]);
    expect(macmaPrintTechniques(["OEM1"])).toEqual(["unconfirmed"]);
  });
});

describe("normalizeMacmaFeed", () => {
  const record = (sku: string, photos: string) => ({
    ...tiers(["0.07"], ["0.11"], ["500"]), ARTIKELNR: sku, INTERNETNR: "12618", HEADLINE_EN: "Solid plastic ball pen SHIRLEY",
    HEADLINE_DE: "Kunststoffkugelschreiber SHIRLEY", FARBE: "black", FARBE_DE: "schwarz", GTIN: "4064571029972",
    SPARTE: "WRITING", MATERIAL: "Kunststoff", GEWICHT: "0.008 kg", URSPRLAND: "CHINA", GROESSE: "ø 1 x 14,3 cm",
    BILDNAME: photos, DRUCK1: "T1", NETTOPREIS: "0.07", LIEFERZEIT: "5", UPSELLING: "1062006  |1112801 ",
  });

  it("groups the variants by INTERNETNR and keeps only the photos the archive has", () => {
    const catalog = normalizeMacmaFeed({
      source: "macma", feed: "macma", photoNames: new Set(["1261803.jpg", "1261804.jpg"]),
      dataSet: { records: [record("1261804", "1261804"), record("1261803", "1261803|1261803_9")], unreadRecords: 0, repairedValues: 0 },
    });
    const [model] = catalog.models;
    expect(catalog.models).toHaveLength(1);
    expect(model).toMatchObject({
      code: "12618", category: { en: ["WRITING", "Ball pens"] }, material: { en: "plastic", de: "Kunststoff" },
      weightGrams: "8", countryOfOrigin: "CN", dimensions: "ø 1 x 14,3 cm", printTechniques: ["pad"],
    });
    expect(model?.photos.map((photo) => photo.url)).toEqual([
      "https://data.promotray.de/database_macma/jpg_database_macma.zip/1261803.jpg",
      "https://data.promotray.de/database_macma/jpg_database_macma.zip/1261804.jpg",
    ]);
    expect(model?.variants.map((variant) => [variant.sku, variant.colorCode, variant.stock])).toEqual([["1261803", "03", null], ["1261804", "04", null]]);
    expect(model?.variants[0]?.attributes).toEqual({ LIEFERZEIT: "5", UPSELLING: ["1062006", "1112801"] });
    expect(catalog.checks).toEqual({ "photos not in the archive": 1 });
  });
});
