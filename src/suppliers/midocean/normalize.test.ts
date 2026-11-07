import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { midoceanPrices, midoceanStock, midoceanTechniques, normalizeMidocean } from "./normalize.js";

// Feeds shaped like the smoke test's samples; prices made up
const image = (name: string, subtype: string) => ({
  url: `https://cdn1.midocean.com/image/700X700/${name}.jpg`,
  url_highress: `https://cdn1.midocean.com/image/original/${name}.jpg`, type: "image", subtype,
});
const variant = (sku: string, color: string, assets: unknown[]) => ({
  variant_id: `v-${sku}`, sku, gtin: "3609371029046", color_description: color, color_code: sku.split("-")[1],
  color_group: color, size_textile: sku.split("-")[2] ?? "", plc_status_description: "COLLECTION",
  category_level1: "Clothing & wearables", category_level2: "T-shirts", category_level3: "",
  pms_color: "WHITE", release_date: "2023-07-20", digital_assets: assets,
});
const products = [
  {
    master_code: "MO9999", master_id: "2", product_name: "MUG", long_description: "Ceramic mug &amp; box",
    material: "Ceramic", brand: "midocean", country_of_origin: "CN", dimensions: "8X8X10CM",
    net_weight: "0.35", net_weight_unit: "kg", category_code: "HOME", product_class: "Mug",
    digital_assets: [{ url: "https://cdn1.midocean.com/document/x.pdf", type: "document", subtype: "declaration" }],
    variants: [variant("MO9999-03", "Black", [])],
  },
  {
    master_code: "A03272", master_id: "1", product_name: "LEON", short_description: "LEON T-SHIRT 150",
    long_description: "T-shirt", material: "Cotton", brand: "ATF", country_of_origin: "FR", net_weight: "0.138",
    net_weight_unit: "kg", category_code: "MOBTEX_TSHMEN", printable: "yes",
    variants: [
      variant("A03272-WH-L", "White", [image("a03272-wh", "item_picture_front"), image("a03272-wh-back", "item_picture_back")]),
      variant("A03272-WH-XL", "White", [image("a03272-wh", "item_picture_front")]),
      variant("A03272-WH-L", "White", []),
    ],
  },
];
const stock = {
  modified_at: "2026-10-28T18:45:09+01:00",
  stock: [
    { sku: "A03272-WH-L", qty: 9, first_arrival_date: "2026-11-10", first_arrival_qty: 10_000, next_arrival_date: "2026-11-12", next_arrival_qty: 17_000 },
    { sku: "A03272-WH-XL", qty: 0 },
    { sku: "KC2694-03", qty: 4 },
  ],
};
const pricelist = {
  currency: "EUR", date: "2026-10-28",
  price: [
    { sku: "A03272-WH-L", variant_id: "1", price: "1,23", valid_until: "2027-01-31", scale: [{ minimum_quantity: "5000", price: "0,45" }, { minimum_quantity: "1", price: "1,20" }] },
    { sku: "A03272-WH-XL", variant_id: "2", price: "0", valid_until: "2027-01-31" },
  ],
};
const printdata = {
  printing_technique_descriptions: [
    { id: "B", name: [{ en: "Debossing" }, { de: "Prägung" }, { fi: null }] },
    { id: "B", name: [{ en: "Repeated" }] },
  ],
  products: [
    {
      master_code: "A03272", item_color_numbers: ["WH", ""], print_manipulation: "B",
      print_template: "https://print-templates-v2.cdn.midocean.com/A03272-print-template.pdf",
      printing_positions: [{
        position_id: "FRONT", print_size_unit: "mm", max_print_size_height: 400, max_print_size_width: 280,
        print_position_type: "Rectangle", category: "Regular",
        printing_techniques: [{ id: "ST1", default: true, max_colours: "8" }],
      }],
    },
    { master_code: "GONE", printing_positions: [] },
  ],
};

describe("midoceanPrices", () => {
  it("makes the base price primary from 1 and adds the scale from larger quantities", () => {
    expect(midoceanPrices(pricelist.price[0], "EUR", new Checks())).toEqual([
      { kind: "net", currency: "EUR", minQuantity: 1, amount: "1.23", isPrimary: true, validUntil: "2027-01-31" },
      { kind: "net", currency: "EUR", minQuantity: 5000, amount: "0.45", isPrimary: false, validUntil: "2027-01-31" },
    ]);
    expect(midoceanPrices(pricelist.price[1], "EUR", new Checks())).toEqual([]);
    expect(midoceanPrices(undefined, "EUR", new Checks())).toEqual([]);
  });

  it("counts a price, a date or a step it cannot read", () => {
    const checks = new Checks();
    const row = { sku: "X-1", price: "abc", valid_until: "2027-02-30", scale: [{ minimum_quantity: "many", price: "1,00" }, "junk"] };
    expect(midoceanPrices(row, "EUR", checks)).toEqual([]);
    expect(checks.counts).toEqual({
      "unreadable prices": 1, "unreadable price dates": 1, "unreadable scale quantities": 1,
      "price scale steps that are not objects": 1,
    });
  });
});

