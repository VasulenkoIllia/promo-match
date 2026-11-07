import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { FeedError } from "../errors.js";
import { inspirionPrices, inspirionStock, normalizeInspirion } from "./normalize.js";
import { inspirionPrintTechniques } from "./print-keys.js";

// Feeds shaped like the smoke test's files of 2026-11-04; prices made up
const images = (sku: string, dpi: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ image_url: `https://media.inspirion.eu/${dpi}/${sku}_MODERN_0${index + 1}.jpg` }));
const variant = (sku: string, colour: string, size: Record<string, unknown>) => ({
  article_id: sku, colour, ean: "4035475097435", size, weight: { net: "10.000", gross: "11.000", unit: "g" },
  volume: { volume: "39.644", volume_unit: "cm³" }, images: images(sku, 72, 2), images_300: images(sku, 300, 2),
  images_default: [], categories: { parent: "Pens & Writing", child: "Ballpoint Pens" },
});
const products = [
  {
    sku: "3176377", name: "MODERN - Ballpoint pen", short_description: "Ballpoint pen",
    description: "<b>Ballpoint pen MODERN</b> with a clip", materials: ["Plastic", "Metal"], brand: null,
    branding_methods: [
      { position_title: "opposite the clip", print_technique_title: "Digital print", print_technique_key: "digital_direct_print", size: "50x6mm", print_codes: "DP6", max_number_of_colors: "1", default: false },
      { position_title: "clip", print_technique_title: "Tampon print", print_technique_key: "pad_print", max_number_of_colors: "2", default: true },
    ],
    origin_country: "CN", keywords: ["pens"], categories: { parent: "Pens & Writing", child: "Ballpoint Pens" },
    details_images: [{ image_url: "https://media.inspirion.eu/72/3176377_detail.jpg" }], details_images_300: [],
    variants: [
      variant("56-1101117", "dark magenta, white", { length: "14.30", length_unit: "cm", diameter: "1.10", diameter_unit: "cm" }),
      variant("56-1101115", "purple, white", {}),
    ],
  },
  { sku: "3176378", name: "EMPTY", variants: [variant("56-1101115", "repeated", {})] },
];
const stock = [
  {
    article_id: "56-1101117", stock_dach: 5468, stock_czechia: 6735, stock_in_production: 108,
    inventory_arrival: [{ arrival_date: "2026-11-09 00:00:00", arrival_quantity: 144 }, { arrival_date: "2026-11-18 00:00:00", arrival_quantity: 36 }],
  },
  { article_id: "56-9999999", stock_dach: 1 },
];
const pricelist = [
  {
    article_id: "56-1101117",
    pricelist: [
      { price: "1.20", catalog_price: "2.40", currency: "EUR", bulk_volume: 50 },
      { price: "1.30", catalog_price: "2.60", currency: "EUR", bulk_volume: 1 },
    ],
  },
];

describe("inspirionPrices", () => {
  it("gives a net and a catalogue price per step, the net price of the smallest step primary", () => {
    const checks = new Checks();
    expect(inspirionPrices(pricelist[0], checks)).toEqual([
      { kind: "net", currency: "EUR", minQuantity: 1, amount: "1.30", isPrimary: true, validUntil: null },
      { kind: "catalog", currency: "EUR", minQuantity: 1, amount: "2.60", isPrimary: false, validUntil: null },
      { kind: "net", currency: "EUR", minQuantity: 50, amount: "1.20", isPrimary: false, validUntil: null },
      { kind: "catalog", currency: "EUR", minQuantity: 50, amount: "2.40", isPrimary: false, validUntil: null },
    ]);
    expect(checks.counts).toEqual({});
  });

  it("counts a step without an ISO currency and leaves it out", () => {
    const checks = new Checks();
    const prices = inspirionPrices({ article_id: "x", pricelist: [{ price: "1", currency: "euro", bulk_volume: 1 }] }, checks);
    expect(prices).toEqual([]);
    expect(checks.counts).toEqual({ "price steps without an ISO currency": 1 });
  });
});

describe("inspirionStock", () => {
  it("takes the German warehouse, production and arrivals by their date", () => {
    expect(inspirionStock(stock[0], new Checks())).toEqual({
      inStock: 5468, reserved: null, onOrder: 108, nextArrivalQuantity: 144, nextArrivalDate: "2026-11-09", leadTime: null,
      arrivals: [{ date: "2026-11-09", quantity: 144 }, { date: "2026-11-18", quantity: 36 }], sourceUpdatedAt: null,
    });
  });
});

describe("inspirionPrintTechniques", () => {
  it("reads the ten keys of the catalogue, a transfer before digital, and leaves an unknown one unconfirmed", () => {
    const keys = ["digital_direct_print_360", "digital_transfer", "silkscreen_360", "engraving_co2", "engraving_metal", "doming"];
    expect(inspirionPrintTechniques(keys.map((key) => ({ print_technique_key: key }))))
      .toEqual(["digital", "doming", "laser", "screen", "transfer", "wrap"]);
    expect(inspirionPrintTechniques([{ print_technique_key: "embroidery_3d" }, {}])).toEqual(["unconfirmed"]);
  });
});

describe("normalizeInspirion", () => {
  it("builds models with variants, photos linked to colours, sizes and print techniques", () => {
    const catalog = normalizeInspirion({ products, stock, pricelist });
    const [model] = catalog.models;
    expect(model).toMatchObject({
      code: "3176377", name: { en: "MODERN - Ballpoint pen" }, description: { en: "Ballpoint pen MODERN with a clip" },
      category: { en: ["Pens & Writing", "Ballpoint Pens"] }, material: { en: "Plastic, Metal" }, dimensions: "ø1.1 x 14.3 cm",
      weightGrams: "10.000", countryOfOrigin: "CN", printTechniques: ["digital", "pad"],
      specFields: { volume: null, texts: ["Ballpoint pen"] }, attributes: { keywords: ["pens"] },
    });
    expect(model?.variants.map((item) => [item.sku, item.color.en, item.prices.length, item.stock?.inStock ?? null]))
      .toEqual([["56-1101117", "dark magenta, white", 4, 5468], ["56-1101115", "purple, white", 0, null]]);
    expect(model?.photos[0]).toEqual({
      url: "https://media.inspirion.eu/72/56-1101117_MODERN_01.jpg", urlLarge: "https://media.inspirion.eu/300/56-1101117_MODERN_01.jpg",
      kind: null, position: 0, variantLinks: [{ sku: "56-1101117", position: 0 }],
    });
    expect(model?.photos.at(-1)).toMatchObject({ url: "https://media.inspirion.eu/72/3176377_detail.jpg", urlLarge: null, variantLinks: [] });
    expect(catalog.checks).toMatchObject({
      "variants with a repeated article_id": 1, "models without variants": 1, "variants without a price": 1,
      "variants without stock": 1, "stock records without a variant": 1,
    });
    expect(catalog.fetched).toEqual({ products: 2, "products variants": 2, stock: 2, pricelist: 1 });
  });

  it("stops on an empty or missing feed instead of marking everything inactive", () => {
    expect(() => normalizeInspirion({ products, stock: [], pricelist })).toThrow(FeedError);
    expect(() => normalizeInspirion({ products: { data: products }, stock, pricelist })).toThrow("products: no array of records");
  });
});
