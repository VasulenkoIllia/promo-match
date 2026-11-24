import { describe, expect, it } from "vitest";
import { changedKeys, hasNoListFor, overridesOf, type SearchSettings, SETTING_KEYS } from "./search-settings";
import { settingName, settingsText, valueName } from "./settings-text";

const defaults: SearchSettings = {
  photoOrder: "mixed", isAllModelPhotos: false, hasImageTextList: true, hasTextPhotoList: true, hasTextTextList: true, isParseQuery: true,
  isConditionPass: false, colorLift: "weak", categoryLift: "weak", isExclusionSink: true,
};

describe("overridesOf", () => {
  it("sends only the settings changed on the page, in the screens' order", () => {
    const value = { ...defaults, isExclusionSink: false, photoOrder: "photo-decides" } as const;
    expect(overridesOf(value, defaults)).toEqual({ photoOrder: "photo-decides", isExclusionSink: false });
    expect(changedKeys(value, defaults)).toEqual(["photoOrder", "isExclusionSink"]);
    expect(overridesOf(defaults, defaults)).toEqual({});
  });
});

describe("hasNoListFor", () => {
  it("says a text alone has no list when both text lists are off, while a photo always has its own", () => {
    const noText = { ...defaults, hasTextPhotoList: false, hasTextTextList: false };
    expect(hasNoListFor(noText, false)).toBe(true);
    expect(hasNoListFor(noText, true)).toBe(false);
    expect(hasNoListFor({ ...noText, hasTextTextList: true }, false)).toBe(false);
  });
});

describe("the words of the settings", () => {
  it("names every setting and every value, without long dashes", () => {
    const words = [
      ...SETTING_KEYS.map(settingName),
      ...(["mixed", "photo-heavier", "photo-decides", "off", "weak", "strong", true, false] as const).map(valueName),
    ];
    expect(words.every((word) => word.length > 0 && !/[—–]/.test(word))).toBe(true);
    expect(valueName("photo-heavier")).toBe("Фото важливіше");
    expect(valueName("strong")).toBe("Сильно");
  });

  it("says which settings a search ran with changed", () => {
    expect(settingsText.changedNote(["photoOrder", "isConditionPass"], { ...defaults, photoOrder: "photo-decides", isConditionPass: true }))
      .toBe("Пошук ішов зі зміненими налаштуваннями: порядок, коли є фото (фото вирішує), суворі умови з тексту (увімкнено).");
  });
});
