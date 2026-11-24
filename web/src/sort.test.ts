import { describe, expect, it } from "vitest";
import type { ResultVariant, SearchResult } from "./api";
import { colorOrder, isResultOrder, orderColor, sortResults } from "./sort";

function variant(overrides: Partial<ResultVariant>): ResultVariant {
  return { sku: "S1", color: null, colorGroups: [], size: null, inStock: null, nextArrival: null, price: null, offer: null, ...overrides };
}

const price = (amount: string, currency = "EUR") => ({ amount, currency, minQuantity: 1 });

// Only what the order reads: a model by its rank and variants
function result(rank: number, variants: ResultVariant[]): SearchResult {
  return { rank, modelId: rank, variants } as unknown as SearchResult;
}

const ranks = (results: SearchResult[]) => results.map((each) => each.rank);

describe("sortResults", () => {
  const cheap = result(3, [variant({ price: price("0.5000") }), variant({ price: price("4.0000") })]);
  const dear = result(1, [variant({ price: price("2.0000") })]);
  const middle = result(2, [variant({ price: price("1.0000") })]);
  const unpriced = result(4, [variant({})]);
  const zloty = result(5, [variant({ price: price("0.1000", "PLN") })]);

  it("keeps the search's order by similarity", () => {
    const shown = [dear, middle, cheap];
    expect(sortResults(shown, "relevance")).toBe(shown);
  });

  it("orders by the model's lowest price, a model without one last either way", () => {
    expect(ranks(sortResults([unpriced, dear, middle, cheap], "price-asc"))).toEqual([3, 2, 1, 4]);
    expect(ranks(sortResults([unpriced, dear, middle, cheap], "price-desc"))).toEqual([1, 2, 3, 4]);
  });

  it("puts a price in another currency after the euro ones, not among them", () => {
    expect(ranks(sortResults([zloty, dear, cheap], "price-asc"))).toEqual([3, 1, 5]);
    expect(ranks(sortResults([zloty, dear, cheap], "price-desc"))).toEqual([1, 3, 5]);
  });

  it("reads a model priced in two currencies by its euro price", () => {
    const both = result(6, [variant({ price: price("0.0100", "PLN") }), variant({ price: price("3.0000") })]);
    expect(ranks(sortResults([both, dear], "price-asc"))).toEqual([1, 6]);
  });

  it("orders by the summed stock, most first, an unknown stock last, ties as they came", () => {
    const many = result(2, [variant({ inStock: 100 }), variant({ inStock: 50 })]);
    const few = result(1, [variant({ inStock: 10 }), variant({ inStock: null })]);
    const unknown = result(3, [variant({})]);
    const same = result(4, [variant({ inStock: 10 })]);
    expect(ranks(sortResults([unknown, few, many, same], "stock-desc"))).toEqual([2, 1, 4, 3]);
  });

  it("puts the models with a variant of the colour first, each part in the search's order", () => {
    const blue = (rank: number) => result(rank, [variant({ colorGroups: ["red"] }), variant({ colorGroups: ["blue", "white"] })]);
    const red = (rank: number) => result(rank, [variant({ colorGroups: ["red"] })]);
    expect(ranks(sortResults([red(1), blue(2), red(3), blue(4)], colorOrder("blue")))).toEqual([2, 4, 1, 3]);
  });

  it("leaves the list it was given as it is", () => {
    const shown = [dear, cheap];
    sortResults(shown, "price-asc");
    sortResults(shown, colorOrder("red"));
    expect(ranks(shown)).toEqual([1, 3]);
  });
});

describe("orderColor", () => {
  it("reads the colour back from a colour order and nothing from the others", () => {
    expect(orderColor(colorOrder("gold"))).toBe("gold");
    expect(orderColor("price-asc")).toBeNull();
  });
});

describe("isResultOrder", () => {
  it("takes the picker's orders and a named colour, nothing else", () => {
    expect(["relevance", "price-asc", "stock-desc", "color-blue"].every(isResultOrder)).toBe(true);
    expect(["color-", "name-asc", ""].some(isResultOrder)).toBe(false);
  });
});
