import { describe, expect, it } from "vitest";
import { memoryReadings, readingKey, sha256 } from "./query-readings.js";

const key = (text: string) => readingKey("claude-haiku-5-5", sha256("prompt"), text);

describe("the key of a reading", () => {
  it("is the same for the same model, prompt and text", () => {
    expect(key("червона чашка")).toEqual(key("червона чашка"));
  });

  it("differs by the model, the prompt and the text", () => {
    const base = key("чашка");
    expect(readingKey("claude-sonnet-5-5", base.promptSha256, "чашка")).not.toEqual(base);
    expect(readingKey(base.parseModel, sha256("another prompt"), "чашка")).not.toEqual(base);
    expect(key("кружка")).not.toEqual(base);
  });

  it("takes the text as it came: a letter's case or a space is another text", () => {
    expect(key("Чашка").textSha256).not.toBe(key("чашка").textSha256);
    expect(key("чашка ").textSha256).not.toBe(key("чашка").textSha256);
  });

  it("holds only a hash of the text", () => {
    expect(key("чашка для пані Олени").textSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("memoryReadings", () => {
  it("keeps the first answer for a key and gives it back to the second", async () => {
    const readings = memoryReadings();
    expect(await readings.find(key("чашка"))).toBeUndefined();
    expect(await readings.keep(key("чашка"), "first")).toBe("first");
    expect(await readings.keep(key("чашка"), "second")).toBe("first");
    expect(await readings.find(key("чашка"))).toBe("first");
  });

  it("drops the oldest past its limit", async () => {
    const readings = memoryReadings();
    for (let index = 0; index <= 200; index += 1) await readings.keep(key(String(index)), "answer");
    expect(await readings.find(key("0"))).toBeUndefined();
    expect(await readings.find(key("1"))).toBe("answer");
    expect(await readings.find(key("200"))).toBe("answer");
  });
});
