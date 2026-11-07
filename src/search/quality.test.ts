import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config.js";
import {
  answeredRun, type CaseRun, checkLimits, decodeCases, firstRank, parseCsv, pickModel, type QualityCase, readCases,
  shareText, summarize, unreachableIssues,
} from "./quality.js";

// config.ts reads DATABASE_URL on import; the score needs none of it
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, required: () => "" }));

const HEADER = "id,photo,text,same,analogs,note";

function cases(...lines: string[]) {
  return readCases(parseCsv([HEADER, ...lines].join("\n")));
}

describe("parseCsv", () => {
  it("reads quoted cells with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('a,b\n"red, blue","say ""hi""\nthere"\n')).toEqual([["a", "b"], ["red, blue", 'say "hi"\nthere']]);
  });

  it("tells the delimiter from the header, and takes Windows line ends", () => {
    expect(parseCsv("a;b\r\n1,5;2\r\n")).toEqual([["a", "b"], ["1,5", "2"]]);
    expect(parseCsv("a\tb\n1,5\t2")).toEqual([["a", "b"], ["1,5", "2"]]);
  });

  it("keeps a quote inside an unquoted cell and an empty last cell", () => {
    expect(parseCsv('a,b\n5" mug,')).toEqual([["a", "b"], ['5" mug', ""]]);
  });

  it("refuses a quote that is never closed rather than taking the rest of the file as one cell", () => {
    expect(() => parseCsv('a,b\n"red,1\n2,3\n')).toThrow(ConfigError);
  });
});

describe("decodeCases", () => {
  it("drops the byte order mark of Excel's CSV UTF-8", () => {
    expect(decodeCases(new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x64]))).toBe("id");
  });

  it("refuses Windows-1251 rather than passing garbled queries on", () => {
    expect(() => decodeCases(new Uint8Array([0xea, 0xf0, 0xf3, 0xe6, 0xea, 0xe0]))).toThrow(ConfigError);
  });
});

describe("readCases", () => {
  it("reads a case with several codes, any separator, and leaves other columns alone", () => {
    const { cases: read, issues } = cases('1,a.jpg,"червона чашка",V1 MO2;P3,"V4, V5",для перевірки');
    expect(issues).toEqual([]);
    expect(read).toEqual([{ id: "1", photo: "a.jpg", text: "червона чашка", same: ["V1", "MO2", "P3"], analogs: ["V4", "V5"] }]);
  });

  it("takes a case with a text only or analogs only, and skips blank rows", () => {
    const { cases: read, issues } = cases(",,,,,", "2,,кружка,,V4,");
    expect(issues).toEqual([]);
    expect(read).toEqual([{ id: "2", text: "кружка", same: [], analogs: ["V4"] }]);
  });

  it("names every broken row, counted as in a spreadsheet", () => {
    const { issues } = cases("1,,,V1,,", "2,a.jpg,,,,", ",a.jpg,,V1,,", "4,a.jpg,,V1,,", "4,../.env,,V1,,", "5,a.jpg,,V1,v1,");
    expect(issues).toEqual([
      "case 1: no photo and no text",
      "case 2: no right model",
      "row 4: no id",
      "row 6: the id 4 is used twice",
      'case 4: the photo must be a file name, got "../.env"',
      "case 5: V1 is both the same product and an analog",
    ]);
  });

  it("refuses a text the API would refuse and a row with a stray delimiter", () => {
    expect(cases(`1,,${"а".repeat(1_001)},V1,,`).issues).toEqual(["case 1: the text is over 1000 characters"]);
    expect(cases("1,,red, blue mug,V1,V2,note,extra").issues[0]).toContain("row 2: more cells than columns");
  });

  it("names the missing columns and an empty file", () => {
    expect(readCases(parseCsv("id,photo\n1,a.jpg")).issues).toEqual(["the header has no column text, same, analogs"]);
    expect(cases().issues).toEqual(["the file has no cases"]);
  });
});

describe("pickModel", () => {
  it("takes a SKU's model, and a model's own code before a SKU equal to it", () => {
    expect(pickModel("V1-01", [{ modelId: 7, label: "axpol V1", isModelCode: false }])).toBe(7);
    expect(pickModel("V1", [
      { modelId: 8, label: "axpol V9", isModelCode: false }, { modelId: 7, label: "axpol V1", isModelCode: true },
    ])).toBe(7);
  });

  it("explains a code that stands for no model or for two", () => {
    expect(pickModel("X", [])).toBe("X is not in the catalogues");
    expect(pickModel("X", [
      { modelId: 7, label: "axpol X", isModelCode: true }, { modelId: 8, label: "midocean X", isModelCode: true },
    ])).toBe("X stands for axpol X, midocean X");
  });
});

