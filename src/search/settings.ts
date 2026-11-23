// The search settings (owner's decision of 2026-11-23, docs/decisions.md, «налаштування пошуку перемикачами»): the rules
// that move the order of the results, as switches anyone can read, rather than constants in the code. The admin sets the
// defaults for everyone (src/search/settings-store.ts), any user may change them for one search, and the journal keeps
// the settings of each search. A setting holds a level, not a number: the numbers of each level live here, and the
// defaults give the very search there was before the switches. None of them knows a source. Pure.
import { DEFAULT_CATEGORY_LIFT } from "./category-word.js";
import { CONDITION_PASS, type ConditionPass } from "./condition-pass.js";
import type { ListName } from "./rank.js";
import { DEFAULT_TUNING, type SearchTuning } from "./tuning.js";

const PHOTO_ORDERS = ["mixed", "photo-heavier", "photo-decides"] as const;
export type PhotoOrder = (typeof PHOTO_ORDERS)[number];
const LIFT_LEVELS = ["off", "weak", "strong"] as const;
export type LiftLevel = (typeof LIFT_LEVELS)[number];
const BOOLEANS = [false, true] as const;

export interface SearchSettings {
  // «Порядок, коли є фото»: the weight of the photo-to-photo list in the fusion
  photoOrder: PhotoOrder;
  // The lists beside it: the reference photo against the model texts, the text against the photos and the texts
  hasImageTextList: boolean;
  hasTextPhotoList: boolean;
  hasTextTextList: boolean;
  // Claude reads the text first (src/search/query-parse.ts)
  isParseQuery: boolean;
  // The second pass over the models whose catalogue confirms what the query asks (src/search/condition-pass.ts)
  isConditionPass: boolean;
  // The colour the query names lifts the models that have it (src/search/traits.ts)
  colorLift: LiftLevel;
  // The category the text names lifts its models (src/search/category-word.ts and tuning.ts, textCategoryLift)
  categoryLift: LiftLevel;
  // What the query rules out sinks (src/search/traits.ts)
  isExclusionSink: boolean;
}

export type SettingKey = keyof SearchSettings;

// Every value a setting takes, in the order of the screens; an unknown key or value is refused
const SETTING_VALUES = {
  photoOrder: PHOTO_ORDERS,
  hasImageTextList: BOOLEANS,
  hasTextPhotoList: BOOLEANS,
  hasTextTextList: BOOLEANS,
  isParseQuery: BOOLEANS,
  isConditionPass: BOOLEANS,
  colorLift: LIFT_LEVELS,
  categoryLift: LIFT_LEVELS,
  isExclusionSink: BOOLEANS,
} as const satisfies Record<SettingKey, readonly (string | boolean)[]>;

export const SETTING_KEYS = Object.keys(SETTING_VALUES) as SettingKey[];

// The search as it was before the switches: the admin's defaults start from here, and a setting the database does not
// hold falls back to it
export const CODE_DEFAULT_SETTINGS: SearchSettings = {
  photoOrder: "mixed",
  hasImageTextList: true,
  hasTextPhotoList: true,
  hasTextTextList: true,
  isParseQuery: true,
  isConditionPass: false,
  colorLift: "weak",
  categoryLift: "weak",
  isExclusionSink: true,
};

// «Фото важливіше»: a rank of the photo-to-photo list counts this many times one of another list. On the managers'
// grades of 2026-11-07 to 2026-11-23, not blind: by photo alone the pairs of exact over wrong in the right order went
// from 86.3% to 93.3%, with a text 96.5% to 96.2%; 10 lost more with a text (docs/decisions.md).
export const PHOTO_HEAVIER_WEIGHT = 5;
// «Фото вирішує»: so heavy that the other lists only order what the photo list did not find. A model one place lower in
// that list stays lower when it is first in each other list and in the condition pass's two: 10 000 × (1/(60 + r) −
// 1/(61 + r)) is over 3/61 + 2 × 0.5/61 for every r up to 288, the most models a photo list has (LIST_ROWS). The lifts
// multiply a score, so they work on this order as on the photo list alone.
export const PHOTO_DECIDES_WEIGHT = 10_000;
const PHOTO_WEIGHTS: Record<PhotoOrder, number> = { mixed: 1, "photo-heavier": PHOTO_HEAVIER_WEIGHT, "photo-decides": PHOTO_DECIDES_WEIGHT };

