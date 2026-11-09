// The XML feeds of Anda Present (docs/integrations.md, «Anda Present XML»): a root element of records, nested elements
// without attributes, the five XML entities, CDATA in products (certificate links), no comments, DTD or namespaces
// (every feed of 2026-11-09). The repo has no XML parser and this shape needs none. Each record is handed to a mapper as
// soon as it closes, so the tree of a 33 MB feed never lives whole in memory. Entities are decoded here: the feeds escape
// markup in descriptions ("&lt;br&gt;"), which cleanText (../normalize.ts) then removes as a tag. Pure.
import { FeedError } from "../errors.js";

export interface XmlNode {
  name: string;
  // The element's own text and CDATA, entities decoded. An element of elements keeps the whitespace between them here;
  // the readers take text only from elements without children.
  text: string;
  children: XmlNode[];
}

export interface FeedShape {
  root: string;
  record: string;
}

const DECLARATION = /^\uFEFF?\s*<\?xml[^?]*\?>/;
const NAME = "[A-Za-z_][\\w.-]*";
// A CDATA section, an end tag, a start or empty tag without attributes, or text. Built anew for each file: a sticky
// regex keeps its position between calls.
const TOKEN_SOURCE = `<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|</(${NAME})\\s*>|<(${NAME})\\s*(/?)>|([^<]+)`;
const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;
// A lone surrogate is no character: Postgres refuses it in text and jsonb, which would fail the whole write
const SURROGATES = { first: 0xd800, last: 0xdfff };
const HEX_RADIX = 16;
// The deepest record of 2026-11-09 is 5 levels (labeling: positions, technologies); far deeper is another shape
const MAX_DEPTH = 32;
// Shown with an error, to find the place in the file
const CONTEXT_CHARS = 40;

function isCharacter(value: number): boolean {
  return value > 0 && value <= MAX_CODE_POINT && (value < SURROGATES.first || value > SURROGATES.last);
}

function decodeXmlEntities(text: string): string {
  return text.replace(ENTITY, (entity, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? entity;
    const value = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), HEX_RADIX) : Number(name.slice(1));
    return isCharacter(value) ? String.fromCodePoint(value) : entity;
  });
}

function shapeError(feed: string, xml: string, index: number, what: string): FeedError {
  return new FeedError(`${feed}: ${what} at character ${index} ("${xml.slice(index, index + CONTEXT_CHARS)}")`);
}

// Every record of the feed, mapped as it closes. A file without its closing root tag was cut on the way, and one without
// records is no catalogue: either stops the import, which would otherwise mark the rest inactive. Elements beside the
// records (printingprices' currency) are checked for shape and skipped.
export function parseRecords<T>(xml: string, feed: string, shape: FeedShape, map: (node: XmlNode) => T): T[] {
  const body = xml.replace(DECLARATION, "");
  if (!new RegExp(`</${shape.root}\\s*>\\s*$`).test(body)) throw new FeedError(`${feed}: the file does not end with </${shape.root}>, it was cut`);
  const token = new RegExp(TOKEN_SOURCE, "y");
  const records: T[] = [];
  // Every open element by name; the nodes only of those inside a record
  const open: string[] = [];
  const nodes: XmlNode[] = [];
  while (token.lastIndex < body.length) {
    const index = token.lastIndex;
    const match = token.exec(body);
    if (!match) throw shapeError(feed, body, index, "markup this reader does not know");
    const [, cdata, endName, startName, selfClosing, text] = match;
    const node = nodes.at(-1);
    if (text !== undefined || cdata !== undefined) {
      if (node) node.text += cdata ?? decodeXmlEntities(text ?? "");
      // Text of a skipped element is skipped with it; between the records or outside the root it means another shape
      else if (open.length <= 1 && (cdata !== undefined || (text ?? "").trim())) throw shapeError(feed, body, index, "text outside a record");
      continue;
    }
    const name = startName ?? endName ?? "";
    if (startName !== undefined) {
      if (!open.length && startName !== shape.root) throw shapeError(feed, body, index, `root <${startName}>, not <${shape.root}>`);
      if (open.length >= MAX_DEPTH) throw shapeError(feed, body, index, `elements nested over ${MAX_DEPTH} deep`);
      if (node || (open.length === 1 && startName === shape.record)) {
        const opened: XmlNode = { name: startName, text: "", children: [] };
        node?.children.push(opened);
        nodes.push(opened);
      }
      open.push(startName);
      if (!selfClosing) continue;
    } else if (open.at(-1) !== name) {
      throw shapeError(feed, body, index, `</${name}> closes <${open.at(-1) ?? "nothing"}>`);
    }
    open.pop();
    // Inside a record the nodes stand one level below the open elements (the root has no node), so an element that
    // closes is a node exactly when the two are now level
    const closing = nodes.at(-1);
    if (closing && nodes.length === open.length) {
      nodes.pop();
      if (!nodes.length) records.push(map(closing));
    }
  }
  if (open.length) throw new FeedError(`${feed}: ${open.length} elements left open`);
  if (!records.length) throw new FeedError(`${feed}: no <${shape.record}> records`);
  return records;
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((each) => each.name === name);
}

// The text of the first child of that name; "" when there is none
export function textOf(node: XmlNode, name: string): string {
  return child(node, name)?.text ?? "";
}

// The items of a list element: <images><image>...</image></images>
export function listOf(node: XmlNode, wrapper: string, item: string): XmlNode[] {
  return child(node, wrapper)?.children.filter((each) => each.name === item) ?? [];
}

// The record as JSON for raw_record: an element of text is its text, a repeated name becomes an array, an empty
// element "". Collected in a Map, so a feed's element named __proto__ or constructor is a key like any other.
export function plainOf(node: XmlNode): unknown {
  if (!node.children.length) return node.text;
  const result = new Map<string, unknown>();
  for (const each of node.children) {
    const value = plainOf(each);
    const existing = result.get(each.name);
    // plainOf never returns an array, so an array here is a name met before
    if (existing === undefined) result.set(each.name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else result.set(each.name, [existing, value]);
  }
  return Object.fromEntries(result);
}
