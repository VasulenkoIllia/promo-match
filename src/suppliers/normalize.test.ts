import { describe, expect, it } from "vitest";
import {
  cleanText, localized, parseAmount, parseDate, parseDecimal, parseGrams, parseInteger, parseMinQuantity, parseTimestamp,
  parseUrl, restOf, shiftDecimal,
} from "./normalize.js";

describe("cleanText", () => {
  it("decodes entities, drops tags and folds whitespace", () => {
    expect(cleanText("Pen &amp; pencil&nbsp;set<br>with <b>gift</b>  box")).toBe("Pen & pencil set with gift box");
    expect(cleanText("Długopis &#322;&#x105; &oacute;&Lstrok;")).toBe("Długopis łą óŁ");
  });

  it("keeps an escaped tag and a lone angle bracket as text", () => {
    expect(cleanText("&lt;b&gt; size < 5 cm")).toBe("<b> size < 5 cm");
  });

  it("leaves an unknown entity for the report to count", () => {
    expect(cleanText("a &unknownthing; b")).toBe("a &unknownthing; b");
  });

  it("gives no value for empty, blank and non-text input; a number as its text", () => {
    expect(cleanText("")).toBeNull();
    expect(cleanText("    ")).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText({})).toBeNull();
    expect(cleanText(0)).toBe("0");
  });

  it("turns control characters, which Postgres would refuse, into space", () => {
    expect(cleanText("a\u0000b\u0007c\n")).toBe("a b c");
  });
});

describe("parseDecimal", () => {
  it("reads the suppliers' number formats", () => {
    expect(parseDecimal("3 030")).toBe("3030");
    expect(parseDecimal("20 000")).toBe("20000");
    expect(parseDecimal("3,40")).toBe("3.40");
    expect(parseDecimal("0.162")).toBe("0.162");
    expect(parseDecimal("1.234,56")).toBe("1234.56");
    expect(parseDecimal("1,234.56")).toBe("1234.56");
    expect(parseDecimal(12.5)).toBe("12.5");
  });

  it("gives no value for text that is not a number", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("2-3")).toBeNull();
    expect(parseDecimal("12,0 x Ø0,8 cm")).toBeNull();
    expect(parseDecimal(Number.NaN)).toBeNull();
    expect(parseDecimal(null)).toBeNull();
  });
});

describe("parseInteger and parseAmount", () => {
  it("reads whole numbers, not fractions", () => {
    expect(parseInteger("10 883")).toBe(10_883);
    expect(parseInteger(9)).toBe(9);
    expect(parseInteger("19,5")).toBeNull();
  });

  it("takes a positive amount only: 0 means no price", () => {
    expect(parseAmount("1,23")).toBe("1.23");
    expect(parseAmount(0)).toBeNull();
    expect(parseAmount("0.00")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("values bound by their columns", () => {
  it("takes a weight in grams or kilograms that fits weight_grams, never a negative one", () => {
    expect(parseGrams("19,5")).toBe("19.5");
    expect(parseGrams("0.138", 3)).toBe("138");
    expect(parseGrams("-5")).toBeNull();
    expect(parseGrams("999999999")).toBe("999999999");
    expect(parseGrams("1000000", 3)).toBeNull();
  });

  it("takes a price's starting quantity from 1", () => {
    expect(parseMinQuantity("5 000")).toBe(5000);
    expect(parseMinQuantity("0")).toBeNull();
    expect(parseMinQuantity(-1)).toBeNull();
  });
});

describe("shiftDecimal", () => {
  it("moves the point on the digits, kilograms to grams", () => {
    expect(shiftDecimal("0.162", 3)).toBe("162");
    expect(shiftDecimal("1.5", 3)).toBe("1500");
    expect(shiftDecimal("12", 3)).toBe("12000");
    expect(shiftDecimal("0.0001", 3)).toBe("0.1");
    expect(shiftDecimal("2.34567", 3)).toBe("2345.67");
  });
});

describe("dates, times and links", () => {
  it("takes a real calendar date only", () => {
    expect(parseDate("2026-11-10")).toBe("2026-11-10");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("10.11.2026")).toBeNull();
  });

  it("takes a time with its zone only", () => {
    expect(parseTimestamp("2026-10-28T18:45:09+01:00")).toBe("2026-10-28T18:45:09+01:00");
    expect(parseTimestamp("2026-10-24T08:42:16")).toBeNull();
  });

  it("takes https links only", () => {
    expect(parseUrl("https://files.axpol.com/fotohr/p327.102__b_1.jpg")).toBe("https://files.axpol.com/fotohr/p327.102__b_1.jpg");
    expect(parseUrl("http://files.axpol.com/a.jpg")).toBeNull();
    expect(parseUrl("p327.102__b_1.jpg")).toBeNull();
  });
});

describe("localized and restOf", () => {
  it("keeps the languages that have a text", () => {
    expect(localized({ pl: "Długopis", en: "", de: null })).toEqual({ pl: "Długopis" });
  });

  it("keeps the unmapped fields, texts cleaned, empty ones out", () => {
    const rest = restOf({ CodeERP: "P1.1", Page: "424", Film: "", Promotion: 0, InkColor: "black&nbsp;" }, new Set(["CodeERP"]));
    expect(rest).toEqual({ Page: "424", Promotion: 0, InkColor: "black" });
  });
});
