import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { readPrintAreas } from "./print-config.js";

// The shapes of the files of 2026-11-04
const priceList = {
  generatedAt: "2026-07-22T06:58:47Z",
  printPriceList: [
    { id: "100123", code: "K", category: "PAD PRINTING K" },
    { id: "100400", code: "L1", category: "LASER ENGRAVING 1" },
    { id: "100114", code: "D", category: "PAD PRINTING D" },
    { id: "103001", code: "W1", category: "DIGITAL W1 (-5  cm2) (FULLCOLOR)" },
    { id: "100991", code: "", category: "" },
  ],
};
const config = {
  generatedAt: "2026-11-04T09:53:53Z", lang: "en",
  products: [
    { id: "15246", areas: [{ id: "A1", techniques: "100123(4)" }] },
    { id: "14964", areas: [{ id: "A1", techniques: "103001(1),100400" }, { id: "A2", techniques: "100114(1)100400(1)" }] },
    { id: "11111", areas: [{ id: "A1", techniques: "999999(1),100991" }, { id: "A2", techniques: "x" }] },
    { id: "22222", areas: [] },
  ],
};

describe("readPrintAreas", () => {
  it("names the techniques of a model's areas once, with or without colours, after commas or stuck together", () => {
    const checks = new Checks();
    const { areas, warnings } = readPrintAreas(config, priceList, checks);
    expect(warnings).toEqual([]);
    expect(areas?.namesByRef.get("15246")).toEqual(["PAD PRINTING K"]);
    // The name's spaces are cleaned like any other text of a feed
    expect(areas?.namesByRef.get("14964")).toEqual(["DIGITAL W1 (-5 cm2) (FULLCOLOR)", "LASER ENGRAVING 1", "PAD PRINTING D"]);
    expect(areas?.raw.size).toBe(4);
    expect(areas?.priceListNames).toBe(5);
  });

  it("counts an id the price list lacks, a text it cannot read and a model without areas", () => {
    const checks = new Checks();
    const { areas } = readPrintAreas(config, priceList, checks);
    expect(areas?.namesByRef.get("11111")).toEqual([""]);
    expect(areas?.namesByRef.get("22222")).toEqual([]);
    expect(checks.counts).toEqual({
      "print technique ids not in the print price list": 1, "print area techniques that are not read": 1,
      "print areas without readable techniques": 1, "models in print-config without areas": 1,
    });
    expect(checks.examples["print technique ids not in the print price list"]).toEqual(["999999"]);
  });

  it("counts an area whose techniques are not a text, so a renamed field does not pass as an empty feed", () => {
    const checks = new Checks();
    const { areas } = readPrintAreas({ products: [
      { id: "1", areas: [{ id: "A1", technique: "100123(4)" }, { id: "A2", techniques: ["100123(4)"] }, { id: "A3", techniques: null }] },
    ] }, priceList, checks);
    expect(areas?.namesByRef.get("1")).toEqual([]);
    expect(checks.counts).toEqual({ "print areas without readable techniques": 3 });
  });

  it("keeps the first row of a repeated price list id and counts the repeat", () => {
    const checks = new Checks();
    const { areas } = readPrintAreas({ products: [{ id: "1", areas: [{ id: "A1", techniques: "100123" }] }] }, {
      printPriceList: [{ id: "100123", category: "PAD PRINTING K" }, { id: "100123", category: "LASER ENGRAVING 1" }],
    }, checks);
    expect(areas?.namesByRef.get("1")).toEqual(["PAD PRINTING K"]);
    expect(checks.counts).toEqual({ "print-price-list records with a repeated id": 1 });
  });

  it("reads nothing, without a word, when the adapter read nothing", () => {
    expect(readPrintAreas(undefined, undefined, new Checks())).toEqual({ areas: null, warnings: [] });
  });

  it("warns instead of stopping on a file that is not the one it should be", () => {
    for (const [file, names] of [[{ products: [] }, priceList], [config, { printPriceList: "none" }], [[], priceList]] as const) {
      const { areas, warnings } = readPrintAreas(file, names, new Checks());
      expect(areas).toBeNull();
      expect(warnings).toHaveLength(1);
    }
  });
});