// «Слабко» is what the independent test passed (README «Незалежний тест»). «Сильно», on the same grades: 1.5 the most a
// colour or a category lifts before the pairs get worse (7 and 9 searches); a text that only names a category was not
// among them, so its 5 is a step over the 3 tested. Off for the category is the rule of category-word.ts off too: the
// text then adds its lists as any text does.
const COLOR_LIFTS: Record<LiftLevel, number | null> = { off: null, weak: DEFAULT_TUNING.colorLift, strong: 1.5 };
const TEXT_CATEGORY_LIFTS: Record<LiftLevel, number | null> = { off: null, weak: DEFAULT_TUNING.textCategoryLift, strong: 1.5 };
const CATEGORY_WORD_LIFTS: Record<LiftLevel, number | null> = { off: null, weak: DEFAULT_CATEGORY_LIFT, strong: 5 };

const SWITCHED_LISTS: [ListName, SettingKey][] = [
  ["image-text", "hasImageTextList"], ["text-photo", "hasTextPhotoList"], ["text-text", "hasTextTextList"],
];

// The body's settings for one search, and the admin's for everyone: some or all of them (JSON schema, src/app.ts lets
// no unknown field through). enum without type: a string "false" is refused, not coerced.
const SETTING_PROPERTIES = Object.fromEntries(SETTING_KEYS.map((key) => [key, { enum: SETTING_VALUES[key] }]));
export const settingsSchema = { type: "object", additionalProperties: false, properties: SETTING_PROPERTIES } as const;
export const fullSettingsSchema = { ...settingsSchema, required: SETTING_KEYS } as const;

function isSettingValue(key: SettingKey, value: unknown): boolean {
  return (SETTING_VALUES[key] as readonly unknown[]).includes(value);
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as string[]).includes(key);
}

// Each layer over the one before; a key a layer leaves out (or gives as undefined) keeps the value below
export function mergeSettings(base: SearchSettings, ...layers: Partial<SearchSettings>[]): SearchSettings {
  const given = layers.map((layer) => Object.fromEntries(Object.entries(layer).filter(([, value]) => value !== undefined)));
  return Object.assign({ ...base }, ...given) as SearchSettings;
}

export interface StoredSettings {
  settings: Partial<SearchSettings>;
  // The keys left out: one this release does not know, or with a value it does not take (an older or a newer release
  // saved it). The code's default holds for them, and the caller logs them.
  dropped: string[];
}

// The admin's defaults as the database keeps them, or a journal's row: JSON of any shape
export function storedSettings(json: unknown): StoredSettings {
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const dropped: string[] = [];
  // The table's CHECK keeps an object there; anything else holds nothing
  const entries = typeof json === "object" && json !== null && !Array.isArray(json) ? Object.entries(json) : [];
  for (const [key, value] of entries) {
    if (isSettingKey(key) && isSettingValue(key, value)) settings[key] = value;
    else dropped.push(key);
  }
  return { settings: settings as Partial<SearchSettings>, dropped };
}

// The keys whose value differs from the defaults, in the order of the screens
export function changedSettings(settings: SearchSettings, defaults: SearchSettings): SettingKey[] {
  return SETTING_KEYS.filter((key) => settings[key] !== defaults[key]);
}

// What the search does with the settings: the fields of SearchInput (src/search/request.ts)
export interface SettingsInput {
  parseQuery: boolean;
  conditionPass: ConditionPass | null;
  categoryLift?: number | null;
  tuning?: SearchTuning;
  listWeights?: Partial<Record<ListName, number>>;
  offLists?: ListName[];
}

function isDefaultTuning(tuning: SearchTuning): boolean {
  return (Object.keys(DEFAULT_TUNING) as (keyof SearchTuning)[]).every((key) => tuning[key] === DEFAULT_TUNING[key]);
}

// A field at the search's own default is left out, so a search with the code's defaults gets the very input it got
// before the switches
export function settingsInput(settings: SearchSettings): SettingsInput {
  const tuning: SearchTuning = {
    textCategoryLift: TEXT_CATEGORY_LIFTS[settings.categoryLift], colorLift: COLOR_LIFTS[settings.colorLift],
    exclusionFactor: settings.isExclusionSink ? DEFAULT_TUNING.exclusionFactor : null,
  };
  const categoryLift = CATEGORY_WORD_LIFTS[settings.categoryLift];
  const photoWeight = PHOTO_WEIGHTS[settings.photoOrder];
  const offLists = SWITCHED_LISTS.filter(([, key]) => !settings[key]).map(([name]) => name);
  return {
    parseQuery: settings.isParseQuery,
    conditionPass: settings.isConditionPass ? CONDITION_PASS : null,
    ...(categoryLift === DEFAULT_CATEGORY_LIFT ? {} : { categoryLift }),
    ...(isDefaultTuning(tuning) ? {} : { tuning }),
    ...(photoWeight === 1 ? {} : { listWeights: { "image-photo": photoWeight } }),
    ...(offLists.length ? { offLists } : {}),
  };
}
