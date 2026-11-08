// Every word the UI shows, in one place: the interface is Ukrainian for the demo, while its language is still the
// client's call (docs/requirements.md, open question 8)
import {
  ApiError, type ApiFailure, type ConfidenceLevel, type FactFilters, type LinkType, type Match, type OwnProduct, type PriceRange,
} from "./api";
import { amountOf, formatDate, type MatchKey, MAX_MIN_STOCK, type PriceSpan } from "./format";

// The colour groups of the query parse (src/search/query-parse-contract.ts, COLOR_GROUPS)
const COLOR_NAMES: Record<string, string> = {
  black: "чорний", white: "білий", grey: "сірий", blue: "синій", green: "зелений", red: "червоний",
  brown: "коричневий", orange: "помаранчевий", pink: "рожевий", purple: "фіолетовий", yellow: "жовтий",
  silver: "сріблястий", gold: "золотистий", mix: "різнокольоровий",
};

// By the codes of the shared list of materials (src/suppliers/materials.ts); a code a newer server adds is shown as it is
const MATERIAL_NAMES: Partial<Record<string, string>> = {
  plastic: "пластик", tritan: "тритан", acrylic: "акрил", "wheat-straw": "пшенична солома", pet: "PET", metal: "метал",
  steel: "сталь", "stainless-steel": "нержавійна сталь", aluminium: "алюміній", glass: "скло", ceramic: "кераміка",
  porcelain: "порцеляна", wood: "дерево", bamboo: "бамбук", textile: "текстиль", cotton: "бавовна", polyester: "поліестер",
  nylon: "нейлон", canvas: "канвас", jute: "джут", felt: "фетр", nonwoven: "нетканий матеріал", fleece: "фліс",
  paper: "папір", cardboard: "картон", leather: "шкіра", "pu-leather": "штучна шкіра", rubber: "гума", silicone: "силікон",
  cork: "корок", stone: "камінь",
};

// By the reasons of ParseFailure (api.ts); a reason a newer server adds is shown as it is
const PARSE_FAILURES: Partial<Record<string, string>> = {
  "not-configured": "немає ключа Claude",
  "budget-spent": "денний ліміт Claude вичерпано",
  "timed-out": "Claude не відповів вчасно",
  "rejected": "Claude API не прийняв запит, подробиці в лозі сервера",
  "provider-failed": "Claude API недоступний",
  "refused": "Claude відмовився розбирати запит",
  "bad-answer": "відповідь Claude не за контрактом",
};

const LINK_TYPE_NAMES: Record<LinkType, string> = { same: "Той самий", analog: "Аналог" };

const CONDITION_NAMES: Record<MatchKey, string> = {
  volumeMl: "Об'єм", materials: "Матеріал", sizeCm: "Розмір", printTechniques: "Друк", sheets: "Аркуші", gsm: "Щільність",
};
const CONFIDENCE_WORDS: Record<ConfidenceLevel, string> = { high: "висока", medium: "середня", low: "низька" };
const MATCH_WORDS: Record<Match, string> = { fits: "підходить", unknown: "не перевірено", against: "не підходить" };

const SECONDS_IN_MS = 1000;
// Below this a cost reads «менше»: amounts shows four places, and a short text's vector alone would round to zero
const SMALLEST_COST_USD = 0.0001;
const numbers = new Intl.NumberFormat("uk-UA");
const amounts = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const seconds = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 });
const plurals = new Intl.PluralRules("uk-UA");

export interface PluralForms {
  one: string;
  few: string;
  many: string;
}

export function plural(count: number, forms: PluralForms): string {
  const rule = plurals.select(count);
  return `${numbers.format(count)} ${rule === "one" ? forms.one : rule === "few" ? forms.few : forms.many}`;
}

function costText(usd: number): string {
  if (usd === 0) return "без оплати";
  const amount = `$${amounts.format(Math.max(usd, SMALLEST_COST_USD))}`;
  return usd < SMALLEST_COST_USD ? `менше ${amount} за прайсом` : `${amount} за прайсом`;
}

