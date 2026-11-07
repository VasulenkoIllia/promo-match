// A supplier's own category tree in the filters (Filters.tsx, docs/integrations.md, «Пошук»): shown beside the shared
// categories while one supplier is chosen (decision 2026-11-07). Built from the English paths GET /api/search/options
// gives; the search takes a node as a prefix of the path (filters.categories, src/search/store.ts).
import type { CategoryFilter, CategoryOption } from "./api";
import type { FilterState } from "./format";

// The API's bound for a path (src/search/request.ts, MAX_CATEGORY_DEPTH): a deeper node could not be sent
const MAX_DEPTH = 5;
const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export interface SupplierCategoryNode {
  // The prefix the node stands for, as the filter takes it
  path: string[];
  // 0 for a top-level section
  depth: number;
  // The active models of every path under it, its own included
  models: number;
}

interface Branch {
  models: number;
  children: Map<string, Branch>;
}

function flatten(level: Map<string, Branch>, prefix: string[], into: SupplierCategoryNode[]): void {
  const sorted = [...level.entries()].sort(([one], [other]) => names.compare(one, other));
  for (const [name, branch] of sorted) {
    const path = [...prefix, name];
    into.push({ path, depth: prefix.length, models: branch.models });
    flatten(branch.children, path, into);
  }
}

// The nodes in reading order: a node, then its children by name
export function supplierCategoryTree(options: CategoryOption[], source: string): SupplierCategoryNode[] {
  const root = new Map<string, Branch>();
  for (const option of options.filter((each) => each.source === source)) {
    let level = root;
    for (const name of option.path.slice(0, MAX_DEPTH)) {
      const branch = level.get(name) ?? { models: 0, children: new Map<string, Branch>() };
      branch.models += option.models;
      level.set(name, branch);
      level = branch.children;
    }
  }
  const nodes: SupplierCategoryNode[] = [];
  flatten(root, [], nodes);
  return nodes;
}

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

// A supplier's categories filter the search only while it is the one source chosen: beside another, the filter would
// leave out all of the other's models
export function supplierCategoriesOf({ sources, supplierCategories }: FilterState): CategoryFilter[] {
  const [source, ...others] = sources;
  if (source === undefined || others.length) return [];
  return supplierCategories.filter((each) => each.source === source);
}

// Another choice of suppliers drops the nodes of a tree no longer shown, rather than keep a filter the screen hides
export function withSources(form: FilterState, sources: string[]): FilterState {
  const only = sources.length === 1 ? sources[0] : undefined;
  return { ...form, sources, supplierCategories: form.supplierCategories.filter((each) => each.source === only) };
}
