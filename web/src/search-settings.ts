// The search settings (src/search/settings.ts, docs/integrations.md, «Налаштування пошуку»): the shapes copied rather
// than imported, as in api.ts, and what the screens make of them. Pure.

export type PhotoOrder = "mixed" | "photo-heavier" | "photo-decides";
export type LiftLevel = "off" | "weak" | "strong";

export interface SearchSettings {
  photoOrder: PhotoOrder;
  isAllModelPhotos: boolean;
  hasImageTextList: boolean;
  hasTextPhotoList: boolean;
  hasTextTextList: boolean;
  isParseQuery: boolean;
  isConditionPass: boolean;
  colorLift: LiftLevel;
  categoryLift: LiftLevel;
  isExclusionSink: boolean;
}

export type SettingKey = keyof SearchSettings;

// The settings in the order of the screens, with the values a choice of more than two offers
export const SETTING_CHOICES: { [Key in SettingKey]: SearchSettings[Key] extends boolean ? null : SearchSettings[Key][] } = {
  photoOrder: ["mixed", "photo-heavier", "photo-decides"],
  isAllModelPhotos: null,
  hasImageTextList: null,
  hasTextPhotoList: null,
  hasTextTextList: null,
  isParseQuery: null,
  isConditionPass: null,
  colorLift: ["off", "weak", "strong"],
  categoryLift: ["off", "weak", "strong"],
  isExclusionSink: null,
};

export const SETTING_KEYS = Object.keys(SETTING_CHOICES) as SettingKey[];

// GET /api/search/settings, and the answer of a save
export interface SettingsAnswer {
  // Every search's, unless a user changes them for one
  defaults: SearchSettings;
  // The search of before the switches
  codeDefaults: SearchSettings;
  // ISO time; null: the admin has not saved any
  updatedAt: string | null;
}

export function changedKeys(value: SearchSettings, defaults: SearchSettings): SettingKey[] {
  return SETTING_KEYS.filter((key) => value[key] !== defaults[key]);
}

// What a search sends of its settings: only those a user changed, so the server's defaults hold for the rest
export function overridesOf(value: SearchSettings, defaults: SearchSettings): Partial<SearchSettings> {
  return Object.fromEntries(changedKeys(value, defaults).map((key) => [key, value[key]]));
}

// A search by text alone needs a text list: the server refuses one with both off (400), unless a code in it finds a model
export function hasNoListFor(value: SearchSettings, hasPhoto: boolean): boolean {
  return !hasPhoto && !value.hasTextPhotoList && !value.hasTextTextList;
}
