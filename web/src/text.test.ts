import { describe, expect, it } from "vitest";
import {
  ownProductErrorText, priceSpanText, priceText, searchErrorText, signInErrorText, suggestedPriceText, text,
} from "./text";

// Intl puts no-break spaces between digit groups and before units
function plain(value: string): string {
  return value.replaceAll(/\s/g, " ");
}

describe("searchErrorText", () => {
  it("explains each status the search answers in plain words and keeps the server's detail apart", () => {
    for (const status of [400, 403, 413, 422, 429, 502, 503, 504]) {
      const error = searchErrorText({ kind: "status", status, detail: "the image is empty" });
      expect(error.message).not.toMatch(/\d{3}/);
      expect(error.detail).toBe("the image is empty");
    }
  });

  it("names any other status the server explains", () => {
    expect(searchErrorText({ kind: "status", status: 500, detail: "Internal Server Error" }).message).toContain("500");
  });

  it("reads a 5xx without the server's { error } as the server not reachable, like a network failure", () => {
    const unreachable = searchErrorText({ kind: "network" });
    expect(searchErrorText({ kind: "status", status: 502, detail: null })).toEqual(unreachable);
    expect(searchErrorText({ kind: "status", status: 500, detail: null })).toEqual(unreachable);
    expect(searchErrorText({ kind: "status", status: 404, detail: null }).message).not.toBe(unreachable.message);
  });

  it("shows a manager no hint meant for whoever runs the server, nor a model the screen does not offer", () => {
    expect(searchErrorText({ kind: "network" }).detail).toBeNull();
    expect(searchErrorText({ kind: "status", status: 503, detail: null }).detail).toBeNull();
    expect(searchErrorText({ kind: "status", status: 503, detail: "x" }).message).not.toMatch(/іншу модель/);
  });
});

describe("parse notes", () => {
  it("explains each reason the parse is unavailable, and shows a reason it does not know as it is", () => {
    for (const reason of ["not-configured", "budget-spent", "timed-out", "rejected", "provider-failed", "refused",
      "bad-answer"]) {
      expect(text.parse.unavailable(reason)).not.toContain(reason);
    }
    expect(text.parse.unavailable("overloaded")).toContain("overloaded");
  });
});

describe("prices", () => {
  it("shows a single price or a span in the supplier's currency", () => {
    expect(plain(priceSpanText({ currency: "PLN", min: 1.5, max: 1.5 }))).toBe("1,50 PLN");
    expect(plain(priceSpanText({ currency: "EUR", min: 0.125, max: 1234.5 }))).toBe("від 0,125 до 1 234,50 EUR");
    expect(plain(priceText({ amount: "12.3400", currency: "PLN" }))).toBe("12,34 PLN");
    expect(priceText({ amount: "n/a", currency: "PLN" })).toBe("n/a PLN");
  });

  it("reads the price the query names", () => {
    expect(plain(suggestedPriceText({ min: null, max: 100, currency: "UAH" }))).toBe("ціна до 100,00 UAH");
    expect(plain(suggestedPriceText({ min: 50, max: null, currency: null }))).toBe("ціна від 50,00");
    expect(plain(suggestedPriceText({ min: 50, max: 80, currency: "EUR" }))).toBe("ціна від 50,00 до 80,00 EUR");
  });
});

describe("results summary", () => {
  it("agrees the count with its noun", () => {
    expect(plain(text.results.summary(1, 1250, "m", 0))).toBe("1 модель за 1,3 с, m, без оплати.");
    expect(plain(text.results.summary(3, 900, "m", 0))).toBe("3 моделі за 0,9 с, m, без оплати.");
    expect(plain(text.results.summary(24, 400, "m", 0))).toBe("24 моделі за 0,4 с, m, без оплати.");
    expect(plain(text.results.summary(25, 400, "m", 0))).toBe("25 моделей за 0,4 с, m, без оплати.");
    expect(plain(text.results.summary(11, 400, "m", 0))).toBe("11 моделей за 0,4 с, m, без оплати.");
    expect(plain(text.results.summary(21, 400, "m", 0))).toBe("21 модель за 0,4 с, m, без оплати.");
    expect(plain(text.results.summary(0, 400, "m", 0))).toBe("0 моделей за 0,4 с, m, без оплати.");
  });

  it("gives what a search cost, down to what four places can show", () => {
    expect(plain(text.results.summary(24, 400, "m", 0.000_85))).toBe("24 моделі за 0,4 с, m, $0,0009 за прайсом.");
    expect(plain(text.results.summary(24, 400, "m", 0.0123))).toBe("24 моделі за 0,4 с, m, $0,0123 за прайсом.");
    expect(plain(text.results.summary(24, 400, "m", 0.000_02))).toBe("24 моделі за 0,4 с, m, менше $0,0001 за прайсом.");
  });

  it("gives the confidence as a percent and a word", () => {
    expect(text.results.confidence(85, "high")).toBe("Впевненість 85%, висока");
    expect(text.results.confidence(60, "medium")).toBe("Впевненість 60%, середня");
    expect(text.results.confidence(5, "low")).toBe("Впевненість 5%, низька");
  });

  it("names each condition with one of the three words", () => {
    expect(text.results.condition("volumeMl", "fits")).toBe("Об'єм: підходить");
    expect(text.results.condition("materials", "unknown")).toBe("Матеріал: не перевірено");
    expect(text.results.condition("sizeCm", "against")).toBe("Розмір: не підходить");
    expect(text.results.condition("printTechniques", "unknown")).toBe("Друк: не перевірено");
    expect(text.results.condition("sheets", "fits")).toBe("Аркуші: підходить");
    expect(text.results.condition("gsm", "against")).toBe("Щільність: не підходить");
  });

  it("says when the stock is short of some variants", () => {
    expect(plain(text.results.stock(15, true))).toBe("Залишок: 15 шт., не для всіх варіантів");
    expect(plain(text.results.stock(1500, false))).toBe("Залишок: 1 500 шт.");
  });

  it("says a code several suppliers have, and nothing more of a code one has", () => {
    expect(text.results.matchedCode("5246", null, 2)).toBe("Збіг за артикулом 5246, код є в 2 постачальників");
    expect(text.results.matchedCode("V2233-03", "black", 1)).toBe("Збіг за артикулом V2233-03, колір black");
  });
});

