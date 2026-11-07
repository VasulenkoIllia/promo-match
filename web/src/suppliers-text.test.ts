import { describe, expect, it } from "vitest";
import type { SupplierStatus } from "./suppliers-api";
import { catalogLines, categoryLines, importLines, stockLines, vectorLines } from "./suppliers-text";
import { formatNumber as n } from "./text";
import { momentText } from "./users-text";

const STARTED = "2026-11-06T18:05:10.000Z";
const FINISHED = "2026-11-06T18:05:19.000Z";
const EARLIER = "2026-11-05T09:00:00.000Z";

function supplier(overrides: Partial<SupplierStatus> = {}): SupplierStatus {
  return {
    code: "makito",
    name: "Makito",
    catalog: { models: 4606, variants: 17_705, photos: 35_902 },
    lastImport: {
      status: "succeeded", startedAt: STARTED, finishedAt: FINISHED,
      models: { created: 0, changed: 2, missing: 43, reactivated: 0 },
    },
    lastSucceededAt: FINISHED,
    stock: { variants: 16_753 },
    vectors: {
      photos: { inScope: 26_322, ready: 26_322, failed: 0, pending: 0 },
      texts: { models: 4606, ready: 4606, stale: 0, missing: 0, withoutText: 0 },
      lastRun: { status: "succeeded", startedAt: EARLIER, finishedAt: EARLIER },
    },
    categories: { paths: 214, pathsWithout: 0, modelsWithout: 0 },
    ...overrides,
  };
}

const texts = (lines: { text: string }[]) => lines.map((each) => each.text);
const warned = (lines: { text: string; isWarn: boolean }[]) => lines.filter((each) => each.isWarn).map((each) => each.text);

describe("catalogLines", () => {
  it("names the counts in their plural forms", () => {
    expect(texts(catalogLines(supplier({ catalog: { models: 1, variants: 3, photos: 5 } }))))
      .toEqual(["1 модель", "3 варіанти", "5 фото"]);
  });
});

describe("importLines", () => {
  it("shows a succeeded import with its models' changes and nothing to look at", () => {
    const lines = importLines(supplier());
    expect(texts(lines)).toEqual([`${momentText(FINISHED)}, успішно`, "Нових моделей 0, змінених 2", "Зникли з фіду 43"]);
    expect(warned(lines)).toEqual([]);
  });

  it("marks a failed import and names the last that succeeded", () => {
    const lines = importLines(supplier({
      lastImport: { status: "failed", startedAt: STARTED, finishedAt: FINISHED, models: null },
      lastSucceededAt: EARLIER,
    }));
    expect(texts(lines)).toEqual([`${momentText(FINISHED)}, збій`, `Останній успішний ${momentText(EARLIER)}`]);
    expect(warned(lines)).toEqual([`${momentText(FINISHED)}, збій`]);
  });

  it("does not call a run without its end running", () => {
    const lines = importLines(supplier({
      lastImport: { status: "running", startedAt: STARTED, finishedAt: null, models: null }, lastSucceededAt: null,
    }));
    expect(texts(lines)).toEqual([`Почато ${momentText(STARTED)}, не завершено`, "Успішного імпорту ще не було"]);
    expect(warned(lines)).toHaveLength(2);
  });

  it("says when a supplier was never imported", () => {
    expect(warned(importLines(supplier({ lastImport: null, lastSucceededAt: null })))).toEqual(["Ще не імпортувався"]);
  });

  it("names the models back in the feed only when there are some", () => {
    const lines = importLines(supplier({
      lastImport: { status: "succeeded", startedAt: STARTED, finishedAt: FINISHED,
        models: { created: 1, changed: 0, missing: 0, reactivated: 4 } },
    }));
    expect(texts(lines).slice(1)).toEqual(["Нових моделей 1, змінених 0", "Зникли з фіду 0", "Повернулись 4"]);
  });
});

describe("stockLines", () => {
  it("counts the variants with fresh stock out of all", () => {
    expect(texts(stockLines(supplier()))).toEqual([`Варіантів ${n(16_753)} з ${n(17_705)}`, `З імпорту ${momentText(FINISHED)}`]);
  });

  it("warns that the minimum stock filter drops a supplier without stock", () => {
    const lines = stockLines(supplier({ stock: { variants: 0 } }));
    expect(warned(lines)).toEqual(["Даних про залишок немає"]);
    expect(texts(lines)).toContain("Фільтр залишку прибирає всі товари");
  });
});

describe("vectorLines", () => {
  it("shows ready vectors alone when nothing is left", () => {
    const lines = vectorLines(supplier());
    expect(texts(lines)).toEqual([
      `Фото готові ${n(26_322)} з ${n(26_322)}`, `Тексти готові ${n(4606)} з ${n(4606)}`, `Запуск ${momentText(EARLIER)}, успішно`,
    ]);
    expect(warned(lines)).toEqual([]);
  });

  it("marks what still needs a run", () => {
    const lines = vectorLines(supplier({ vectors: {
      photos: { inScope: 100, ready: 90, failed: 3, pending: 7 },
      texts: { models: 50, ready: 45, stale: 2, missing: 1, withoutText: 2 },
      lastRun: null,
    } }));
    expect(warned(lines)).toEqual([
      "Фото зі збоєм 3", "Фото чекають 7", "Тексти застаріли 2", "Тексти без вектора 1", "Векторів цієї моделі ще не рахували",
    ]);
    expect(texts(lines)).toContain("Без англійської назви 2");
  });
});

describe("categoryLines", () => {
  it("is quiet when every model is in a shared category", () => {
    const lines = categoryLines(supplier());
    expect(texts(lines)).toEqual(["Усі моделі в спільних категоріях", "Шляхів постачальника 214", "Без зіставлення 0"]);
    expect(warned(lines)).toEqual([]);
  });

  it("marks the models and paths outside the shared list", () => {
    const lines = categoryLines(supplier({ categories: { paths: 216, pathsWithout: 2, modelsWithout: 225 } }));
    expect(warned(lines)).toEqual(["Без спільної категорії 225 моделей", "Без зіставлення 2"]);
  });
});
