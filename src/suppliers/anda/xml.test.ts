import { describe, expect, it } from "vitest";
import { FeedError } from "../errors.js";
import { listOf, parseRecords, plainOf, textOf, type XmlNode } from "./xml.js";

const SHAPE = { root: "products", record: "product" };
const names = (node: XmlNode) => node.name;

function feed(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<products>${body}</products>\n`;
}

describe("parseRecords", () => {
  it("maps each record with its nested lists, empty elements, entities and CDATA", () => {
    const xml = feed(`<product><itemNumber>AP100001-06A</itemNumber><brandName/><name>pen &amp; pencil &#8211; set</name>`
      + `<descriptions>Text.&lt;br&gt;&lt;b&gt;Bold&lt;/b&gt;</descriptions>`
      + `<images><image>https://cdn.example/a.jpg</image><image>https://cdn.example/b.jpg</image></images>`
      + `<productCertificate><conformity><![CDATA[https://cdn.example/c.pdf?a=1&b=2]]></conformity></productCertificate>`
      + `</product>\n<product><itemNumber>AP100002</itemNumber><images/></product>`);
    const records = parseRecords(xml, "products", SHAPE, (node) => node);
    expect(records.map((node) => textOf(node, "itemNumber"))).toEqual(["AP100001-06A", "AP100002"]);
    const [first] = records;
    if (!first) throw new Error("no record");
    expect(textOf(first, "brandName")).toBe("");
    expect(textOf(first, "name")).toBe("pen & pencil – set");
    // Decoded here, so the shared cleaning removes the markup as tags
    expect(textOf(first, "descriptions")).toBe("Text.<br><b>Bold</b>");
    expect(listOf(first, "images", "image").map((node) => node.text)).toEqual(["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"]);
    // CDATA is text as it stands: no entity in it is decoded
    expect(listOf(first, "productCertificate", "conformity")[0]?.text).toBe("https://cdn.example/c.pdf?a=1&b=2");
    expect(records[1]?.children.map(names)).toEqual(["itemNumber", "images"]);
  });

  it("keeps an entity that names no character as it is, a lone surrogate included", () => {
    const [text] = parseRecords(feed("<product><a>&#xD800; &#0; &#65; &nbsp;</a></product>"), "products", SHAPE, (node) => textOf(node, "a"));
    expect(text).toBe("&#xD800; &#0; A &nbsp;");
  });

  it("reads an empty record element", () => {
    expect(parseRecords(feed("<product/><product><a>1</a></product>"), "products", SHAPE, (node) => node.children.length)).toEqual([0, 1]);
  });

  it("skips what sits beside the records", () => {
    const xml = `<priceList><currency>EUR</currency><prices><price><code>C1</code></price></prices></priceList>`;
    expect(parseRecords(xml, "printingprices", { root: "priceList", record: "prices" }, (node) => node.children.length)).toEqual([1]);
  });

  it("stops on a file that was cut, has no records or another root", () => {
    expect(() => parseRecords(`<products><product><a>1</a></product>`, "products", SHAPE, names)).toThrow(FeedError);
    expect(() => parseRecords(`<products><product><a>1</a></product>`, "products", SHAPE, names)).toThrow("it was cut");
    expect(() => parseRecords(feed(""), "products", SHAPE, names)).toThrow("no <product> records");
    expect(() => parseRecords(`<prices></prices><products></products>`, "products", SHAPE, names)).toThrow("root <prices>");
  });

  it("stops on markup it does not know rather than read it wrong", () => {
    expect(() => parseRecords(feed(`<product id="1"><a>1</a></product>`), "products", SHAPE, names))
      .toThrow("markup this reader does not know");
    expect(() => parseRecords(feed(`<product><a>1</b></product>`), "products", SHAPE, names)).toThrow("</b> closes <a>");
    expect(() => parseRecords(feed(`<product><a>1</a></product>loose`), "products", SHAPE, names)).toThrow("text outside a record");
    // Beside the records too: a skipped element is still checked for shape
    expect(() => parseRecords(feed(`<other><x>1</y></other><product><a>1</a></product>`), "products", SHAPE, names))
      .toThrow("</y> closes <x>");
    const deep = `${"<a>".repeat(40)}${"</a>".repeat(40)}`;
    expect(() => parseRecords(feed(`<product>${deep}</product>`), "products", SHAPE, names)).toThrow("nested over 32 deep");
  });
});

describe("plainOf", () => {
  it("gives the record as JSON, a repeated name as an array", () => {
    const [node] = parseRecords(feed(`<product><a>1</a><list><i>x</i><i>y</i><i>z</i></list><one><i>w</i></one><e/></product>`),
      "products", SHAPE, (each) => each);
    if (!node) throw new Error("no record");
    expect(plainOf(node)).toEqual({ a: "1", list: { i: ["x", "y", "z"] }, one: { i: "w" }, e: "" });
  });

  it("keeps an element named like an object's own property as a plain key", () => {
    const [node] = parseRecords(feed("<product><__proto__>1</__proto__><__proto__>2</__proto__><constructor>3</constructor></product>"),
      "products", SHAPE, (each) => each);
    if (!node) throw new Error("no record");
    const plain = plainOf(node) as Record<string, unknown>;
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.entries(plain)).toEqual([["__proto__", ["1", "2"]], ["constructor", "3"]]);
  });
});
