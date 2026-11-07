import { describe, expect, it } from "vitest";
import { areRelated, isKindOf, readMaterials } from "./materials.js";
import { readGsm, readSheets, readSizesCm, readVolumeMl, specsOf } from "./specs.js";
import type { ModelInput } from "./types.js";

describe("readVolumeMl", () => {
  it("reads every unit, a decimal comma and capitals", () => {
    expect(readVolumeMl(null, ["Thermo mug 350 ML"])).toBe(350);
    expect(readVolumeMl(null, ["Bottle 0,75 l"])).toBe(750);
    expect(readVolumeMl(null, ["Backpack 18L"])).toBe(18_000);
    expect(readVolumeMl(null, ["Flask 33cl"])).toBe(330);
    expect(readVolumeMl(null, ["Jug 1 litre"])).toBe(1_000);
  });

  it("takes the supplier's own field first", () => {
    expect(readVolumeMl("500 ml", ["Bottle 420 ml"])).toBe(500);
  });

  it("takes the capacity named as such over the first number", () => {
    expect(readVolumeMl(null, ["Cooler bag for 6 1,5l bottles", "Capacity 12,5L."])).toBe(12_500);
    expect(readVolumeMl(null, ["Set of two 500ml containers, a total volume of 1 litre"])).toBe(1_000);
  });

  it("takes the main item of a set, said first", () => {
    expect(readVolumeMl(null, ["Thermos 500 ml with 2 mugs 260 ml"])).toBe(500);
  });

  it("leaves out what the product saved, in any text", () => {
    expect(readVolumeMl(null, ["This umbrella has saved 7 litres of water. Made of 11,8 PET bottles (500ml)."])).toBeNull();
    expect(readVolumeMl(null, ["Each bag saves 5.4 litres of water. Volume: 18 l"])).toBe(18_000);
  });

  it("does not take a fabric's weight, a charge or a size for a volume", () => {
    expect(readVolumeMl(null, ["16 oz. recycled canvas", "Power bank 5000 mAh", "Size XL", "Pen with 1.0 mm tip"])).toBeNull();
  });
});

describe("readSizesCm", () => {
  it("reads the formats of every source, longest side first", () => {
    expect(readSizesCm("13 x 2 x 17 cm")).toEqual([17, 13, 2]);
    expect(readSizesCm("28X35X32CM")).toEqual([35, 32, 28]);
    expect(readSizesCm("7,5 x 9,2 x 12,3 cm.")).toEqual([12.3, 9.2, 7.5]);
    expect(readSizesCm("10.5X2.5CM")).toEqual([10.5, 2.5]);
  });

  it("counts a diameter as a side", () => {
    expect(readSizesCm("Ø9X8,6 CM")).toEqual([9, 8.6]);
    expect(readSizesCm("20 x Ø7,5 cm")).toEqual([20, 7.5]);
    expect(readSizesCm("dia 9 x 12 cm")).toEqual([12, 9]);
    expect(readSizesCm("⌀ 30 cm")).toEqual([30]);
  });

  it("keeps the product's own size, not its parts", () => {
    expect(readSizesCm("38 x 42 cm (handles 60 x 2 cm)")).toEqual([42, 38]);
    expect(readSizesCm("One size: 3 (10 x 20 cm)")).toEqual([20, 10]);
  });

  it("converts millimetres and takes sides without a unit for centimetres", () => {
    expect(readSizesCm("85 x 54 x 2 mm")).toEqual([8.5, 5.4, 0.2]);
    expect(readSizesCm("10 x 20")).toEqual([20, 10]);
  });

  it("gives nothing when no size is said", () => {
    expect(readSizesCm(null)).toEqual([]);
    expect(readSizesCm("sizes: S, M, L, XL")).toEqual([]);
    expect(readSizesCm("0 x 0 x 0 cm")).toEqual([]);
    expect(readSizesCm("105")).toEqual([]);
  });
});

describe("readMaterials", () => {
  it("reads a list in its order, each once", () => {
    expect(readMaterials("recycled stainless steel, PP")).toEqual(["stainless-steel", "plastic"]);
    expect(readMaterials("ABS, PP, stainless steel")).toEqual(["plastic", "stainless-steel"]);
    expect(readMaterials("PET-PU")).toEqual(["pet", "pu-leather"]);
  });

  it("reads what suppliers add around a name", () => {
    expect(readMaterials("polyester (600D)")).toEqual(["polyester"]);
    expect(readMaterials("organic cotton (70%), recycled cotton (30%)")).toEqual(["cotton"]);
    expect(readMaterials("Glass high borosilicate")).toEqual(["glass"]);
    expect(readMaterials("non-woven")).toEqual(["nonwoven"]);
    expect(readMaterials("beechwood")).toEqual(["wood"]);
  });

  it("takes the most specific name of a part", () => {
    expect(readMaterials("PU foam")).toEqual(["plastic"]);
    expect(readMaterials("stone paper")).toEqual(["paper"]);
  });

  it("leaves out what is no material", () => {
    expect(readMaterials("battery")).toEqual([]);
    expect(readMaterials("")).toEqual([]);
  });
});

