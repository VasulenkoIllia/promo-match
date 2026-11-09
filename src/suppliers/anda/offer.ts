// Prices and stock of an Anda Present variant (docs/integrations.md, «Anda Present XML»). Owner's decisions 2026-11-09:
// discountPrice (with the client's discount) is the primary net price and listPrice the catalogue price beside it, both
// from quantity 1 (the feed has no scale); in stock is central_stock alone, the arrivals to it are dated, in_production
// is what is being made, and the external warehouses (1-2 and 9-12 days) are kept apart in the variant's attributes. A
// variant without a record keeps no price or no stock row: the textile sizes have no price, the made-to-order products no
// stock. Pure.
import type { Checks } from "../checks.js";
import { cleanText, isBlank, parseDate, parseInteger } from "../normalize.js";
import type { ArrivalInput, PriceInput, PriceKind, StockInput } from "../types.js";
import type { PriceRecord, StockRecord } from "./records.js";

// A Map, so a type the feed names "constructor" is unknown, not an inherited property
const PRICE_KINDS = new Map<string, PriceKind>([["discountPrice", "net"], ["listPrice", "catalog"]]);
const CURRENCY_CODE = /^[A-Z]{3}$/;
const CENTRAL = "central_stock";
const INCOMING = "incoming_to_central_stock";
const IN_PRODUCTION = "in_production";
const EXTERNAL = /^external_/;
const MORE_THAN = "1";

export function andaPrices(records: PriceRecord[], checks: Checks): PriceInput[] {
  const prices: PriceInput[] = [];
  for (const record of records) {
    const kind = PRICE_KINDS.get(record.type);
    if (!kind) {
      checks.add("price records of an unknown type", `${record.itemNumber} ${record.type}`);
      continue;
    }
    if (prices.some((price) => price.kind === kind)) {
      checks.add("price records with a repeated type", record.itemNumber);
      continue;
    }
    const currency = cleanText(record.currency);
    if (!currency || !CURRENCY_CODE.test(currency)) {
      checks.add("prices without an ISO currency", record.itemNumber);
      continue;
    }
    const amount = checks.amount("prices", record.amount, record.itemNumber);
    if (amount === null) continue;
    prices.push({ kind, currency, minQuantity: 1, amount, isPrimary: kind === "net", validUntil: null });
  }
  return prices;
}

interface AndaStock {
  stock: StockInput | null;
  // Pieces in the external warehouses by the feed's type: { external_1_2_days: 3437 }
  external: Record<string, number>;
}

function amountOf(record: StockRecord, checks: Checks): number | null {
  if (isBlank(record.amount)) {
    checks.add("stock records without an amount", record.itemNumber);
    return null;
  }
  const amount = checks.read("stock quantities", record.amount, parseInteger, record.itemNumber);
  if (amount !== null && amount < 0) {
    checks.add("negative stock quantities", record.itemNumber);
    return null;
  }
  if (cleanText(record.moreThanAmount) === MORE_THAN) checks.add("stock quantities given as «more than»", record.itemNumber);
  return amount;
}

function sum(left: number | null, right: number): number {
  return (left ?? 0) + right;
}

// sourceUpdatedAt: the last-modified of the inventories feed, the only time it gives
export function andaStock(records: StockRecord[], sourceUpdatedAt: string | null, checks: Checks): AndaStock {
  let inStock: number | null = null;
  let onOrder: number | null = null;
  const arrivals: ArrivalInput[] = [];
  const external: Record<string, number> = {};
  for (const record of records) {
    const amount = amountOf(record, checks);
    if (amount === null) continue;
    if (record.type === CENTRAL) {
      if (inStock !== null) checks.add("stock records with a repeated central_stock", record.itemNumber);
      inStock = sum(inStock, amount);
    } else if (record.type === INCOMING) {
      arrivals.push({ date: checks.read("arrival dates", record.arrivalDate, parseDate, record.itemNumber), quantity: amount });
    } else if (record.type === IN_PRODUCTION) {
      onOrder = sum(onOrder, amount);
    } else if (EXTERNAL.test(record.type)) {
      external[record.type] = sum(external[record.type] ?? null, amount);
    } else {
      checks.add("stock records of an unknown type", `${record.itemNumber} ${record.type}`);
    }
  }
  if (records.length && inStock === null) checks.add("stock without central_stock", records[0]?.itemNumber);
  // Undated arrivals last
  arrivals.sort((left, right) => (left.date ?? "9999").localeCompare(right.date ?? "9999"));
  const stock: StockInput | null = inStock === null ? null : {
    inStock, reserved: null, onOrder, nextArrivalQuantity: arrivals[0]?.quantity ?? null,
    nextArrivalDate: arrivals[0]?.date ?? null, leadTime: null, arrivals, sourceUpdatedAt,
  };
  return { stock, external };
}
