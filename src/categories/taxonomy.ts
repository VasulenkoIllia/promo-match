// The shared category list and each source's mapping to it (decision 2026-10-30, docs/integrations.md, «Спільні
// категорії»), as they live in git: taxonomy.json holds the groups with their categories and names, <source>.json the
// source's own English category paths under the code of their category. WORKER=categories writes them to the
// database (src/categories/sync.ts). A new source gets a file of its own and a line in SOURCE_FILES.
import { ConfigError } from "../config.js";
import { isRecord } from "../suppliers/normalize.js";
import { type CategoryName, CODE_SEGMENT } from "./codes.js";
import axpol from "./axpol.json" with { type: "json" };
import bluecollection from "./bluecollection.json" with { type: "json" };
import easygifts from "./easygifts.json" with { type: "json" };
import inspirion from "./inspirion.json" with { type: "json" };
import macma from "./macma.json" with { type: "json" };
import makito from "./makito.json" with { type: "json" };
import midocean from "./midocean.json" with { type: "json" };
import groups from "./taxonomy.json" with { type: "json" };

const SOURCE_FILES: Record<string, unknown> = { axpol, midocean, inspirion, bluecollection, makito, macma, easygifts };

// A level of a path in a mapping file: "DRINKWARE > ceramic mugs" is ["DRINKWARE", "ceramic mugs"]
export const PATH_SEPARATOR = " > ";
const NAME_LANGUAGES = ["uk", "en"] as const;
// Problems listed before the error message stops
const MAX_LISTED_PROBLEMS = 20;

export interface CategoryEntry {
  code: string;
  // null for a group
  parent: string | null;
  name: CategoryName;
  // Order among the groups, or within the group
  position: number;
}

export interface PathEntry {
  path: string[];
  category: string;
}

export interface Taxonomy {
  // Groups first, then their categories
  entries: CategoryEntry[];
  // Source code to its mapped paths
  paths: Record<string, PathEntry[]>;
}

function nameOf(value: unknown, where: string, problems: string[]): CategoryName {
  const fields = isRecord(value) ? value : {};
  const [uk, en] = NAME_LANGUAGES.map((language) => {
    const text = fields[language];
    if (typeof text === "string" && text.trim()) return text;
    problems.push(`${where}: no ${language} name`);
    return "";
  });
  return { uk: uk ?? "", en: en ?? "" };
}

function readGroups(value: unknown, problems: string[]): CategoryEntry[] {
  // An empty list would deactivate every category
  if (!Array.isArray(value) || !value.length) {
    problems.push("taxonomy: not a list of groups, or an empty one");
    return [];
  }
  const groupEntries: CategoryEntry[] = [];
  const categoryEntries: CategoryEntry[] = [];
  value.forEach((group: unknown, groupIndex) => {
    const fields = isRecord(group) ? group : {};
    const code = typeof fields.code === "string" ? fields.code : "";
    if (!CODE_SEGMENT.test(code)) problems.push(`taxonomy: group ${groupIndex + 1} has the code "${code}"`);
    groupEntries.push({ code, parent: null, name: nameOf(fields.name, code, problems), position: groupIndex });
    const categories: unknown[] = Array.isArray(fields.categories) ? fields.categories : [];
    if (!categories.length) problems.push(`${code}: no categories`);
    categories.forEach((category, position) => {
      const categoryFields = isRecord(category) ? category : {};
      const categoryCode = typeof categoryFields.code === "string" ? categoryFields.code : "";
      const slug = categoryCode.slice(code.length + 1);
      if (!categoryCode.startsWith(`${code}.`) || !CODE_SEGMENT.test(slug)) {
        problems.push(`${code}: category ${position + 1} has the code "${categoryCode}", not "${code}.<name>"`);
      }
      categoryEntries.push({ code: categoryCode, parent: code, name: nameOf(categoryFields.name, categoryCode, problems), position });
    });
  });
  const seen = new Set<string>();
  for (const { code } of [...groupEntries, ...categoryEntries]) {
    if (seen.has(code)) problems.push(`taxonomy: the code "${code}" twice`);
    seen.add(code);
  }
  return [...groupEntries, ...categoryEntries];
}

// A source's file: { "<category code>": ["<level 1> > <level 2>", ...] }, every path once, under a category (never a
// group) of the list
function readPaths(source: string, value: unknown, categoryCodes: Set<string>, problems: string[]): PathEntry[] {
  if (!isRecord(value)) {
    problems.push(`${source}: not an object of category codes`);
    return [];
  }
  // An empty file would delete every mapping of the source; a source without paths has no file
  if (!Object.keys(value).length) problems.push(`${source}: no paths`);
  const entries: PathEntry[] = [];
  const seen = new Set<string>();
  for (const [category, paths] of Object.entries(value)) {
    if (!categoryCodes.has(category)) problems.push(`${source}: "${category}" is not a category of the list`);
    if (!Array.isArray(paths)) {
      problems.push(`${source}: ${category} is not a list of paths`);
      continue;
    }
    for (const text of paths) {
      const path = typeof text === "string" ? text.split(PATH_SEPARATOR) : [];
      if (!path.length || path.some((name) => !name.trim() || name !== name.trim())) {
        problems.push(`${source}: ${category} has the path ${JSON.stringify(text)}`);
        continue;
      }
      const key = path.join(PATH_SEPARATOR);
      if (seen.has(key)) problems.push(`${source}: the path "${key}" twice`);
      seen.add(key);
      entries.push({ path, category });
    }
  }
  return entries;
}

// Every problem of the files at once, so one edit fixes them all
export function readTaxonomy(groupsValue: unknown, sourceFiles: Record<string, unknown>): Taxonomy {
  const problems: string[] = [];
  const entries = readGroups(groupsValue, problems);
  const categoryCodes = new Set(entries.filter((entry) => entry.parent !== null).map((entry) => entry.code));
  const paths = Object.fromEntries(Object.entries(sourceFiles)
    .map(([source, value]) => [source, readPaths(source, value, categoryCodes, problems)]));
  if (problems.length) {
    const listed = problems.slice(0, MAX_LISTED_PROBLEMS).join("; ");
    const more = problems.length > MAX_LISTED_PROBLEMS ? ` and ${problems.length - MAX_LISTED_PROBLEMS} more` : "";
    throw new ConfigError(`the category files are not valid: ${listed}${more}`);
  }
  return { entries, paths };
}

export function loadTaxonomy(): Taxonomy {
  return readTaxonomy(groups, SOURCE_FILES);
}
