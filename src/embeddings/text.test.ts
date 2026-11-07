import { describe, expect, it } from "vitest";
import type { ModelTextRow } from "./store.js";
import { modelText, textHash } from "./text.js";
import { planTexts } from "./texts.js";

function row(overrides: Partial<ModelTextRow> = {}): ModelTextRow {
  return {
    id: 1, code: "T9800", name: "Iqoniq Diran  fleece jacket ", description: "Unisex pile fleece\tjacket.",
    material: "Recycled Polyester", sharedCategory: "Clothing > Jackets", colors: ["neutral", "Black", "black"], textHash: null,
    ...overrides,
  };
}

describe("modelText", () => {
  it("takes the shared category as the title, then name, description, material and colours", () => {
    expect(modelText(row())).toEqual({
      title: "Clothing > Jackets",
      text: "Iqoniq Diran fleece jacket\nUnisex pile fleece jacket.\nMaterial: recycled polyester\nColours: black, neutral",
    });
  });

  it("gives every source the same shape, whatever its name says", () => {
    const brandWord = modelText(row({ name: "CUPAGE", description: "Ceramic mug in matte colour." }));
    const described = modelText(row({ name: "Ceramic mug 300 ml", description: "Ceramic mug." }));
    expect(brandWord?.title).toBe(described?.title);
    expect(brandWord?.text.split("\n")).toHaveLength(described?.text.split("\n").length ?? 0);
  });

  it("does not say the name twice when the description opens with it", () => {
    const text = modelText(row({ name: "Cosmetic bag", description: "Cosmetic bag with zipped compartment", material: "", colors: [] }));
    expect(text?.text).toBe("Cosmetic bag with zipped compartment");
  });

  it("leaves out empty fields and has nothing for a model without an English name", () => {
    expect(modelText(row({ description: null, material: "", sharedCategory: null, colors: [] })))
      .toEqual({ title: null, text: "Iqoniq Diran fleece jacket" });
    expect(modelText(row({ name: "  " }))).toBeUndefined();
  });

  it("hashes the same text the same way whatever the order of colours", () => {
    const first = modelText(row());
    const second = modelText(row({ colors: ["black", "neutral"] }));
    expect(first && textHash(first)).toBe(second && textHash(second));
    expect(first && textHash(first)).not.toBe(textHash({ title: "Other", text: first?.text ?? "" }));
  });
});

describe("planTexts", () => {
  it("embeds new and changed texts, skips unchanged ones and models without a name", () => {
    const text = modelText(row());
    const unchanged = row({ id: 2, code: "SAME", textHash: text && textHash(text) });
    const plan = planTexts([row(), row({ id: 3, code: "CHANGED", textHash: "old" }), unchanged, row({ id: 4, code: "NONAME", name: null })]);
    expect(plan.created.map((item) => item.code)).toEqual(["T9800"]);
    expect(plan.changed.map((item) => item.code)).toEqual(["CHANGED"]);
    expect(plan.unchanged).toBe(1);
    expect(plan.withoutText).toEqual(["NONAME"]);
    expect(plan.total).toBe(4);
  });
});