export function formatNumber(value: number): string {
  return numbers.format(value);
}

function amount(value: number): string {
  return amounts.format(value);
}

// A variant's price as the API gives it: numeric(12,4) as text, shown as it is when it is not a number
export function priceText(price: { amount: string; currency: string }): string {
  const value = amountOf(price.amount);
  return `${value === null ? price.amount : amount(value)} ${price.currency}`;
}

export function priceSpanText({ min, max, currency }: PriceSpan): string {
  return min === max ? `${amount(min)} ${currency}` : `від ${amount(min)} до ${amount(max)} ${currency}`;
}

export function suggestedPriceText({ min, max, currency }: PriceRange): string {
  const unit = currency ? ` ${currency}` : "";
  if (min !== null && max !== null) return `ціна від ${amount(min)} до ${amount(max)}${unit}`;
  if (max !== null) return `ціна до ${amount(max)}${unit}`;
  // The server sends no price with neither end (src/search/query-parse-contract.ts, priceOf)
  return min === null ? "" : `ціна від ${amount(min)}${unit}`;
}

export function colorName(group: string): string {
  return COLOR_NAMES[group] ?? group;
}

export function linkTypeName(type: LinkType): string {
  return LINK_TYPE_NAMES[type];
}

export interface ErrorText {
  message: string;
  // The server's own words, in English, for whoever reads the log
  detail: string | null;
}

const UNREACHABLE: ErrorText = {
  message: "Сервер пошуку не відповідає. Спробуйте ще раз за хвилину.",
  detail: "the API server is not reachable: is pnpm run dev running?",
};

export function searchErrorText(failure: ApiFailure): ErrorText {
  switch (failure.kind) {
    case "network":
      return UNREACHABLE;
    case "limited":
      return { message: `Забагато пошуків за хвилину. Спробуйте за ${formatNumber(failure.retryAfterSeconds)} с.`, detail: null };
    case "timeout":
      return { message: "Не дочекався відповіді сервера. Спробуйте ще раз.", detail: null };
    case "bad-answer":
      return { message: "Сервер відповів не тим, що я очікував. Спробуйте оновити сторінку.", detail: null };
    case "status":
      // The server answers every error with { error }; a 5xx without it is the dev proxy's, with the API down
      if (failure.detail === null && failure.status >= 500) return UNREACHABLE;
      return { message: statusText(failure.status), detail: failure.detail };
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Запит не прийнято. Перевірте фото, опис і фільтри.";
    case 403:
      return "Сервер не прийняв запит із цієї сторінки. Оновіть її й спробуйте ще раз.";
    case 413:
      return "Фото завелике для пошуку.";
    case 422:
      return "Зовнішній сервіс пошуку не прийняв фото чи опис. Спробуйте інше фото чи інше формулювання.";
    case 429:
      return "Денний ліміт витрат на пошук вичерпано. Він оновиться завтра.";
    case 502:
      return "Зовнішній сервіс пошуку відповів помилкою. Спробуйте ще раз за хвилину.";
    case 503:
      return "Для цієї моделі ембедінгів на сервері немає ключа. Оберіть іншу модель.";
    case 504:
      return "Пошук не встиг вчасно. Спробуйте ще раз чи звузьте фільтри.";
    default:
      return `Сервер відповів помилкою ${status}. Спробуйте ще раз.`;
  }
}

function ownProductStatusText(status: number): string {
  switch (status) {
    case 400:
      return "Запит не прийнято. Перевірте назву й артикул.";
    case 403:
      return "Сервер не прийняв запит із цієї сторінки. Оновіть її й спробуйте ще раз.";
    case 404:
      return "Не знайшов цей товар чи модель.";
    case 409:
      return "Свій товар з такою назвою чи артикулом уже є.";
    default:
      return `Сервер відповів помилкою ${status}. Спробуйте ще раз.`;
  }
}

