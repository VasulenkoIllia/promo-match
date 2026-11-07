import { describe, expect, it } from "vitest";
import { CONDITION_PASS } from "./condition-pass.js";
import { DEFAULT_SEARCH_MODEL } from "./models.js";
import { SearchInputError } from "./errors.js";
import { listsFor, MAX_QUERY_IMAGE_BYTES, parseSearchBody, queryImage } from "./request.js";

// The signature and the IHDR chunk with the size: all inspectImage reads of a PNG
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("parseSearchBody", () => {
  it("takes a text with the defaults and squeezes its spaces", () => {
    expect(parseSearchBody({ text: "  red   mug \n" })).toEqual({
      text: "red mug", image: undefined, model: DEFAULT_SEARCH_MODEL, limit: 24, parseQuery: true, matchCodes: true, conditionPass: null,
      filters: {},
    });
  });

  it("runs the pass over the catalogue's facts only when the body turns it on", () => {
    expect(parseSearchBody({ text: "mug" }).conditionPass).toBeNull();
    expect(parseSearchBody({ text: "mug", conditionPass: false }).conditionPass).toBeNull();
    expect(parseSearchBody({ text: "mug", conditionPass: true }).conditionPass).toEqual(CONDITION_PASS);
  });

  it("reads an image as base64 or as a data URL, by its bytes", () => {
    const base64 = png(640, 480).toString("base64");
    for (const image of [base64, `data:image/png;base64,${base64}`]) {
      expect(parseSearchBody({ image }).image?.info).toEqual({ mimeType: "image/png", width: 640, height: 480 });
    }
  });

  it("refuses a request without a text or an image, and an image it cannot read", () => {
    expect(() => parseSearchBody({ text: "   " })).toThrow(SearchInputError);
    expect(() => parseSearchBody({ image: "not base64!" })).toThrow("the image is not base64");
    expect(() => parseSearchBody({ image: Buffer.from("<html>").toString("base64") })).toThrow(/not a JPEG or PNG/);
  });
});

describe("queryImage", () => {
  it("refuses an empty or too large image", () => {
    expect(() => queryImage(Buffer.alloc(0))).toThrow("the image is empty");
    expect(() => queryImage(Buffer.alloc(MAX_QUERY_IMAGE_BYTES + 1))).toThrow(/over/);
  });
});

describe("listsFor", () => {
  const image = { bytes: png(1, 1), info: { mimeType: "image/png" as const, width: 1, height: 1 } };

  it("takes every list the inputs allow", () => {
    expect(listsFor({ text: "mug" })).toEqual(["text-photo", "text-text"]);
    expect(listsFor({ image })).toEqual(["image-photo", "image-text"]);
    expect(listsFor({ text: "mug", image })).toEqual(["image-photo", "image-text", "text-photo", "text-text"]);
  });

  it("takes the lists asked for, in their order, only with their inputs", () => {
    expect(listsFor({ text: "mug", image, lists: ["text-text", "image-photo"] })).toEqual(["image-photo", "text-text"]);
    expect(() => listsFor({ text: "mug", lists: ["image-photo"] })).toThrow("no input for the lists image-photo");
  });
});
