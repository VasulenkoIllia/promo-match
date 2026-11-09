import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { categoryOf, colorOf, materialOf, nameOf, normalizeAnda } from "./normalize.js";
import { FEED_SHAPES, labelingOf, priceOf, productOf, stockOf } from "./records.js";
import { parseRecords } from "./xml.js";

// Records shaped like the four feeds of 2026-11-09; codes, names and prices made up
const CDN = "https://data.cdn.example/web_product_images_low-res";

function product(itemNumber: string, root: string, extra = ""): string {
  return `<product><itemNumber>${itemNumber}</itemNumber><designName>Teston</designName><primaryColor>black</primaryColor>`
    + `<primaryColorCode>10</primaryColorCode><secondaryColor></secondaryColor><name>thermo cup</name>`
    + `<descriptions>Double-wall thermo cup &amp; lid.</descriptions><primaryImage>${CDN}/${root}/${itemNumber}.jpg</primaryImage>`
    + `<images><image>${CDN}/${root}/${itemNumber}.jpg</image><image>${CDN}/${root}/${root}__DG1.jpg</image></images>`
    + `<temporarilyUnavailable>0</temporarilyUnavailable><customProduction>0</customProduction>`
    + `<minimumOrderQuantity>50</minimumOrderQuantity><individualProductWeightGram>29</individualProductWeightGram>`
    + `<countryOfOrigin>CN</countryOfOrigin><tariffNumber>3924100090</tariffNumber><brandName/><eanCode>5990000000001</eanCode>`
    + `<rootItemNumber>${root}</rootItemNumber><multiple>0</multiple><assemblyProduct>0</assemblyProduct>`
    + `<productTheme><flags><flag><name>Outlet</name></flag></flags><topics/></productTheme>`
    + `<collections><collections><collection><name>OUTLET</name></collection></collections></collections>`
    + `<packageDatas><packageData><code>master carton</code><quantity>200</quantity></packageData></packageDatas>`
    + `<specification><property><name>Material 2</name><values><value>Plastic</value></values></property>`
    + `<property><name>Material 1</name><values><value>Stainless steel</value></values></property>`
    + `<property><name>Size</name><values><value>ø85×155 mm</value></values></property>`
    + `<property><name>Capacity</name><values><value>400 ml</value></values></property>`
    + `<property><name>Dishwasher safe</name><values><value>Yes</value></values></property></specification>`
    + `<categories><category><name>Thermo mugs &amp; cups</name><level>3</level><externalId>14063</externalId></category>`
    + `<category><name>Food &amp; Drinkware</name><level>1</level><externalId>14000</externalId></category>`
    + `<category><name>Mugs, Cups &amp; Glasses</name><level>2</level><externalId>14010</externalId></category></categories>`
    + `<relatedProducts/><productCertificate><conformity><![CDATA[https://data.cdn.example/certificate/${root}.pdf]]></conformity>`
    + `</productCertificate>${extra}</product>`;
}

const PRODUCTS = `<?xml version="1.0" encoding="UTF-8"?><products>`
  + product("AP100001-10", "AP100001")
  + product("AP100001-06A", "AP100001").replace("<primaryColor>black", "<primaryColor>dark blue")
  + product("AP4001-03_XL", "AP4001").replace("<customProduction>0", "<customProduction>1")
  + product("AP100001-10", "AP100001")
  + `</products>`;
const PRICES = `<prices><price><itemNumber>AP100001-10</itemNumber><currency>EUR</currency><amount>2.4</amount>`
  + `<type>listPrice</type></price><price><itemNumber>AP100001-10</itemNumber><currency>EUR</currency><amount>1.2</amount>`
  + `<type>discountPrice</type></price><price><itemNumber>AP999999</itemNumber><currency>EUR</currency><amount>1</amount>`
  + `<type>listPrice</type></price></prices>`;