describe("firstRank", () => {
  it("gives the best rank of the models, null when none is there", () => {
    const results = [{ rank: 1, modelId: 5 }, { rank: 2, modelId: 6 }, { rank: 3, modelId: 7 }];
    expect(firstRank(results, [7, 6])).toBe(2);
    expect(firstRank(results, [9])).toBeNull();
    expect(firstRank(results, [])).toBeNull();
  });
});

describe("summarize", () => {
  const photoCase: QualityCase = { id: "1", photo: "a.jpg", same: [], analogs: [] };
  const flags = { isComplete: true, textUnreadReason: null };
  const failed: CaseRun = { status: "failed", caseId: "9", kind: "photo", hasSame: true, error: "502" };

  function run(same: number[], analogs: number[], modelAtRank: Record<number, number>, kase = photoCase) {
    const results = Object.entries(modelAtRank).map(([rank, modelId]) => ({ rank: Number(rank), modelId }));
    return answeredRun(kase, { same, analogs }, results, flags);
  }

  it("counts rank 10 as a hit and rank 11 or not found as a miss", () => {
    const summary = summarize([run([1], [], { 10: 1 }), run([1], [], { 11: 1 }), run([1], [], {})]);
    expect(summary.same).toEqual({ hits: 1, cases: 3 });
    expect(summary.sameOrAnalog).toEqual({ hits: 1, cases: 3 });
  });

  it("leaves a case with analogs only out of the same-product number", () => {
    const summary = summarize([run([1], [2], { 3: 2 }), run([], [2], { 1: 2 })]);
    expect(summary.same).toEqual({ hits: 0, cases: 1 });
    expect(summary.sameOrAnalog).toEqual({ hits: 2, cases: 2 });
  });

  it("counts a failed search in no share and says so", () => {
    const summary = summarize([run([1], [], { 1: 1 }), failed]);
    expect(summary.same).toEqual({ hits: 1, cases: 1 });
    expect(summary.sameOrAnalog).toEqual({ hits: 1, cases: 1 });
    expect(summary.failed).toBe(1);
  });

  it("splits the shares by the kind of query", () => {
    const textCase: QualityCase = { id: "2", text: "чашка", same: [], analogs: [] };
    const bothCase: QualityCase = { id: "3", photo: "a.jpg", text: "чашка", same: [], analogs: [] };
    const { byKind } = summarize([run([1], [], { 1: 1 }), run([1], [], {}, textCase), run([1], [], {}, bothCase)]);
    expect(byKind.photo.same).toEqual({ hits: 1, cases: 1 });
    expect(byKind.text.same).toEqual({ hits: 0, cases: 1 });
    expect(byKind.both.same).toEqual({ hits: 0, cases: 1 });
  });

  it("counts answers that were cut short or went without Claude's reading", () => {
    const results = [{ rank: 1, modelId: 1 }];
    const expected = { same: [1], analogs: [] };
    const summary = summarize([
      answeredRun(photoCase, expected, results, { isComplete: false, textUnreadReason: null }),
      answeredRun(photoCase, expected, results, { isComplete: true, textUnreadReason: "rejected" }),
    ]);
    expect(summary.incomplete).toBe(1);
    expect(summary.textUnread).toBe(1);
  });
});

describe("shareText", () => {
  it("shows the count and the percent, and no number without cases", () => {
    expect(shareText({ hits: 18, cases: 25 })).toBe("18/25 (72%)");
    expect(shareText({ hits: 0, cases: 0 })).toBe("no cases");
  });
});

describe("unreachableIssues", () => {
  it("names the models the search cannot reach, in their case, among same and analogs alike", () => {
    const expected = new Map([["1", { same: [7], analogs: [8] }], ["2", { same: [], analogs: [7] }], ["3", { same: [9], analogs: [] }]]);
    expect(unreachableIssues(expected, (modelId) => modelId === 9, (modelId) => `axpol V${modelId}`)).toEqual([
      "case 1: axpol V7 is not in the search: inactive, or no vectors of a model",
      "case 1: axpol V8 is not in the search: inactive, or no vectors of a model",
      "case 2: axpol V7 is not in the search: inactive, or no vectors of a model",
    ]);
  });
});

describe("checkLimits", () => {
  const estimate = { embeddingUsd: { gemini: 0.2, voyage: 0.3 }, parseUsd: 0.1, texts: 2 };

  it("adds up the embedding models and lets a run through at its limits", () => {
    expect(() => { checkLimits(estimate, 0.5, 0.1); }).not.toThrow();
  });

  it("refuses a run over either limit, naming it", () => {
    expect(() => { checkLimits(estimate, 0.4, 1); }).toThrow(/\$0\.5000, over SEARCH_BUDGET_USD/);
    expect(() => { checkLimits(estimate, 1, 0.05); }).toThrow(/\$0\.1000, over QUERY_PARSE_BUDGET_USD/);
  });
});
