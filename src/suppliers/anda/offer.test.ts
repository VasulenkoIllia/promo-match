import { describe, expect, it } from "vitest";
import { Checks } from "../checks.js";
import { andaPrices, andaStock } from "./offer.js";
import type { PriceRecord, StockRecord } from "./records.js";

// Shaped like the prices and inventories feeds of 2026-11-09; amounts made up
const price = (type: string, amount: string, currency = "EUR"): PriceRecord =>
  ({ itemNumber: "AP100001-10", currency, amount, type, raw: {} });
const stock = (type: string, amount: string, arrivalDate = "", moreThanAmount = "0"): StockRecord =>
  ({ itemNumber: "AP100001-10", type, amount, moreThanAmount, arrivalDate, raw: {} });

describe("andaPrices", () => {
  it("takes discountPrice as the primary net price and listPrice as the catalogue price beside it", () => {
    const checks = new Checks();
    expect(andaPrices([price("listPrice", "2.50"), price("discountPrice", "1.25")], checks)).toEqual([
      { kind: "catalog", currency: "EUR", minQuantity: 1, amount: "2.50", isPrimary: false, validUntil: null },
      { kind: "net", currency: "EUR", minQuantity: 1, amount: "1.25", isPrimary: true, validUntil: null },
    ]);
    expect(checks.counts).toEqual({});
  });

  it("counts what it leaves out: another type, a repeat, no currency, a zero price", () => {
    const checks = new Checks();
    const prices = andaPrices([
      price("discountPrice", "1.25"), price("discountPrice", "1.10"), price("salePrice", "0.90"), price("listPrice", "2.50", ""),
      price("constructor", "0.80"),
    ], checks);
    expect(prices).toEqual([expect.objectContaining({ kind: "net", amount: "1.25" })]);
    expect(checks.counts).toEqual({
      "price records with a repeated type": 1, "price records of an unknown type": 2, "prices without an ISO currency": 1,
    });
    expect(andaPrices([price("discountPrice", "0")], checks)).toEqual([]);
  });

  it("gives no price to a variant without records, as the textile sizes", () => {
    expect(andaPrices([], new Checks())).toEqual([]);
  });
});

describe("andaStock", () => {
  it("counts central_stock alone as in stock, the dated arrivals earliest first, production as on order", () => {
    const checks = new Checks();
    const { stock: result, external } = andaStock([
      stock("incoming_to_central_stock", "500", "2027-03-01"), stock("central_stock", "1 200"),
      stock("incoming_to_central_stock", "300", "2026-12-10"), stock("in_production", "40"),
      stock("external_1_2_days", "70"), stock("external_9_12_days", "0"),
    ], "2026-11-09T16:25:00.000Z", checks);
    expect(result).toEqual({
      inStock: 1200, reserved: null, onOrder: 40, nextArrivalQuantity: 300, nextArrivalDate: "2026-12-10", leadTime: null,
      arrivals: [{ date: "2026-12-10", quantity: 300 }, { date: "2027-03-01", quantity: 500 }],
      sourceUpdatedAt: "2026-11-09T16:25:00.000Z",
    });
    expect(external).toEqual({ external_1_2_days: 70, external_9_12_days: 0 });
    expect(checks.counts).toEqual({});
  });

  it("keeps no stock row for a variant without records, as the made-to-order products", () => {
    expect(andaStock([], null, new Checks())).toEqual({ stock: null, external: {} });
  });

  it("counts an unknown type, a «more than» amount, a bad number and a missing central_stock", () => {
    const checks = new Checks();
    const { stock: result } = andaStock([
      stock("consignment", "5"), stock("incoming_to_central_stock", "x", "2027-01-01"),
      stock("external_1_2_days", "100", "", "1"), stock("incoming_to_central_stock", "10", "soon"), stock("in_production", " "),
    ], null, checks);
    expect(result).toBeNull();
    expect(checks.counts).toEqual({
      "stock records of an unknown type": 1, "unreadable stock quantities": 1, "stock quantities given as «more than»": 1,
      "unreadable arrival dates": 1, "stock records without an amount": 1, "stock without central_stock": 1,
    });
  });
});