describe("midoceanStock", () => {
  it("lists the announced arrivals and takes the first as the next one", () => {
    expect(midoceanStock(stock.stock[0], "2026-10-28T18:45:09+01:00", new Checks())).toEqual({
      inStock: 9, reserved: null, onOrder: null, nextArrivalQuantity: 10_000, nextArrivalDate: "2026-11-10", leadTime: null,
      arrivals: [{ date: "2026-11-10", quantity: 10_000 }, { date: "2026-11-12", quantity: 17_000 }],
      sourceUpdatedAt: "2026-10-28T18:45:09+01:00",
    });
    expect(midoceanStock({ sku: "X" }, null, new Checks())).toBeNull();
  });
});

describe("midoceanTechniques", () => {
  it("merges the names by language and keeps a repeated id once", () => {
    const checks = new Checks();
    expect(midoceanTechniques(printdata, checks)).toEqual([{ code: "B", name: { en: "Debossing", de: "Prägung" } }]);
    expect(checks.counts).toEqual({ "print techniques records with a repeated id": 1 });
  });
});

describe("normalizeMidocean", () => {
  const snapshot = normalizeMidocean({ products, stock, pricelist, printdata });
  const [tshirt, mug] = snapshot.models;

  it("sorts models by code and keeps each sku once", () => {
    expect(snapshot.models.map((model) => model.code)).toEqual(["A03272", "MO9999"]);
    expect(tshirt?.variants.map((item) => item.sku)).toEqual(["A03272-WH-L", "A03272-WH-XL"]);
    expect(snapshot.checks["variants with a repeated sku"]).toBe(1);
  });

  it("shares a picture between the sizes of a colour", () => {
    expect(tshirt?.photos).toEqual([
      {
        url: "https://cdn1.midocean.com/image/700X700/a03272-wh.jpg",
        urlLarge: "https://cdn1.midocean.com/image/original/a03272-wh.jpg", kind: "item_picture_front", position: 0,
        variantLinks: [{ sku: "A03272-WH-L", position: 0 }, { sku: "A03272-WH-XL", position: 0 }],
      },
      expect.objectContaining({ kind: "item_picture_back", position: 1, variantLinks: [{ sku: "A03272-WH-L", position: 1 }] }),
    ]);
  });

  it("maps the model, its weight in grams and printing", () => {
    expect(tshirt).toMatchObject({
      externalId: "1", name: { en: "LEON" }, category: { en: ["Clothing & wearables", "T-shirts"] },
      categoryCode: "MOBTEX_TSHMEN", weightGrams: "138", countryOfOrigin: "FR",
      printing: {
        manipulation: "B", colorCodes: ["WH"],
        positions: [{ id: "FRONT", unit: "mm", maxWidth: "280", maxHeight: "400", techniques: [{ code: "ST1", isDefault: true, maxColours: 8 }] }],
      },
    });
    expect(tshirt?.attributes).toMatchObject({ short_description: "LEON T-SHIRT 150", printable: "yes" });
    expect(mug).toMatchObject({ description: { en: "Ceramic mug & box" }, weightGrams: "350" });
    expect(mug?.attributes.documents).toEqual([{ subtype: "declaration", url: "https://cdn1.midocean.com/document/x.pdf" }]);
  });

  it("joins prices and stock by sku and counts what is missing", () => {
    expect(tshirt?.variants[0]?.prices).toHaveLength(2);
    expect(tshirt?.variants[1]?.stock?.inStock).toBe(0);
    expect(snapshot.checks).toMatchObject({
      "variants without a price": 2, "variants without stock": 1, "variants without photos": 1,
      "stock records without a variant": 1, "printdata records without a model": 1,
    });
  });

  it("reports the feeds it read and keeps their raw records", () => {
    expect(snapshot.fetched).toEqual({ products: 2, "products variants": 3, stock: 3, pricelist: 2, printdata: 2 });
    expect(snapshot.raw.filter((raw) => raw.feed === "stock").map((raw) => raw.externalId)).toContain("KC2694-03");
  });

  it("refuses feeds without their arrays or a currency", () => {
    expect(() => normalizeMidocean({ products: {}, stock, pricelist, printdata })).toThrow("products: no array of records");
    expect(() => normalizeMidocean({ products, stock, pricelist: { ...pricelist, currency: "euro" }, printdata }))
      .toThrow("pricelist: no ISO currency code");
    expect(() => normalizeMidocean({ products, stock: { stock: null }, pricelist, printdata })).toThrow("stock: no array of records in stock");
  });

  it("refuses an empty feed, which would mark everything in it inactive", () => {
    expect(() => normalizeMidocean({ products, stock, pricelist: { currency: "EUR", price: [] }, printdata }))
      .toThrow("pricelist: no records");
    expect(() => normalizeMidocean({ products: [], stock, pricelist, printdata })).toThrow("products: no records");
    expect(() => normalizeMidocean({ products, stock, pricelist, printdata: { ...printdata, printing_technique_descriptions: [] } }))
      .toThrow("printdata: no print techniques");
  });
});
