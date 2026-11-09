import { describe, expect, it } from "vitest";
import { splitItemNumber } from "./codes.js";

const tail = (colorCode: string | null, size: string | null = null, extra: { version?: string; part?: string } = {}) => ({
  colorCode, version: extra.version ?? null, size, part: extra.part ?? null,
});

describe("splitItemNumber", () => {
  it("reads a colour, its shade letter and two colours", () => {
    expect(splitItemNumber("AP100001", "AP100001", false)).toEqual(tail(null));
    expect(splitItemNumber("AP100001-10", "AP100001", false)).toEqual(tail("10"));
    expect(splitItemNumber("AP100001-06A", "AP100001", false)).toEqual(tail("06A"));
    expect(splitItemNumber("AP100001-01T", "AP100001", false)).toEqual(tail("01T"));
    expect(splitItemNumber("AP100001-01-07", "AP100001", false)).toEqual(tail("01-07"));
  });

  it("reads a version without a colour", () => {
    expect(splitItemNumber("AP100002-C", "AP100002", false)).toEqual(tail(null, null, { version: "C" }));
  });

  it("reads textile, memory, age and shoe sizes after the colour or alone", () => {
    expect(splitItemNumber("AP4001-03_XXL", "AP4001", false)).toEqual(tail("03", "XXL"));
    expect(splitItemNumber("AP4001-06A_S", "AP4001", false)).toEqual(tail("06A", "S"));
    expect(splitItemNumber("AP4001-07_M-L", "AP4001", false)).toEqual(tail("07", "M-L"));
    expect(splitItemNumber("AP100003-21_16GB", "AP100003", false)).toEqual(tail("21", "16GB"));
    expect(splitItemNumber("AP100004_8GB", "AP100004", false)).toEqual(tail(null, "8GB"));
    expect(splitItemNumber("AP100005-01_4-5", "AP100005", false)).toEqual(tail("01", "4-5"));
    expect(splitItemNumber("AP100006-A_38-42", "AP100006", false)).toEqual({ colorCode: null, version: "A", size: "38-42", part: null });
    // Single letters of slippers that are no part
    expect(splitItemNumber("AP100007-03_N", "AP100007", false)).toEqual(tail("03", "N"));
  });

  it("names the part of an assembled product, alone or after its size", () => {
    expect(splitItemNumber("AP100008-01T_B", "AP100008", true)).toEqual(tail("01T", null, { part: "B" }));
    expect(splitItemNumber("AP100009-10_42-44-A", "AP100009", true)).toEqual(tail("10", "42-44", { part: "A" }));
    expect(splitItemNumber("AP100009-10_42-44", "AP100009", true)).toEqual(tail("10", "42-44"));
    expect(splitItemNumber("AP100009", "AP100009", true)).toEqual(tail(null));
  });

  it("gives up on a code that is not its model's with a tail it knows", () => {
    expect(splitItemNumber("AP200001-10", "AP100001", false)).toBeNull();
    expect(splitItemNumber("AP100001-10", "", false)).toBeNull();
    expect(splitItemNumber("AP100001.10", "AP100001", false)).toBeNull();
    expect(splitItemNumber("AP100001-1", "AP100001", false)).toBeNull();
    expect(splitItemNumber("AP100001-10_", "AP100001", false)).toBeNull();
  });
});
