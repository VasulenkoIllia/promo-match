import { describe, expect, it } from "vitest";
import { outputSchema, readParsedQuery, systemPrompt } from "./query-parse-contract.js";

const codes = new Set(["drinkware.mugs"]);
const read = (answer: Record<string, unknown>) => readParsedQuery(JSON.stringify({
  products: [], printTechniques: [], sharedCategories: [], colors: [], price: null, ...answer,
}), codes);
const product = (fields: Record<string, unknown>) => ({
  phrase: "cap", volumeMl: null, materials: [], sizeCm: null, printTechniques: [], sheets: null, gsm: null,
  excludedMaterials: [], excludedColors: [], ...fields,
});

describe("the reading of print, sheets and weight", () => {
  it("keeps them on the product they are asked of", () => {
    const { conditions, dropped } = read({ products: [
      product({ printTechniques: ["embroidery"] }),
      product({ phrase: "notebook", sheets: { min: 80, max: 80 }, gsm: { min: 70, max: null } }),
    ] });
    expect(dropped).toEqual([]);
    expect(conditions[0]).toMatchObject({ printTechniques: ["embroidery"], sheets: null, gsm: null });
    expect(conditions[1]).toMatchObject({ printTechniques: [], sheets: { min: 80, max: 80 }, gsm: { min: 70, max: null } });
  });

  it("holds a query that names a technique and no product to it, with no product in the text to embed", () => {
    const parsed = read({ printTechniques: ["sublimation"] });
    expect(parsed.products).toEqual([]);
    expect(parsed.englishText).toBeNull();
    expect(parsed.conditions).toEqual([{ volumeMl: null, materials: [], sizeCm: null, printTechniques: ["sublimation"] }]);
  });

  it("leaves a product's query to the product, and an empty one with no conditions", () => {
    expect(read({ products: [product({})], printTechniques: ["laser"] }).conditions[0]?.printTechniques).toEqual([]);
    expect(read({}).conditions).toEqual([]);
  });

  it("drops a code out of the list and keeps the rest of the answer", () => {
    const { conditions, dropped } = read({ products: [product({ printTechniques: ["laser", "hologram"], sheets: { min: 90, max: 80 } })] });
    expect(conditions[0]).toMatchObject({ printTechniques: ["laser"], sheets: null });
    expect(dropped).toEqual(["sheets"]);
  });

  it("reads a kept answer of the prompt before these fields", () => {
    const old = readParsedQuery(JSON.stringify({
      products: [{ phrase: "mug", volumeMl: null, materials: [], sizeCm: null }], sharedCategories: [], colors: [], price: null,
    }), codes);
    expect(old.conditions).toEqual([{ volumeMl: null, materials: [], sizeCm: null }]);
  });

  it("asks the model for them, and keeps the technique out of the phrase", () => {
    const schema = JSON.stringify(outputSchema([...codes]));
    expect(schema).toContain('"printTechniques"');
    expect(schema).toContain('"gsm"');
    expect(systemPrompt([])).toContain("printTechniques alone stays out of it");
  });
});
