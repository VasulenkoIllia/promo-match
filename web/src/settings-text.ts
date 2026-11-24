// The words of the search settings (SettingsFields.tsx, SearchSettingsView.tsx, SearchSettingsBlock.tsx), kept beside
// text.ts, whose rules they follow
import type { ApiFailure } from "./api";
import type { LiftLevel, PhotoOrder, SearchSettings, SettingKey } from "./search-settings";
import type { ErrorText } from "./text";
import { defaultStatusText, momentText, statusErrorText } from "./users-text";

const PHOTO_ORDER_NAMES: Record<PhotoOrder, string> = { mixed: "Змішаний", "photo-heavier": "Фото важливіше", "photo-decides": "Фото вирішує" };
const LEVEL_NAMES: Record<LiftLevel, string> = { off: "Вимкнено", weak: "Слабко", strong: "Сильно" };

// A name and one line of what it does, per setting
const SETTINGS: Record<SettingKey, { name: string; hint: string }> = {
  photoOrder: {
    name: "Порядок, коли є фото",
    hint: "Скільки важить схожість фото поруч з описами й текстом запиту: однаково, у 5 разів більше чи лише вона.",
  },
  isAllModelPhotos: {
    name: "Усі фото товару",
    hint: "Порівнювати запит з усіма фото товару, а не лише з трьома. Товар з багатьма кольорами й ракурсами має більше шансів стати вище.",
  },
  hasImageTextList: { name: "Шукати за фото серед описів товарів", hint: "Порівнювати фото-референс з описами товарів у каталозі." },
  hasTextPhotoList: { name: "Шукати за текстом серед фото товарів", hint: "Порівнювати текст запиту з фото товарів у каталозі." },
  hasTextTextList: { name: "Шукати за текстом серед описів товарів", hint: "Порівнювати текст запиту з описами товарів у каталозі." },
  isParseQuery: {
    name: "Читати запит через AI",
    hint: "AI перекладає запит і знаходить у ньому товар, колір, категорію й умови. Без цього текст іде в пошук як є.",
  },
  isConditionPass: {
    name: "Суворі умови з тексту",
    hint: "Піднімати товари, де каталог підтверджує об'єм, розмір, друк чи аркуші з опису. Каталоги кажуть про це неоднаково повно.",
  },
  colorLift: { name: "Піднімати названий колір", hint: "Товари, що мають варіант кольору з запиту, стоять вище." },
  categoryLift: {
    name: "Піднімати названу категорію",
    hint: "Товари категорії з запиту стоять вище. Слово категорії поруч із фото не змішується з фото.",
  },
  isExclusionSink: { name: "Опускати те, що запит виключає", hint: "Товари з матеріалом чи кольором, який запит виключає, стоять нижче." },
};

export function settingName(key: SettingKey): string {
  return SETTINGS[key].name;
}

export function settingHint(key: SettingKey): string {
  return SETTINGS[key].hint;
}

export function valueName(value: SearchSettings[SettingKey]): string {
  if (typeof value === "boolean") return value ? "увімкнено" : "вимкнено";
  return value in PHOTO_ORDER_NAMES ? PHOTO_ORDER_NAMES[value as PhotoOrder] : LEVEL_NAMES[value as LiftLevel];
}

function settingsStatusText(status: number): string {
  if (status === 400) return "Налаштування не прийнято. Оновіть сторінку й спробуйте ще раз.";
  if (status === 403) return "Типові налаштування змінює лише адміністратор.";
  return defaultStatusText(status);
}

export function settingsErrorText(failure: ApiFailure): ErrorText {
  return statusErrorText(failure, settingsStatusText);
}

export const settingsText = {
  heading: "Налаштування пошуку",
  intro: "Типові налаштування для всіх пошуків. Кожен користувач може змінити їх для свого пошуку на екрані пошуку, і журнал пошуків запише, з якими налаштуваннями йшов пошук.",
  loading: "Завантажую налаштування...",
  loadFailed: "Не можу завантажити налаштування пошуку.",
  retry: "Спробувати ще раз",
  save: "Зберегти типові",
  saving: "Зберігаю...",
  saved: "Збережено.",
  codeDefaults: "Як до перемикачів",
  codeDefaultsHint: "Ставить усе так, як пошук працював до перемикачів. Щоб застосувати, збережіть.",
  noTextList: "З цими типовими пошук лише за текстом не працюватиме: обидва пошуки за текстом вимкнено. Знайде хіба товар за кодом.",
  updatedAt: (iso: string | null) => (iso ? `Востаннє збережено ${momentText(iso)}.` : "Ще не зберігались: діє те, що було до перемикачів."),
  beforeSwitches: (value: SearchSettings[SettingKey]) => `До перемикачів: ${valueName(value).toLowerCase()}`,
  changed: "змінено",
  // The search screen's block
  summary: (changed: number) => (changed ? `Налаштування пошуку (змінено: ${changed})` : "Налаштування пошуку"),
  summaryFailed: "Налаштування пошуку (не завантажено)",
  blockHint: "Змінене тут діє лише для ваших пошуків на цій сторінці.",
  reset: "Скинути до типових",
  searchLoadFailed: "Не можу завантажити налаштування: пошук іде з типовими.",
  noList: "Пошук лише за текстом не пішов: у налаштуваннях пошуку вимкнено обидва пошуки за текстом. Увімкніть хоч один.",
  changedNote: (keys: SettingKey[], settings: SearchSettings) =>
    `Пошук ішов зі зміненими налаштуваннями: ${keys.map((key) => `${settingName(key).toLowerCase()} (${valueName(settings[key]).toLowerCase()})`).join(", ")}.`,
};