const INVENTORIES = `<inventories><record><itemNumber>AP100001-10</itemNumber><type>central_stock</type><amount>25</amount>`
  + `<moreThanAmount>0</moreThanAmount><arrivalDate></arrivalDate></record><record><itemNumber>AP100001-06A</itemNumber>`
  + `<type>central_stock</type><amount>0</amount><moreThanAmount>0</moreThanAmount><arrivalDate></arrivalDate></record>`
  + `<record><itemNumber>AP100001-06A</itemNumber><type>external_1_2_days</type><amount>300</amount>`
  + `<moreThanAmount>0</moreThanAmount><arrivalDate></arrivalDate></record></inventories>`;
const LABELING = `<labelings><labeling><itemNumber>AP100001-10</itemNumber><lastModifiedDate>2026-11-01</lastModifiedDate>`
  + `<positions><position><serial>I</serial><posName>Body</posName><posImage>https://cdn.example/i.jpg</posImage><technologies>`
  + `<technology><Code>NE1</Code><Name>Engraving - Name printing</Name><maxColor>1</maxColor><maxWmm>60</maxWmm>`
  + `<maxHmm>25</maxHmm><maxDmm>0</maxDmm><fixedSize>0</fixedSize><printTemplate/></technology>`
  + `<technology><Code>CB3</Code><Name>Corrugated cardboard box</Name><maxColor>1</maxColor><maxWmm>0</maxWmm>`
  + `<maxHmm>0</maxHmm><maxDmm>0</maxDmm><fixedSize>1</fixedSize><printTemplate/></technology>`
  + `</technologies></position></positions><printTemplate>https://cdn.example/t.pdf</printTemplate></labeling></labelings>`;

function catalog() {
  return normalizeAnda({
    products: parseRecords(PRODUCTS, "products", FEED_SHAPES.products, productOf),
    prices: parseRecords(PRICES, "prices", FEED_SHAPES.prices, priceOf),
    inventories: parseRecords(INVENTORIES, "inventories", FEED_SHAPES.inventories, stockOf),
    labeling: parseRecords(LABELING, "labeling", FEED_SHAPES.labeling, labelingOf),
    stockUpdatedAt: null,
  });
}

