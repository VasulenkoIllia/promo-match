import { describe, expect, it } from "vitest";
import { andaPrintTechniques } from "./print-codes.js";

describe("andaPrintTechniques", () => {
  it("reads each family the labeling feed names, its size or colour class aside", () => {
    expect(andaPrintTechniques(["P0", "P3"])).toEqual(["pad"]);
    expect(andaPrintTechniques(["S1"])).toEqual(["screen"]);
    expect(andaPrintTechniques(["RS2"])).toEqual(["screen", "wrap"]);
    expect(andaPrintTechniques(["E0", "EX", "RE1"])).toEqual(["laser"]);
    expect(andaPrintTechniques(["ER1"])).toEqual(["laser", "wrap"]);
    expect(andaPrintTechniques(["EP1"])).toEqual(["laser", "wrap"]);
    expect(andaPrintTechniques(["UVA"])).toEqual(["digital"]);
    expect(andaPrintTechniques(["RUV"])).toEqual(["digital", "wrap"]);
    expect(andaPrintTechniques(["DTB", "TC"])).toEqual(["transfer"]);
    expect(andaPrintTechniques(["SU1", "SUM"])).toEqual(["sublimation"]);
    expect(andaPrintTechniques(["DG1", "DC2", "OP"])).toEqual(["digital"]);
    expect(andaPrintTechniques(["DO1", "DO+"])).toEqual(["doming"]);
    expect(andaPrintTechniques(["BR"])).toEqual(["embroidery"]);
    expect(andaPrintTechniques(["O1", "O2"])).toEqual(["embossing"]);
  });

  it("reads a printed name, a free print and hatband sewing as their technique", () => {
    expect(andaPrintTechniques(["NE1"])).toEqual(["laser"]);
    expect(andaPrintTechniques(["NER2"])).toEqual(["laser", "wrap"]);
    expect(andaPrintTechniques(["NDTC", "NUVF"])).toEqual(["digital", "transfer"]);
    expect(andaPrintTechniques(["NSU1", "NSUM", "NRUV"])).toEqual(["digital", "sublimation", "wrap"]);
    expect(andaPrintTechniques(["FP-E"])).toEqual(["laser"]);
    expect(andaPrintTechniques(["FP-SUR-HS", "FP-NSU"])).toEqual(["sublimation"]);
    expect(andaPrintTechniques(["FP-DG", "FP-NDG", "FP-UV"])).toEqual(["digital"]);
    expect(andaPrintTechniques(["FP-DO"])).toEqual(["doming"]);
    expect(andaPrintTechniques(["TA1-HS", "DTA1-HS"])).toEqual(["transfer"]);
  });

  it("leaves a technique off the shared list unconfirmed and packaging out", () => {
    expect(andaPrintTechniques(["C1", "WPC2", "VS", "VF", "FP-VS", "ZZ9"])).toEqual(["unconfirmed"]);
    expect(andaPrintTechniques(["CB1", "CBK5", "PB2", "PBK1", "PS4", "PSK3"])).toEqual([]);
    expect(andaPrintTechniques(["P1", "PS1"])).toEqual(["pad"]);
  });
});