// The failures that do not depend on the request read the same as the search's
export function ownProductErrorText(failure: ApiFailure): ErrorText {
  if (failure.kind !== "status" || (failure.detail === null && failure.status >= 500)) return searchErrorText(failure);
  return { message: ownProductStatusText(failure.status), detail: failure.detail };
}

const SECONDS_IN_MINUTE = 60;

// A wrong login and a wrong password read the same: the screen does not tell which logins exist
export function signInErrorText(failure: ApiFailure): ErrorText {
  if (failure.kind === "limited") {
    const minutes = Math.ceil(failure.retryAfterSeconds / SECONDS_IN_MINUTE);
    return { message: `Забагато спроб. Спробуйте за ${formatNumber(minutes)} хв.`, detail: null };
  }
  if (failure.kind === "status" && (failure.status === 400 || failure.status === 401)) {
    return { message: "Неправильний логін чи пароль.", detail: null };
  }
  return searchErrorText(failure);
}

// A failure of the API in the given words; anything else is the page's own bug, for the console
export function errorTextFor(error: unknown, words: (failure: ApiFailure) => ErrorText): ErrorText {
  if (error instanceof ApiError) return words(error.failure);
  console.error(error);
  return { message: text.search.failed, detail: null };
}

export const text = {
  title: "Пошук товарів постачальників",
  auth: {
    heading: "Вхід",
    login: "Логін",
    password: "Пароль",
    submit: "Увійти",
    pending: "Входжу...",
    checking: "Перевіряю вхід...",
    checkFailed: "Не можу перевірити вхід.",
    retry: "Спробувати ще раз",
    logout: "Вийти",
    logoutPending: "Виходжу...",
    logoutFailed: "Не вдалося вийти. Спробуйте ще раз.",
  },
  tabs: {
    label: "Розділи",
    search: "Пошук",
    own: (count: number | null) => (count === null ? "Свої товари" : `Свої товари (${formatNumber(count)})`),
    suppliers: "Постачальники",
    users: "Користувачі",
  },
  own: {
    heading: "Свої товари",
    newHeading: "Новий свій товар",
    name: "Назва",
    code: "Артикул",
    codeHint: "Необов'язково.",
    create: "Створити",
    creating: "Створюю...",
    loading: "Завантажую свої товари...",
    empty: "Своїх товарів ще немає. Створіть перший тут чи з картки результату пошуку.",
    incomplete: "Показано не все: товарів чи прив'язок більше, ніж вміщує перелік.",
    retry: "Спробувати ще раз",
    noLinks: "Ще нічого не прив'язано. Знайдіть товар у пошуку й прив'яжіть його з картки.",
    unlink: "Відв'язати",
    unlinkModel: (name: string) => `Відв'язати ${name}`,
    notInCatalog: "Постачальник більше не віддає цю модель.",
    linkOpen: "Прив'язати до свого товару",
    linkModel: (name: string) => `Прив'язати до свого товару: ${name}`,
    product: "Свій товар",
    pickProduct: "Оберіть товар",
    newProduct: "Новий товар",
    option: ({ name, code }: OwnProduct, linkedAs: LinkType | undefined) => [
      code ? `${name} (${code})` : name,
      linkedAs && `уже: ${LINK_TYPE_NAMES[linkedAs].toLowerCase()}`,
    ].filter(Boolean).join(", "),
    linkType: "Тип зв'язку",
    link: "Прив'язати",
    linking: "Прив'язую...",
    cancel: "Скасувати",
    linked: (type: LinkType, name: string) => `${LINK_TYPE_NAMES[type]}: ${name}`,
    marksFailed: "Не вдалося перевірити, які моделі вже прив'язані до своїх товарів.",
  },
  photo: {
    heading: "Фото-референс",
    choose: "Обрати фото",
    replace: "Інше фото",
    remove: "Прибрати",
    wholePhoto: "Усе фото",
    drop: "Перетягніть фото сюди, вставте з буфера (Ctrl+V) чи оберіть файл.",
    cropHint: "Обведіть товар мишкою, щоб обрізати фото. Без рамки в пошук піде все фото.",
    output: (width: number, height: number) => `У пошук піде ${width}×${height} px.`,
    notImage: "Це не фото. Підійдуть JPEG, PNG чи WebP.",
    unreadable: "Не можу прочитати це фото. Підійдуть JPEG, PNG чи WebP.",
    tooLarge: (megabytes: number) => `Файл більший за ${megabytes} МБ.`,
    cropLabel: "Фото-референс, обведіть товар мишкою",
  },
  query: {
    heading: "Опис",
    placeholder: "Наприклад: червона керамічна чашка з логотипом",
    hint: "Будь-якою мовою. Ctrl+Enter запускає пошук.",
  },
  filters: {
    sources: "Постачальники",
    sourcesHint: "Без позначок: усі.",
    categories: "Категорія",
    pickCategory: "Оберіть групу чи категорію",
    addCategory: "Додати",
    wholeGroup: (models: number) => `Уся група (${formatNumber(models)})`,
    category: (name: string, models: number) => `${name} (${formatNumber(models)})`,
    removeCategory: (name: string) => `Прибрати фільтр ${name}`,
    supplierCategories: (name: string) => `Категорії ${name}`,
    pickSupplierCategory: "Оберіть розділ чи категорію",
    supplierCategoriesHint: "Дерево з каталогу постачальника, англійською. Разом зі спільною категорією товар має пройти обидва фільтри.",
    facts: "Точні умови",
    factsHint: "Лише товари, де каталог підтверджує умову. Товари без цих даних не показуються.",
    removeFact: (name: string) => `Прибрати умову ${name}`,
    minStock: "Мінімальний залишок",
    minStockHint: "Хоч один варіант має стільки на складі.",
    minStockInvalid: `Мінімальний залишок: ціле число від 1 до ${formatNumber(MAX_MIN_STOCK)}.`,
    minStockNoData: (names: string[]) => `Без даних про залишок: ${names.join(", ")}. З цим фільтром їхніх товарів не буде.`,
    conditionPass: "Піднімати товари, де каталог підтверджує умови запиту",
    conditionPassHint: "Об'єм, розмір, техніка друку й аркуші з опису. Каталоги постачальників кажуть про це неоднаково повно, тому без позначки порядок лише за схожістю, однаковий для всіх постачальників.",
    model: "Модель ембедінгів",
    modelDefault: "за замовчуванням",
    modelNoKey: "немає ключа",
  },
  search: {
    button: "Шукати",
    pending: "Шукаю...",
    needInput: "Додайте фото, опис чи обидва.",
    noModel: "На сервері немає ключа жодної моделі ембедінгів.",
    imageFailed: "Не вдалося підготувати фото. Спробуйте інше.",
    failed: "Щось пішло не так у браузері, подробиці в консолі.",
    idle: "Додайте фото, опис чи обидва й натисніть «Шукати».",
  },
  options: {
    loading: "Завантажую фільтри...",
    failed: "Не можу завантажити фільтри.",
    retry: "Спробувати ще раз",
  },
  parse: {
    english: "Шукаю англійською:",
    noProduct: "У запиті немає опису товару, текст пішов у пошук як є.",
    codeOnly: "У запиті немає опису товару, шукаю лише за артикулом.",
    unavailable: (reason: string) => `Опис пішов у пошук як є, без перекладу: ${PARSE_FAILURES[reason] ?? reason}.`,
    categories: "Підказані категорії:",
    applyCategory: (name: string) => `Додати фільтр ${name} і шукати знову`,
    applied: "у фільтрі",
    stale: "Запит змінено після пошуку: підказки стосуються попереднього.",
    other: "Ще з запиту, фільтрів для цього поки немає:",
    material: (name: string) => `матеріал ${name}`,
    facts: "Показати лише ті, де каталог це підтверджує:",
    applyFact: (name: string) => `Лишити лише товари, де ${name}, і шукати знову. Товари без цих даних не покажуться.`,
  },
  grades: {
    label: (name: string) => `Оцінка: ${name}`,
    names: { exact: "Саме те", suitable: "Можна запропонувати", wrong: "Не те" },
    failed: "Оцінку не збережено. Спробуйте ще раз.",
  },
  results: {
    heading: "Результати",
    summary: (count: number, tookMs: number, model: string, costUsd: number) =>
      `${plural(count, { one: "модель", few: "моделі", many: "моделей" })} за ${seconds.format(tookMs / SECONDS_IN_MS)} с, ${model}, ${costText(costUsd)}.`,
    count: "Показати",
    empty: "Нічого не знайшов. Спробуйте прибрати частину фільтрів чи змінити запит.",
    confidence: (percent: number, level: ConfidenceLevel) => `Впевненість ${percent}%, ${CONFIDENCE_WORDS[level]}`,
    confidenceNote: "Впевненість це шанс, що товар саме те, що просили. Це оцінка, а не гарантія: вона спирається на автоматичні перевірки, люди її ще не підтвердили. На порядок видачі вона не впливає.",
    confidenceNotePhoto: "За фото оцінка груба: я перевірив її лише на 14 фото, і на кожне в каталозі був схожий товар.",
    incomplete: "Список міг обірватися раніше: можуть бути ще ближчі товари. Звузьте фільтри чи спробуйте ще раз.",
    noCloseMatch: "Близького збігу не знайшов. Показую найближче, що є в каталозі.",
    matchedCode: (code: string, color: string | null, models: number | null) =>
      `Збіг за артикулом ${code}${color ? `, колір ${color}` : ""}${models !== null && models > 1 ? `, код є в ${formatNumber(models)} постачальників` : ""}`,
    conditions: "Відповідність умовам запиту",
    condition: (key: MatchKey, value: Match) => `${CONDITION_NAMES[key]}: ${MATCH_WORDS[value]}`,
    noName: "Без назви",
    noPhoto: "Немає фото",
    openPhoto: "Відкрити фото повністю",
    supplierPage: "На сайті постачальника",
    supplierPageOf: (name: string) => `Відкрити ${name} на сайті постачальника`,
    showPhoto: (index: number) => `Показати фото ${index}`,
    variants: (count: number) => plural(count, { one: "варіант", few: "варіанти", many: "варіантів" }),
    moreColors: (count: number) => `ще ${formatNumber(count)}`,
    noPrice: "ціни немає",
    stock: (count: number, isPartial: boolean) =>
      `Залишок: ${formatNumber(count)} шт.${isPartial ? ", не для всіх варіантів" : ""}`,
    noStock: "Залишок невідомий",
    table: { sku: "SKU", color: "Колір", size: "Розмір", stock: "Залишок", arrival: "Поставка", price: "Ціна" },
    arrival: (date: string | null, quantity: number | null) =>
      [date ? formatDate(date) : null, quantity === null ? null : `${formatNumber(quantity)} шт.`]
        .filter(Boolean).join(", "),
    unknown: "немає даних",
  },
};

export function materialName(code: string): string {
  return MATERIAL_NAMES[code] ?? code;
}

function boundsText(min: string | undefined, max: string | undefined, unit: string): string {
  if (min !== undefined && max !== undefined) return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`;
  return min === undefined ? `до ${max ?? ""} ${unit}` : `від ${min} ${unit}`;
}

function numberText(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatNumber(value);
}

function sidesText(sides: number[] | undefined): string | undefined {
  return sides?.map(formatNumber).join(" × ");
}

// One fact filter in words: on a suggestion and on its chip
export function factText({ volumeMl, materials, sizeCm }: FactFilters): string {
  if (volumeMl) return `об'єм ${boundsText(numberText(volumeMl.min), numberText(volumeMl.max), "мл")}`;
  if (materials) return `матеріал ${materials.map(materialName).join(", ")}`;
  return `розмір ${boundsText(sidesText(sizeCm?.min), sidesText(sizeCm?.max), "см")}`;
}
