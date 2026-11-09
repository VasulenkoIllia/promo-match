// What an Anda Present item number says past its model code (docs/integrations.md, «Anda Present XML»; every tail of
// the feed of 2026-11-09 reads by this rule). After rootItemNumber: "-06" a colour, "-06A" a shade of it (A darker,
// V lighter, T transparent, F fluorescent: primaryColorCode writes "01T" and "84A" the same way), "-01-07" two colours,
// "-A" a version without a colour (a ruler A to G); then "_L", "_16GB", "_36-38" a size. An assembled product
// (assemblyProduct 1) names its part last: "_B", or after a size "_36-38-B". Pure.

interface CodeTail {
  // "06A", or "01-07" for two colours
  colorCode: string | null;
  version: string | null;
  size: string | null;
  part: string | null;
}

const COLOR = String.raw`\d{2}[A-Z]?`;
const TAIL = new RegExp(String.raw`^(?:-(${COLOR}(?:-${COLOR})?)|-([A-Z]+))?(?:_([A-Z0-9]+(?:-[A-Z0-9]+)*))?$`);
const PART_ALONE = /^[A-Z]$/;
const PART_AFTER_SIZE = /^(.+)-([A-Z])$/;

// null: the item number is not its model's code with a tail this rule reads
export function splitItemNumber(itemNumber: string, rootItemNumber: string, isAssembly: boolean): CodeTail | null {
  if (!rootItemNumber || !itemNumber.startsWith(rootItemNumber)) return null;
  const match = TAIL.exec(itemNumber.slice(rootItemNumber.length));
  if (!match) return null;
  const [, colorCode = null, version = null, after = null] = match;
  if (after === null || !isAssembly) return { colorCode, version, size: after, part: null };
  if (PART_ALONE.test(after)) return { colorCode, version, size: null, part: after };
  const [, size = null, part = null] = PART_AFTER_SIZE.exec(after) ?? [null, after, null];
  return { colorCode, version, size, part };
}
