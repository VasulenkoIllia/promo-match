// The words of the «Постачальники» screen (SuppliersView.tsx), kept beside text.ts, whose rules they follow. Each cell
// of the table is a few lines; a line that needs someone's attention is marked.
import type { ApiFailure } from "./api";
import type { RunSummary, SupplierStatus } from "./suppliers-api";
import { type ErrorText, formatNumber, plural } from "./text";
import { defaultStatusText, momentText, statusErrorText } from "./users-text";

export interface CellLine {
  text: string;
  isWarn: boolean;
}

const MODELS = { one: "модель", few: "моделі", many: "моделей" };
const VARIANTS = { one: "варіант", few: "варіанти", many: "варіантів" };

function line(text: string, isWarn = false): CellLine {
  return { text, isWarn };
}

// A run still marked running may have been stopped without its end written: it is not called running
function runText({ status, startedAt, finishedAt }: RunSummary): string {
  if (status === "running") return `почато ${momentText(startedAt)}, не завершено`;
  return `${momentText(finishedAt ?? startedAt)}, ${status === "succeeded" ? "успішно" : "збій"}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function catalogLines({ catalog }: SupplierStatus): CellLine[] {
  return [
    line(plural(catalog.models, MODELS)),
    line(plural(catalog.variants, VARIANTS)),
    line(`${formatNumber(catalog.photos)} фото`),
  ];
}

export function importLines({ lastImport, lastSucceededAt }: SupplierStatus): CellLine[] {
  if (!lastImport) return [line("Ще не імпортувався", true)];
  const lines = [line(capitalized(runText(lastImport)), lastImport.status !== "succeeded")];
  const { models } = lastImport;
  if (models) {
    lines.push(line(`Нових моделей ${formatNumber(models.created)}, змінених ${formatNumber(models.changed)}`));
    lines.push(line(`Зникли з фіду ${formatNumber(models.missing)}`));
    if (models.reactivated) lines.push(line(`Повернулись ${formatNumber(models.reactivated)}`));
  }
  if (lastImport.status !== "succeeded") {
    lines.push(lastSucceededAt
      ? line(`Останній успішний ${momentText(lastSucceededAt)}`)
      : line("Успішного імпорту ще не було", true));
  }
  return lines;
}

export function stockLines({ stock, catalog, lastSucceededAt }: SupplierStatus): CellLine[] {
  if (!stock.variants || !lastSucceededAt) {
    return [line("Даних про залишок немає", true), line("Фільтр залишку прибирає всі товари")];
  }
  return [
    line(`Варіантів ${formatNumber(stock.variants)} з ${formatNumber(catalog.variants)}`),
    line(`З імпорту ${momentText(lastSucceededAt)}`),
  ];
}

export function vectorLines({ vectors }: SupplierStatus): CellLine[] {
  const { photos, texts, lastRun } = vectors;
  const lines = [line(`Фото готові ${formatNumber(photos.ready)} з ${formatNumber(photos.inScope)}`)];
  if (photos.failed) lines.push(line(`Фото зі збоєм ${formatNumber(photos.failed)}`, true));
  if (photos.pending) lines.push(line(`Фото чекають ${formatNumber(photos.pending)}`, true));
  lines.push(line(`Тексти готові ${formatNumber(texts.ready)} з ${formatNumber(texts.models)}`));
  if (texts.stale) lines.push(line(`Тексти застаріли ${formatNumber(texts.stale)}`, true));
  if (texts.missing) lines.push(line(`Тексти без вектора ${formatNumber(texts.missing)}`, true));
  if (texts.withoutText) lines.push(line(`Без англійської назви ${formatNumber(texts.withoutText)}`));
  lines.push(lastRun
    ? line(`Запуск ${runText(lastRun)}`, lastRun.status !== "succeeded")
    : line("Векторів цієї моделі ще не рахували", true));
  return lines;
}

export function categoryLines({ categories }: SupplierStatus): CellLine[] {
  return [
    categories.modelsWithout
      ? line(`Без спільної категорії ${plural(categories.modelsWithout, MODELS)}`, true)
      : line("Усі моделі в спільних категоріях"),
    line(`Шляхів постачальника ${formatNumber(categories.paths)}`),
    line(`Без зіставлення ${formatNumber(categories.pathsWithout)}`, categories.pathsWithout > 0),
  ];
}

export const suppliersText = {
  heading: "Постачальники",
  readAt: (iso: string) => `Стан бази на ${momentText(iso)}.`,
  refresh: "Оновити",
  loading: "Читаю стан постачальників...",
  retry: "Спробувати ще раз",
  empty: "У базі ще немає жодного постачальника.",
  columns: {
    name: "Постачальник",
    catalog: "Каталог",
    import: "Імпорт каталогу",
    stock: "Свіжий залишок",
    vectors: "Вектори",
    categories: "Категорії",
  },
  hints: (model: string) => [
    "Екран лише показує стан. Імпорт і вектори запускаються на сервері.",
    "Каталог: активні моделі, їхні активні варіанти й фото. Залишок свіжий, якщо його бачив останній успішний імпорт постачальника: пошук і фільтр «Мінімальний залишок» беруть лише такий.",
    `Вектори моделі ${model}, якою шукає екран. Фото в пошуку: перші 3 фото кожного активного варіанта. Текст застарів, коли опис моделі змінився після вектора: наступний запуск порахує його знову, платно.`,
    "Категорії: модель без спільної категорії пошук знаходить, але фільтр спільних категорій її не показує. Шлях без зіставлення дописують у файл постачальника в src/categories.",
  ],
};

export function suppliersErrorText(failure: ApiFailure): ErrorText {
  return statusErrorText(failure, defaultStatusText);
}
