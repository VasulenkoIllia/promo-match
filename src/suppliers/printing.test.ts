import { describe, expect, it } from "vitest";
import { axpolPrintTechniques } from "./axpol/print-codes.js";
import { midoceanPrintTechniques } from "./midocean/print-names.js";

const axpol = (...codes: string[]) => axpolPrintTechniques([[{ techniques: codes }]]);
const dictionary = [
  ["P4", "Pad printing"], ["T1", "Screen transfer"], ["TC", "Ceramic transfer"], ["TD1", "Digital transfer"], ["TR", "Transfer reflective"],
  ["S3", "Screen printing"], ["S7", "Screenprint"], ["RS5", "Round screen printing"], ["L2", "Laser engraving"], ["RL", "Round laser"],
  ["RD1", "Round digital"], ["PD2", "Digital printing"], ["DL", "Digital label"], ["E", "Embroidery"], ["B", "Debossing"],
  ["DO1", "Doming"], ["TS3", "Sublimation"],
].map(([code, en]) => ({ code: code ?? "", name: { en: en ?? "" } }));
const midocean = (...codes: string[]) => midoceanPrintTechniques({ positions: [{ techniques: codes.map((code) => ({ code })) }] }, dictionary);

describe("axpolPrintTechniques", () => {
  it("reads each family of its marking pages, the letter after a number with it", () => {
    expect(axpol("T2", "T2A")).toEqual(["pad"]);
    expect(axpol("TF1", "TF3A", "DTF2")).toEqual(["transfer"]);
    expect(axpol("L0", "L2A", "L3P")).toEqual(["laser"]);
    expect(axpol("S0", "S1A")).toEqual(["screen"]);
    expect(axpol("SL")).toEqual(["sublimation"]);
    expect(axpol("TC1")).toEqual(["embossing"]);
    expect(axpol("D", "D1")).toEqual(["doming"]);
    expect(axpol("DDC1", "FC3")).toEqual(["digital"]);
  });

  it("says a print goes around where its pages say so", () => {
    expect(axpol("L4A")).toEqual(["laser", "wrap"]);
    expect(axpol("UV360-B")).toEqual(["digital", "wrap"]);
  });

  it("confirms no code its pages do not name", () => {
    expect(axpol("H1", "PL", "X9")).toEqual(["unconfirmed"]);
    expect(axpol("H2", "T1")).toEqual(["pad", "unconfirmed"]);
  });

  it("adds up the colours of a model, and says nothing with no print data", () => {
    expect(axpolPrintTechniques([[{ techniques: ["T1"] }], null, [{ techniques: ["L2A"] }]])).toEqual(["laser", "pad"]);
    expect(axpolPrintTechniques([null])).toEqual([]);
  });
});

describe("midoceanPrintTechniques", () => {
  it("reads a technique by the name its dictionary gives a code", () => {
    expect(midocean("P4")).toEqual(["pad"]);
    expect(midocean("S3", "S7")).toEqual(["screen"]);
    expect(midocean("L2")).toEqual(["laser"]);
    expect(midocean("E")).toEqual(["embroidery"]);
    expect(midocean("B")).toEqual(["embossing"]);
    expect(midocean("DO1")).toEqual(["doming"]);
    expect(midocean("TS3")).toEqual(["sublimation"]);
    expect(midocean("PD2")).toEqual(["digital"]);
  });

  it("takes a label for no print on the product, not for a code nothing explains", () => {
    expect(midocean("DL")).toEqual([]);
    expect(midocean("DL", "P4")).toEqual(["pad"]);
  });

  it("takes every transfer for a transfer, whatever else its name says", () => {
    expect(midocean("T1", "TC", "TD1", "TR")).toEqual(["transfer"]);
  });

  it("says a print goes around from a round name", () => {
    expect(midocean("RS5")).toEqual(["screen", "wrap"]);
    expect(midocean("RL")).toEqual(["laser", "wrap"]);
    expect(midocean("RD1")).toEqual(["digital", "wrap"]);
  });

  it("confirms no code the dictionary lacks, and says nothing with no print data", () => {
    expect(midocean("ZZ")).toEqual(["unconfirmed"]);
    expect(midoceanPrintTechniques(null, dictionary)).toEqual([]);
  });

  it("never reads another supplier's code: T1 is pad printing only at Axpol", () => {
    expect(axpol("T1")).toEqual(["pad"]);
    expect(midocean("T1")).toEqual(["transfer"]);
  });
});