describe("isKindOf", () => {
  it("takes a material as itself and as a kind of its parents, never the other way", () => {
    expect(isKindOf("stainless-steel", "stainless-steel")).toBe(true);
    expect(isKindOf("stainless-steel", "metal")).toBe(true);
    expect(isKindOf("metal", "stainless-steel")).toBe(false);
    expect(isKindOf("textile", "cotton")).toBe(false);
  });

  it("does not take an imitation for the real material", () => {
    expect(isKindOf("pu-leather", "leather")).toBe(false);
  });
});

describe("areRelated", () => {
  it("relates a material to its kinds, both ways", () => {
    expect(areRelated("plastic", "tritan")).toBe(true);
    expect(areRelated("stainless-steel", "metal")).toBe(true);
    expect(areRelated("wood", "bamboo")).toBe(true);
    expect(areRelated("polyester", "pet")).toBe(true);
    expect(areRelated("plastic", "pet")).toBe(true);
  });

  it("takes polypropylene for non-woven, as suppliers write either for the same fabric", () => {
    expect(areRelated("nonwoven", readMaterials("PP")[0] ?? "cork")).toBe(true);
    expect(areRelated("nonwoven", readMaterials("non-woven")[0] ?? "cork")).toBe(true);
  });

  it("keeps different materials apart", () => {
    expect(areRelated("plastic", "stainless-steel")).toBe(false);
    expect(areRelated("cotton", "polyester")).toBe(false);
    expect(areRelated("tritan", "acrylic")).toBe(false);
  });
});

describe("readSheets", () => {
  it("reads sheets, with words between the number and the word", () => {
    expect(readSheets(["Notebook A5 (80 lined sheets), hard cover"])).toBe(80);
    expect(readSheets(["192 lined recycled paper (96 sheets). Elastic closure"])).toBe(96);
    expect(readSheets(["300 recycled sheets memo pad"])).toBe(300);
  });

  it("takes sheets over pages, and halves pages when they stand alone", () => {
    expect(readSheets(["96 sheets / 192 pages"])).toBe(96);
    expect(readSheets(["160 pages of 80g/m2 paper"])).toBe(80);
    expect(readSheets(["weekly, vertical (144 pg.), ribbon"])).toBe(72);
  });

  it("looks at the texts in order, and takes no other number for sheets", () => {
    expect(readSheets(["A5 notebook", "Notebook with 70 sheets"])).toBe(70);
    expect(readSheets(["size A5, 12 colours page markers, 5 sheets"])).toBeNull();
    expect(readSheets(["Carton of 400 ml"])).toBeNull();
    expect(readSheets(["ISLAND 100 BATH SHEET"])).toBeNull();
    expect(readSheets(["80 grams sheets of cream paper"])).toBeNull();
  });
});

describe("readGsm", () => {
  it("reads the ways the two catalogues write it", () => {
    expect(readGsm(["cotton 180 gr/m². Made in EU"])).toBe(180);
    expect(readGsm(["recycled polyester in 150 G/M²."])).toBe(150);
    expect(readGsm(["80 sheets 70g/m2 in line"])).toBe(70);
    expect(readGsm(["pages of 58 gm/m2 white paper"])).toBe(58);
    expect(readGsm(["Impact AWARE 285gsm rcanvas tote bag"])).toBe(285);
    expect(readGsm(["made of 320 g/sqm polyester"])).toBe(320);
  });

  it("takes no weight of the product for it", () => {
    expect(readGsm(["6 panel 190gr recycled cotton cap", "weight 145g"])).toBeNull();
  });

  it("says nothing when the texts give two values, and takes the same value twice for one", () => {
    expect(readGsm(["500 gsm hard cover, 70 blank 70 gsm pages"])).toBeNull();
    expect(readGsm(["Bag 180 gsm", "Bag in cotton 180 g/m²"])).toBe(180);
  });
});

describe("specsOf", () => {
  const model = {
    name: { en: "Travel mug" }, description: { en: "With lid, 400 ml" }, material: { en: "Stainless steel" },
    dimensions: "Ø8X17 CM", specFields: { volume: null, texts: ["Double wall mug 350 ml"] },
  } as unknown as ModelInput;

  it("reads the name, the texts an adapter gives and the description, in that order", () => {
    expect(specsOf(model)).toEqual({ volumeMl: 350, materials: ["stainless-steel"], sizesCm: [17, 8], sheets: null, gsm: null });
  });

  it("gets the same from the same facts, whichever fields carry them", () => {
    const other = {
      ...model, name: { en: "CUP" }, description: { en: "Double wall mug 350 ml" }, dimensions: "17 x Ø8 cm",
      specFields: { volume: null, texts: [] },
    };
    expect(specsOf(other)).toEqual(specsOf(model));
  });
});