describe("normalizeAnda", () => {
  it("groups the variants under rootItemNumber with the model's texts, category, materials and sizes", () => {
    const { models } = catalog();
    expect(models.map((model) => [model.code, model.variants.map((variant) => variant.sku)])).toEqual([
      ["AP100001", ["AP100001-06A", "AP100001-10"]], ["AP4001", ["AP4001-03_XL"]],
    ]);
    const [cup] = models;
    expect(cup).toMatchObject({
      name: { en: "Teston thermo cup" }, description: { en: "Double-wall thermo cup & lid." },
      category: { en: ["Food & Drinkware", "Mugs, Cups & Glasses", "Thermo mugs & cups"] }, categoryCode: "14063",
      material: { en: "Stainless steel, Plastic" }, dimensions: "ø85×155 mm", specFields: { volume: "400 ml", texts: [] },
      weightGrams: "29", countryOfOrigin: "CN", brand: null, printTechniques: ["laser"],
    });
    expect(cup?.attributes).toEqual({
      flags: ["Outlet"], collections: ["OUTLET"], packaging: [{ code: "master carton", quantity: "200" }],
      specification: { "Dishwasher safe": "Yes" }, certificate: "https://data.cdn.example/certificate/AP100001.pdf",
      tariffNumber: "3924100090",
    });
  });

  it("joins prices, stock and print positions by item number", () => {
    const [cup] = catalog().models;
    const [blue, black] = cup?.variants ?? [];
    expect(black).toMatchObject({ colorCode: "10", color: { en: "black" }, size: null, ean: "5990000000001" });
    expect(black?.prices.map((price) => [price.kind, price.amount, price.isPrimary])).toEqual([["catalog", "2.4", false], ["net", "1.2", true]]);
    expect(black?.stock?.inStock).toBe(25);
    expect(black?.printing).toEqual({
      template: "https://cdn.example/t.pdf",
      positions: [{
        serial: "I", name: "Body", image: "https://cdn.example/i.jpg",
        techniques: [
          { code: "NE1", maxColors: "1", maxWidthMm: "60", maxHeightMm: "25", maxDepthMm: "0", isFixedSize: false },
          { code: "CB3", maxColors: "1", maxWidthMm: "0", maxHeightMm: "0", maxDepthMm: "0", isFixedSize: true },
        ],
      }],
    });
    expect(blue).toMatchObject({ colorCode: "06A", color: { en: "dark blue" }, prices: [], printing: null });
    expect(blue?.stock?.inStock).toBe(0);
    expect(blue?.attributes).toMatchObject({ externalStock: { external_1_2_days: 300 }, primaryColorCode: "10" });
  });

  it("shares a photo between the variants that list it", () => {
    const [cup] = catalog().models;
    expect(cup?.photos.map((photo) => [photo.url.replace(CDN, ""), photo.variantLinks])).toEqual([
      ["/AP100001/AP100001-06A.jpg", [{ sku: "AP100001-06A", position: 0 }]],
      ["/AP100001/AP100001__DG1.jpg", [{ sku: "AP100001-06A", position: 1 }, { sku: "AP100001-10", position: 1 }]],
      ["/AP100001/AP100001-10.jpg", [{ sku: "AP100001-10", position: 0 }]],
    ]);
  });

  it("keeps a textile size without a price and a made-to-order variant without stock, and counts both", () => {
    const result = catalog();
    const [shirt] = result.models[1]?.variants ?? [];
    expect(shirt).toMatchObject({ size: "XL", colorCode: "03", prices: [], stock: null, attributes: { customProduction: "1" } });
    expect(result.checks).toEqual({
      "products with a repeated itemNumber": 1, "variants without a price": 2, "variants without print positions": 2,
      "made-to-order variants without stock": 1, "price codes without a product": 1,
    });
    expect(result.examples["price codes without a product"]).toEqual(["AP999999"]);
  });

  it("lists every technique code with its name and keeps one raw record per item number and feed", () => {
    const result = catalog();
    expect(result.techniques).toEqual([
      { code: "CB3", name: { en: "Corrugated cardboard box" } }, { code: "NE1", name: { en: "Engraving - Name printing" } },
    ]);
    expect(result.raw.map((raw) => `${raw.feed} ${raw.externalId}`)).toEqual([
      "products AP100001-10", "products AP100001-06A", "products AP4001-03_XL", "prices AP100001-10", "prices AP999999",
      "inventories AP100001-10", "inventories AP100001-06A", "labeling AP100001-10",
    ]);
    expect(result.fetched).toEqual({ products: 4, prices: 3, inventories: 3, labeling: 1, models: 2 });
  });
});

describe("model fields", () => {
  it("joins two colours, the line's name with the kind, materials in their order", () => {
    expect(colorOf({ primaryColor: "green", secondaryColor: "white" })).toEqual({ en: "green/white" });
    expect(colorOf({ primaryColor: "", secondaryColor: "" })).toEqual({});
    expect(nameOf({ designName: "", name: "ballpoint pen" })).toBe("ballpoint pen");
    expect(nameOf({})).toBeNull();
    expect(materialOf([{ name: "Material 1 weight", values: ["10 g"] }, { name: "Material 1", values: ["Bamboo", "ABS"] }]))
      .toBe("Bamboo, ABS");
  });

  it("orders the category levels by their number, as the feed does not, and counts a level it cannot place", () => {
    const checks = new Checks();
    const categories = [
      { level: "2", name: "Pens", externalId: "2" }, { level: "1", name: "Writing", externalId: "1" },
      { level: "x", name: "Gifts", externalId: "9" }, { level: "3", name: " ", externalId: "3" },
    ];
    const product = { fields: { itemNumber: "AP100001" }, categories } as unknown as Parameters<typeof categoryOf>[0];
    expect(categoryOf(product, checks)).toEqual({ path: ["Writing", "Pens"], code: "2" });
    expect(checks.counts).toEqual({ "category levels without a level number or a name": 2 });
  });
});
