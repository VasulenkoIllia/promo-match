import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORY_LIFT } from "./category-word.js";
import { CONDITION_PASS } from "./condition-pass.js";
import { fuseLists, type ListEntry, RRF_K } from "./rank.js";
import {
  changedSettings, CODE_DEFAULT_SETTINGS, mergeSettings, PHOTO_DECIDES_WEIGHT, PHOTO_HEAVIER_WEIGHT, type SearchSettings,
  SETTING_KEYS, settingsInput, storedSettings,
} from "./settings.js";
import { DEFAULT_TUNING } from "./tuning.js";

const changed = (settings: Partial<SearchSettings>) => settingsInput({ ...CODE_DEFAULT_SETTINGS, ...settings });

describe("settingsInput", () => {
  it("gives the code's defaults the very input a search had before the switches", () => {
    expect(settingsInput(CODE_DEFAULT_SETTINGS)).toEqual({ parseQuery: true, conditionPass: null });
  });

  it("weighs the photo-to-photo list by the order asked", () => {
    expect(changed({ photoOrder: "photo-heavier" }).listWeights).toEqual({ "image-photo": PHOTO_HEAVIER_WEIGHT });
    expect(changed({ photoOrder: "photo-decides" }).listWeights).toEqual({ "image-photo": PHOTO_DECIDES_WEIGHT });
  });

  it("turns off each list of its own", () => {
    expect(changed({ hasImageTextList: false }).offLists).toEqual(["image-text"]);
    expect(changed({ hasTextPhotoList: false }).offLists).toEqual(["text-photo"]);
    expect(changed({ hasTextTextList: false }).offLists).toEqual(["text-text"]);
    expect(changed({ hasImageTextList: false, hasTextTextList: false }).offLists).toEqual(["image-text", "text-text"]);
  });

  it("turns the reading off and the condition pass on", () => {
    expect(changed({ isParseQuery: false })).toEqual({ parseQuery: false, conditionPass: null });
    expect(changed({ isConditionPass: true })).toEqual({ parseQuery: true, conditionPass: CONDITION_PASS });
  });

  it("sets the colour's lift alone", () => {
    expect(changed({ colorLift: "off" }).tuning).toEqual({ ...DEFAULT_TUNING, colorLift: null });
    expect(changed({ colorLift: "strong" }).tuning).toEqual({ ...DEFAULT_TUNING, colorLift: 1.5 });
  });

  it("sets both lifts of a category: the one a reader suggests and the one of a text that only names it", () => {
    expect(changed({ categoryLift: "off" })).toMatchObject({ tuning: { ...DEFAULT_TUNING, textCategoryLift: null }, categoryLift: null });
    expect(changed({ categoryLift: "strong" })).toMatchObject({ tuning: { ...DEFAULT_TUNING, textCategoryLift: 1.5 }, categoryLift: 5 });
    expect(DEFAULT_CATEGORY_LIFT).toBe(3);
  });

  it("turns the sinking of what the query rules out off", () => {
    expect(changed({ isExclusionSink: false }).tuning).toEqual({ ...DEFAULT_TUNING, exclusionFactor: null });
  });
});

describe("the photo-to-photo list's weights", () => {
  const entry = (modelId: number, rank: number): ListEntry => ({ modelId, rank, similarity: 0.5, photos: [] });
  // Model 1 a place above model 2 in the photo list, model 2 first in every other list and model 1 far below
  const lists = (rank: number) => ({
    "image-photo": [entry(1, rank), entry(2, rank + 1)],
    "image-text": [entry(2, 1), entry(1, 100)], "text-photo": [entry(2, 1), entry(1, 100)], "text-text": [entry(2, 1), entry(1, 100)],
  });
  const order = (rank: number, weight: number) => fuseLists(lists(rank), 10, { "image-photo": weight }).map((model) => model.modelId);

  it("lets the other lists win a close place when mixed or heavier, never when the photo decides", () => {
    expect(order(1, 1)).toEqual([2, 1]);
    expect(order(1, PHOTO_HEAVIER_WEIGHT)).toEqual([2, 1]);
    expect(order(1, PHOTO_DECIDES_WEIGHT)).toEqual([1, 2]);
  });

  it("keeps the photo list's order down to its deepest model, past the other lists and the condition pass's votes", () => {
    // 288 rows of a photo list are at most 288 models; the pass adds up to two text lists at its weight 0.5
    const others = 3 / (RRF_K + 1) + (2 * CONDITION_PASS.weight) / (RRF_K + 1);
    for (let rank = 1; rank <= 288; rank += 1) {
      expect(PHOTO_DECIDES_WEIGHT / (RRF_K + rank) - PHOTO_DECIDES_WEIGHT / (RRF_K + rank + 1)).toBeGreaterThan(others);
    }
    expect(order(287, PHOTO_DECIDES_WEIGHT)).toEqual([1, 2]);
  });

  it("puts what the photo list did not find after all it found", () => {
    const fused = fuseLists({ "image-photo": [entry(1, 288)], "text-text": [entry(2, 1)] }, 10, { "image-photo": PHOTO_DECIDES_WEIGHT });
    expect(fused.map((model) => model.modelId)).toEqual([1, 2]);
  });
});

describe("mergeSettings", () => {
  it("lays each layer over the one before, a key left out or undefined keeping the value below", () => {
    const admin = { photoOrder: "photo-heavier", colorLift: "off" } as const;
    const search = { colorLift: "strong", isParseQuery: undefined } as const;
    expect(mergeSettings(CODE_DEFAULT_SETTINGS, admin, search)).toEqual({
      ...CODE_DEFAULT_SETTINGS, photoOrder: "photo-heavier", colorLift: "strong",
    });
    expect(mergeSettings(CODE_DEFAULT_SETTINGS)).toEqual(CODE_DEFAULT_SETTINGS);
  });
});

describe("storedSettings", () => {
  it("keeps the keys and values this release knows and names the rest", () => {
    expect(storedSettings({ photoOrder: "photo-decides", colorLift: "huge", oldSwitch: true, isParseQuery: "false" })).toEqual({
      settings: { photoOrder: "photo-decides" }, dropped: ["colorLift", "oldSwitch", "isParseQuery"],
    });
  });

  it("holds nothing of what is not an object", () => {
    for (const json of [null, [], "mixed", 3]) expect(storedSettings(json)).toEqual({ settings: {}, dropped: [] });
  });

  it("reads every setting of the code's defaults back as it is", () => {
    expect(storedSettings(JSON.parse(JSON.stringify(CODE_DEFAULT_SETTINGS)))).toEqual({ settings: CODE_DEFAULT_SETTINGS, dropped: [] });
    expect(SETTING_KEYS).toHaveLength(9);
  });
});

describe("changedSettings", () => {
  it("names the settings that differ from the defaults, in the screens' order", () => {
    const admin = { ...CODE_DEFAULT_SETTINGS, colorLift: "off" } as const;
    expect(changedSettings({ ...admin, isExclusionSink: false, photoOrder: "photo-decides" }, admin)).toEqual(["photoOrder", "isExclusionSink"]);
    expect(changedSettings(admin, admin)).toEqual([]);
  });
});
