// The import's console report: counts only, never prices
import type { CatalogSnapshot } from "../suppliers/types.js";
import type { ImportPlan, Totals } from "./plan.js";
import type { Deactivated, WrittenCounts } from "./write.js";

const NAME_WIDTH = 11;
const COUNT_WIDTH = 9;

function cell(value: string | number, width = COUNT_WIDTH): string {
  return String(value).padStart(width);
}

export function snapshotLines(code: string, snapshot: CatalogSnapshot): string[] {
  const variants = snapshot.models.reduce((sum, model) => sum + model.variants.length, 0);
  const photos = snapshot.models.reduce((sum, model) => sum + model.photos.length, 0);
  const lines = [
    `${code}: read ${Object.entries(snapshot.fetched).map(([feed, count]) => `${feed} ${count}`).join(", ")}`,
    `${code}: normalized ${snapshot.models.length} models, ${variants} variants, ${photos} photos,`
      + ` ${snapshot.techniques.length} print techniques; complete: ${snapshot.isComplete ? "yes" : "NO"}`,
  ];
  for (const [name, count] of Object.entries(snapshot.checks)) {
    const examples = snapshot.examples[name]?.length ? ` (e.g. ${snapshot.examples[name].join(", ")})` : "";
    lines.push(`${code}: check: ${name}: ${count}${examples}`);
  }
  for (const warning of snapshot.warnings) lines.push(`${code}: WARNING ${warning}`);
  return lines;
}

export function planLines(code: string, plan: ImportPlan): string[] {
  const header = ["incoming", "new", "changed", "same", "back", "missing"].map((name) => cell(name)).join("");
  const lines = [`${code}: plan       ${header}`];
  for (const [entity, row] of Object.entries(plan)) {
    const counts = [row.incoming, row.created, row.changed, row.unchanged, row.reactivated, row.missing];
    lines.push(`${code}:   ${entity.padEnd(NAME_WIDTH)}${counts.map((count) => cell(count)).join("")}`);
  }
  return lines;
}

export function writtenLines(code: string, written: WrittenCounts, deactivated: Deactivated | undefined): string[] {
  const lines = Object.entries(written).map(([entity, counts]) =>
    `${code}: wrote ${entity}: ${counts.written} (new ${counts.created}, changed ${counts.changed},`
      + ` back ${counts.reactivated})`);
  if (deactivated) {
    const { links, ...inactive } = deactivated;
    const counts = Object.entries(inactive).map(([entity, count]) => `${entity} ${count}`).join(", ");
    lines.push(`${code}: marked inactive: ${counts}; photo links deleted: ${links}`);
  } else {
    lines.push(`${code}: nothing marked inactive: the snapshot is incomplete`);
  }
  return lines;
}

export function totalLines(code: string, totals: Totals): string[] {
  const { raw, ...active } = totals;
  return [`${code}: in the database: active ${Object.entries(active).map(([name, count]) => `${name} ${count}`).join(", ")};`
    + ` raw records ${raw}`];
}
