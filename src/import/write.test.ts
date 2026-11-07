import { describe, expect, it } from "vitest";
import { jsonParam } from "./write.js";

describe("jsonParam", () => {
  it("drops the characters Postgres jsonb refuses, from the values only", () => {
    const rows = [{ name: "a\u0000b", lone: "x\uD800y", literal: "back\\u0000slash", nested: { list: ["c\u0000"] } }];
    const json = jsonParam(rows);
    expect(JSON.parse(json)).toEqual([{ name: "ab", lone: "x\uFFFDy", literal: "back\\u0000slash", nested: { list: ["c"] } }]);
  });
});
