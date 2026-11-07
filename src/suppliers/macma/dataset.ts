// The .NET DataSet XML of Macma and Easy Gifts (docs/integrations.md, «Macma і Easy Gifts»): <NewDataSet>, an inline
// xs:schema, then flat records <macma> or <easy> of <FIELD>text</FIELD> and <FIELD />, a few with xml:space="preserve";
// no nesting, no CDATA (2026-11-05). The repo has no XML parser and this shape needs none. Values stay as the file escapes them:
// cleanText (../normalize.ts) decodes the entities with the rest. Pure.
import { FeedError } from "../errors.js";

const SCHEMA = /<xs:schema\b[\s\S]*?<\/xs:schema>/;
const ROOT_END = /<\/NewDataSet>\s*$/;
const RECORD_TAG = /^[A-Za-z_]\w*$/;
const FIELD = /<([A-Za-z_][\w.-]*)(?:\s+[\w:.-]+="[^"]*")*\s*(?:\/>|>([^<]*)<\/\1\s*>)/g;
// UTF-8 read as Latin-1 and written again: "Ã¸" is ø, "Â " a no-break space (GROESSE, MATERIAL, UPSELLING on
// 2026-11-05). Two or three such characters are one when their bytes are valid UTF-8; anything else stays as it is.
const DOUBLE_ENCODED = /[\u00c2-\u00df][\u0080-\u00bf]|[\u00e0-\u00ef][\u0080-\u00bf]{2}/g;
const REPLACEMENT = "\ufffd";

export type DataSetRecord = Record<string, string>;

export interface DataSet {
  records: DataSetRecord[];
  // Records with something between their fields that is not a field (an element of another shape, text)
  unreadRecords: number;
  // Values whose double-encoded characters were repaired
  repairedValues: number;
}

export function repairDoubleEncoding(text: string): string {
  return text.replace(DOUBLE_ENCODED, (sequence) => {
    const decoded = Buffer.from(sequence, "latin1").toString("utf8");
    return [...decoded].length === 1 && decoded !== REPLACEMENT ? decoded : sequence;
  });
}

// Every record of the file. A file without its closing tag was cut on the way: it stops the import, which would
// otherwise mark the rest of the catalogue inactive.
export function parseDataSet(xml: string, recordTag: string): DataSet {
  if (!RECORD_TAG.test(recordTag)) throw new FeedError(`${recordTag} is not a record tag`);
  if (!ROOT_END.test(xml)) throw new FeedError(`${recordTag}: the file does not end with </NewDataSet>, it was cut`);
  const body = xml.replace(SCHEMA, "");
  const records: DataSetRecord[] = [];
  let unreadRecords = 0;
  let repairedValues = 0;
  for (const [, content = ""] of body.matchAll(new RegExp(`<${recordTag}>([\\s\\S]*?)</${recordTag}>`, "g"))) {
    const record: DataSetRecord = {};
    for (const [, name = "", raw = ""] of content.matchAll(FIELD)) {
      const value = repairDoubleEncoding(raw);
      if (value !== raw) repairedValues += 1;
      record[name] = value;
    }
    if (content.replace(FIELD, "").trim()) unreadRecords += 1;
    records.push(record);
  }
  if (!records.length) throw new FeedError(`${recordTag}: no records`);
  return { records, unreadRecords, repairedValues };
}
