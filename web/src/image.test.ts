import { describe, expect, it } from "vitest";
import { cropRect, fullRect, MIN_CROP_SIDE_PX, outputSize } from "./image";

const size = { width: 1000, height: 800 };

describe("cropRect", () => {
  it("takes a drag in any direction", () => {
    expect(cropRect({ x: 600.4, y: 500.6 }, { x: 100.2, y: 50 }, size, MIN_CROP_SIDE_PX))
      .toEqual({ x: 100, y: 50, width: 500, height: 451 });
  });

  it("keeps the frame within the photo", () => {
    expect(cropRect({ x: -50, y: -20 }, { x: 1200, y: 900 }, size, MIN_CROP_SIDE_PX)).toEqual(fullRect(size));
  });

  it("reads a click or a thin frame as no crop", () => {
    expect(cropRect({ x: 10, y: 10 }, { x: 10, y: 10 }, size, MIN_CROP_SIDE_PX)).toBeNull();
    expect(cropRect({ x: 10, y: 10 }, { x: 10 + MIN_CROP_SIDE_PX - 1, y: 400 }, size, MIN_CROP_SIDE_PX)).toBeNull();
    expect(cropRect({ x: 10, y: 10 }, { x: 10 + MIN_CROP_SIDE_PX, y: 10 + MIN_CROP_SIDE_PX }, size, MIN_CROP_SIDE_PX))
      .not.toBeNull();
  });

  it("measures the threshold in the photo's pixels, so a shaky click on a large photo shown small is still a click", () => {
    const large = { width: 4000, height: 3000 };
    const scale = 8;
    expect(cropRect({ x: 100, y: 100 }, { x: 116, y: 116 }, large, MIN_CROP_SIDE_PX * scale)).toBeNull();
  });

  it("gives no frame for a photo of no size", () => {
    expect(cropRect({ x: 0, y: 0 }, { x: 50, y: 50 }, { width: Number.NaN, height: 0 }, MIN_CROP_SIDE_PX)).toBeNull();
  });
});

describe("outputSize", () => {
  it("shrinks the longest side to 1024 px and keeps the proportions", () => {
    expect(outputSize({ x: 0, y: 0, width: 4032, height: 3024 })).toEqual({ width: 1024, height: 768 });
    expect(outputSize({ x: 0, y: 0, width: 600, height: 3000 })).toEqual({ width: 205, height: 1024 });
  });

  it("never enlarges a small frame", () => {
    expect(outputSize({ x: 5, y: 5, width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
  });
});
