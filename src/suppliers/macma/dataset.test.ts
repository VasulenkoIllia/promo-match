import { describe, expect, it } from "vitest";
import { FeedError } from "../errors.js";
import { parseDataSet, repairDoubleEncoding } from "./dataset.js";

const SCHEMA = `<xs:schema id="NewDataSet" xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="macma">
  <xs:complexType><xs:sequence><xs:element name="ARTIKELNR" type="xs:string" minOccurs="0" /></xs:sequence></xs:complexType>
</xs:element></xs:schema>`;

function file(records: string): string {
  return `<?xml version="1.0" standalone="yes"?>\n<NewDataSet>\n  ${SCHEMA}\n${records}\n</NewDataSet>\n`;
}

describe("repairDoubleEncoding", () => {
  it("turns UTF-8 read as Latin-1 back into its letters and leaves real accents alone", () => {
    expect(repairDoubleEncoding("Ã¸ 0,7 x 19,1 cm")).toBe("ø 0,7 x 19,1 cm");
    expect(repairDoubleEncoding("PongÃ©, PlÃ¼sch")).toBe("Pongé, Plüsch");
    expect(repairDoubleEncoding("1062006Â Â ")).toBe("1062006  ");
    // Romanian and French text of the feed: â before a letter is no byte pair
    expect(repairDoubleEncoding("Creion cu radieră, câștig, pâte")).toBe("Creion cu radieră, câștig, pâte");
    expect(repairDoubleEncoding("Größe ø 5 cm")).toBe("Größe ø 5 cm");
  });
});

describe("parseDataSet", () => {
  it("reads the flat records after the schema, empty fields as empty text", () => {
    const xml = file(`  <macma>
    <ARTIKELNR>1039307</ARTIKELNR>
    <SPARTE>TOOLS &amp; MORE</SPARTE>
    <BILD3D />
    <GROESSE>Ã¸ 0,7 x 19,1 cm</GROESSE>
    <DESC_NL xml:space="preserve"> </DESC_NL>
  </macma>
  <macma>
    <ARTIKELNR>1039309</ARTIKELNR>
  </macma>`);
    const dataSet = parseDataSet(xml, "macma");
    expect(dataSet.records).toEqual([
      { ARTIKELNR: "1039307", SPARTE: "TOOLS &amp; MORE", BILD3D: "", GROESSE: "ø 0,7 x 19,1 cm", DESC_NL: " " },
      { ARTIKELNR: "1039309" },
    ]);
    expect(dataSet.repairedValues).toBe(1);
    expect(dataSet.unreadRecords).toBe(0);
  });

  it("counts a record with something that is not a flat field", () => {
    const dataSet = parseDataSet(file("<macma><ARTIKELNR>1</ARTIKELNR><PRICES><P>1</P></PRICES></macma>"), "macma");
    expect(dataSet.unreadRecords).toBe(1);
  });

  it("stops on a file cut on the way and on a file without records", () => {
    expect(() => parseDataSet(file("<macma><ARTIKELNR>1</ARTIKELNR></macma>").slice(0, -20), "macma")).toThrow(FeedError);
    expect(() => parseDataSet(file("<easy><ARTIKELNR>1</ARTIKELNR></easy>"), "macma")).toThrow(FeedError);
  });
});
