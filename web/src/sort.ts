// The order of the results on screen (owner's decision 2026-11-23, managers' test item 5): the models shown, the 12, 24
// or 48 most similar, by price, stock or a colour first. Ties and models with no such data keep the search's order, a
// model with no price or stock goes last, and nothing is asked of the server. Pure.
import type { SearchResult } from "./api";
import { variantSummary } from "./format";

// The orders besides a colour first, in the picker's order
export const PLAIN_ORDERS = ["relevance", "price-asc", "price-desc", "stock-desc"] as const;

export type ResultOrder = (typeof PLAIN_ORDERS)[number] | `color-${string}`;

export const DEFAULT_ORDER: ResultOrder = "relevance";

// The currency most suppliers price in; a price in another one is not comparable and goes after it
const MAIN_CURRENCY = "EUR";
const COLOR_PREFIX = "color-";

interface Keyed {
  result: SearchResult;
  // The model's lowest price, as the card's «від» shows it, in the main currency when it has one
  price: { currency: string; amount: number } | null;
  stock: number | null;
}

function keyed(result: SearchResult): Keyed {
  const summary = variantSummary(result.variants);
  const span = summary.prices.find((each) => each.currency === MAIN_CURRENCY) ?? summary.prices[0];
  return { result, price: span ? { currency: span.currency, amount: span.min } : null, stock: summary.stock };
}

// A model without the data goes last, whichever the direction
function comparePrices(left: Keyed, right: Keyed, direction: 1 | -1): number {
  const [first, second] = [left.price, right.price];
  if (!first || !second) return Number(!first) - Number(!second);
  if (first.currency !== second.currency) {
    if (first.currency === MAIN_CURRENCY) return -1;
    if (second.currency === MAIN_CURRENCY) return 1;
    return first.currency.localeCompare(second.currency);
  }
  return direction * (first.amount - second.amount);
}

function compareStock(left: Keyed, right: Keyed): number {
  const [first, second] = [left.stock, right.stock];
  if (first === null || second === null) return Number(first === null) - Number(second === null);
  return second - first;
}

function hasColorGroup(result: SearchResult, group: string): boolean {
  return result.variants.some((variant) => variant.colorGroups.includes(group));
}

// The colour group an order puts first, or null for another order
export function orderColor(order: ResultOrder): string | null {
  return order.startsWith(COLOR_PREFIX) ? order.slice(COLOR_PREFIX.length) : null;
}

export function colorOrder(group: string): ResultOrder {
  return `${COLOR_PREFIX}${group}`;
}

// A picker's value as an order; anything else keeps the order shown
export function isResultOrder(value: string): value is ResultOrder {
  return (PLAIN_ORDERS as readonly string[]).includes(value) || (value.startsWith(COLOR_PREFIX) && value.length > COLOR_PREFIX.length);
}

// The results in the order asked; Array.prototype.sort is stable, so ties keep the order they came in
export function sortResults(results: SearchResult[], order: ResultOrder): SearchResult[] {
  const color = orderColor(order);
  if (color !== null) {
    return [...results].sort((left, right) => Number(hasColorGroup(right, color)) - Number(hasColorGroup(left, color)));
  }
  const compare = order === "price-asc" ? (left: Keyed, right: Keyed) => comparePrices(left, right, 1)
    : order === "price-desc" ? (left: Keyed, right: Keyed) => comparePrices(left, right, -1)
      : order === "stock-desc" ? compareStock : null;
  return compare ? results.map(keyed).sort(compare).map((entry) => entry.result) : results;
}