describe("the filters' words", () => {
  it("names the suppliers the minimum stock filter leaves out", () => {
    expect(text.filters.minStockNoData(["Easy Gifts", "Macma"]))
      .toBe("Без даних про залишок: Easy Gifts, Macma. З цим фільтром їхніх товарів не буде.");
  });
});

describe("ownProductErrorText", () => {
  it("explains a taken name in its own words and keeps the server's detail apart", () => {
    expect(ownProductErrorText({ kind: "status", status: 409, detail: "another own product has this name or code" })).toEqual({
      message: "Свій товар з такою назвою чи артикулом уже є.", detail: "another own product has this name or code",
    });
    expect(ownProductErrorText({ kind: "status", status: 404, detail: "x" }).message).toBe("Не знайшов цей товар чи модель.");
    expect(ownProductErrorText({ kind: "status", status: 418, detail: null }).message).toContain("418");
  });

  it("does not speak of the search's photo, filters or budget", () => {
    for (const status of [400, 403, 404, 429]) {
      expect(ownProductErrorText({ kind: "status", status, detail: null }).message).not.toMatch(/фото|фільтр|ліміт|Пошук/i);
    }
  });

  it("reads a server that does not answer the same as the search does", () => {
    expect(ownProductErrorText({ kind: "network" })).toEqual(searchErrorText({ kind: "network" }));
    expect(ownProductErrorText({ kind: "status", status: 502, detail: null }))
      .toEqual(searchErrorText({ kind: "network" }));
  });
});

describe("signInErrorText", () => {
  it("reads a wrong login, a wrong password and a value past the bound the same", () => {
    const wrong = { message: "Неправильний логін чи пароль.", detail: null };
    expect(signInErrorText({ kind: "status", status: 401, detail: "wrong login or password" })).toEqual(wrong);
    expect(signInErrorText({ kind: "status", status: 400, detail: "body/password too long" })).toEqual(wrong);
  });

  it("rounds the wait up to minutes", () => {
    expect(signInErrorText({ kind: "limited", retryAfterSeconds: 61 }).message).toBe("Забагато спроб. Спробуйте за 2 хв.");
    expect(signInErrorText({ kind: "limited", retryAfterSeconds: 900 }).message).toBe("Забагато спроб. Спробуйте за 15 хв.");
  });

  it("reads a server that does not answer the same as the search does", () => {
    expect(signInErrorText({ kind: "network" })).toEqual(searchErrorText({ kind: "network" }));
  });
});

describe("the limit of searches", () => {
  it("says how long to wait, and tells it from the daily budget", () => {
    expect(searchErrorText({ kind: "limited", retryAfterSeconds: 40 }).message).toBe("Забагато пошуків за хвилину. Спробуйте за 40 с.");
    expect(searchErrorText({ kind: "status", status: 429, detail: null }).message).toContain("Денний ліміт");
  });
});

describe("the own products' words", () => {
  const product = { id: 1, name: "Кружка", code: null };

  it("names an own product with its code and how the model is linked to it already", () => {
    expect(text.own.option(product, undefined)).toBe("Кружка");
    expect(text.own.option({ ...product, code: "K-1" }, undefined)).toBe("Кружка (K-1)");
    expect(text.own.option({ ...product, code: "K-1" }, "analog")).toBe("Кружка (K-1), уже: аналог");
    expect(text.own.option(product, "same")).toBe("Кружка, уже: той самий");
  });

  it("marks a card with the type and the product", () => {
    expect(text.own.linked("same", "Кружка")).toBe("Той самий: Кружка");
    expect(text.own.linked("analog", "Кружка")).toBe("Аналог: Кружка");
  });

  it("names each card's link button by its model, keeping the button's own words", () => {
    expect(text.own.linkModel("Mug")).toBe(`${text.own.linkOpen}: Mug`);
  });

  it("counts the own products on the tab once they are read", () => {
    expect(text.tabs.own(null)).toBe("Свої товари");
    expect(text.tabs.own(3)).toBe("Свої товари (3)");
  });
});
