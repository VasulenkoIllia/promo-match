import { describe, expect, it } from "vitest";
import { brandFreeText, brandWords, BRAND_WORD_MIN_MODELS, descriptionWords, withoutWords } from "./brand-words.js";
import type { ModelTextFields } from "./text.js";

// Words the prose of many models uses, and one product line in two. One more description than the bound: the counts of
// a run hold the model's own description too, and it does not count for its name.
const common = Array.from({ length: BRAND_WORD_MIN_MODELS + 1 }, () => "Ball pen with a metal clip, USB backpack 600 ml A5");
const counts = descriptionWords([...common, "Backpack ABERDEEN : zipped", "Backpack ABERDEEN : padded", null]);

function fields(overrides: Partial<ModelTextFields> = {}): ModelTextFields {
  return { name: "Pen Blavix", description: "Ball pen with a metal clip.", material: null, sharedCategory: "Writing > Pens", colors: [], ...overrides };
}

describe("brandWords", () => {
  it("counts each description once, in lower case", () => {
    expect(descriptionWords(["Pen pen PEN", "pen"]).get("pen")).toBe(2);
  });

  it("takes the words of the name that too few other descriptions use, whatever their case", () => {
    expect(brandWords(fields({ name: "Ball pen BLAVIX Ontario" }), counts)).toEqual(new Set(["blavix", "ontario"]));
    expect(brandWords(fields({ name: "USB Backpack 600 ml" }), counts)).toEqual(new Set());
  });

  it("does not let the model's own description vouch for its name", () => {
    expect(brandWords(fields({ name: "ABERDEEN - Backpack", description: "Backpack ABERDEEN : zipped" }), counts))
      .toEqual(new Set(["aberdeen"]));
  });
});

describe("withoutWords", () => {
  it("drops the words and the marks they leave alone at either end or twice in a row", () => {
    expect(withoutWords("ABERDEEN - Backpack", new Set(["aberdeen"]))).toBe("Backpack");
    expect(withoutWords("Poncho in ball | Scarlett", new Set(["scarlett"]))).toBe("Poncho in ball");
    expect(withoutWords("Candle - Library - VERA", new Set(["library"]))).toBe("Candle - VERA");
  });

  it("keeps the marks between kept words and drops an empty pair", () => {
    expect(withoutWords("Steel Bidon PATRO 600 ml", new Set(["patro"]))).toBe("Steel Bidon 600 ml");
    expect(withoutWords("Wall charger (Hama) 30W", new Set(["hama"]))).toBe("Wall charger 30W");
    expect(withoutWords('Polo shirt "keya" for women', new Set(["keya"]))).toBe("Polo shirt for women");
    expect(withoutWords("Backpack KALI, black", new Set(["kali"]))).toBe("Backpack, black");
  });

  it("drops what joined a word to the one taken out, and keeps a joiner inside a kept word", () => {
    expect(withoutWords("Metal-Touchpen SEBASTIAN", new Set(["touchpen", "sebastian"]))).toBe("Metal");
    expect(withoutWords("Black+Blum lunch bag", new Set(["blum"]))).toBe("Black lunch bag");
    expect(withoutWords("USB-C cable Kiro", new Set(["kiro"]))).toBe("USB-C cable");
  });

  it("matches whole words only", () => {
    expect(withoutWords("Penever pen", new Set(["pen"]))).toBe("Penever");
  });
});

describe("brandFreeText", () => {
  it("says the name without its brand words, the rest of the text as the model's own", () => {
    expect(brandFreeText(fields({ name: "Ball pen Blavix", description: "Push ball pen in aluminium." }), counts))
      .toEqual({ title: "Writing > Pens", text: "Ball pen\nPush ball pen in aluminium." });
  });

  it("leaves the description to speak when the name is brand words alone, or opens it", () => {
    expect(brandFreeText(fields({ name: "PENEVER" }), counts)?.text).toBe("Ball pen with a metal clip.");
    expect(brandFreeText(fields({ name: "Ball pen Blavix" }), counts)?.text).toBe("Ball pen with a metal clip.");
  });

  it("keeps the whole name when nothing else would say anything, and has nothing without a name", () => {
    expect(brandFreeText(fields({ name: "PENEVER", description: " " }), counts)?.text).toBe("PENEVER");
    expect(brandFreeText(fields({ name: null }), counts)).toBeUndefined();
  });
});
