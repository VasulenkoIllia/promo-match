// WORKER=categories (docs/integrations.md, «Спільні категорії»): writes the shared category list and the sources'
// mappings from git (src/categories/taxonomy.ts) to the tables category and source_category, and reports the paths
// of active models that no mapping covers. A dry run reads the database and writes nothing. A few hundred rows, so one
// short transaction of five statements; running it twice changes nothing the second time.
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ImportStopped } from "../import/errors.js";
import { checkDatabase } from "../import/run.js";
import { jsonParam } from "../import/write.js";
import { isRecord } from "../suppliers/normalize.js";
import { type CategoryEntry, loadTaxonomy, PATH_SEPARATOR, type Taxonomy } from "./taxonomy.js";

// Unmapped and stale paths printed per source, the largest first; the rest only counted
const MAX_LISTED_PATHS = 50;
// A sync that would deactivate more of the active categories, or remove more of a source's mappings, stops before
// writing unless --allow-mass-removal: a cut file is more likely than such an edit (as the import's 20%)
const MASS_REMOVAL_SHARE = 0.2;

interface CategoryRow {
  code: string;
  parent: string | null;
  name: unknown;
  position: number;
  isActive: boolean;
}

interface MappingRow {
  source: string;
  path: string[];
  category: string;
}

interface CatalogPathRow {
  source: string;
  // null: models without an English category
  path: string[] | null;
  activeModels: number;
}

export interface SyncState {
  sources: string[];
  categories: CategoryRow[];
  mappings: MappingRow[];
  catalogPaths: CatalogPathRow[];
}

export interface SourcePlan {
  source: string;
  // false: the source was never imported, its paths wait for its row
  hasRow: boolean;
  inFile: number;
  // Mappings of the source in the database now
  existing: number;
  added: number;
  changed: number;
  same: number;
  removed: number;
  // Paths of the source's active models that the file does not map, with the count of such models
  unmapped: { path: string[] | null; models: number }[];
  // Paths of the file that no model of the source has, active or not
  stale: string[][];
}

export interface SyncPlan {
  categories: {
    inFile: number; activeInDb: number; added: string[]; changed: string[]; same: number; deactivated: string[];
  };
  sources: SourcePlan[];
}

function pathOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((name) => typeof name === "string") ? value : null;
}

async function readSyncState(db: PrismaClient): Promise<SyncState> {
  const [sources, categories, mappings, catalogPaths] = await Promise.all([
    db.$queryRaw<{ code: string }[]>`SELECT code FROM source`,
    db.$queryRaw<CategoryRow[]>`
      SELECT c.code, p.code AS parent, c.name, c.position, c.is_active AS "isActive"
      FROM category c LEFT JOIN category p ON p.id = c.parent_id`,
    db.$queryRaw<{ source: string; path: unknown; category: string }[]>`
      SELECT s.code AS source, sc.path, c.code AS category
      FROM source_category sc JOIN source s ON s.id = sc.source_id JOIN category c ON c.id = sc.category_id`,
    db.$queryRaw<{ source: string; path: unknown; activeModels: number }[]>`
      SELECT s.code AS source, m.category->'en' AS path, count(*) FILTER (WHERE m.is_active)::integer AS "activeModels"
      FROM product_model m JOIN source s ON s.id = m.source_id GROUP BY s.code, m.category->'en'`,
  ]);
  return {
    sources: sources.map((row) => row.code),
    categories,
    mappings: mappings.map((row) => ({ ...row, path: pathOf(row.path) ?? [] })),
    catalogPaths: catalogPaths.map((row) => ({ ...row, path: pathOf(row.path) })),
  };
}

// The name as a whole, as the write compares it: another key in it is a change too
function isSameCategory(row: CategoryRow, entry: CategoryEntry): boolean {
  const name = isRecord(row.name) ? row.name : {};
  return row.isActive && row.parent === entry.parent && row.position === entry.position
    && Object.keys(name).length === 2 && name.uk === entry.name.uk && name.en === entry.name.en;
}

function planCategories(state: SyncState, taxonomy: Taxonomy): SyncPlan["categories"] {
  const rows = new Map(state.categories.map((row) => [row.code, row]));
  const inFile = new Set(taxonomy.entries.map((entry) => entry.code));
  const added: string[] = [];
  const changed: string[] = [];
  for (const entry of taxonomy.entries) {
    const row = rows.get(entry.code);
    if (!row) added.push(entry.code);
    else if (!isSameCategory(row, entry)) changed.push(entry.code);
  }
  const active = state.categories.filter((row) => row.isActive);
  const deactivated = active.filter((row) => !inFile.has(row.code)).map((row) => row.code);
  return {
    inFile: inFile.size, activeInDb: active.length, added, changed, same: inFile.size - added.length - changed.length,
    deactivated,
  };
}

const keyOf = (path: string[]) => JSON.stringify(path);

function planSource(source: string, state: SyncState, taxonomy: Taxonomy): SourcePlan {
  const filePaths = taxonomy.paths[source] ?? [];
  const mapped = new Map(state.mappings.filter((row) => row.source === source).map((row) => [keyOf(row.path), row.category]));
  const catalog = state.catalogPaths.filter((row) => row.source === source);
  const inFile = new Set(filePaths.map((entry) => keyOf(entry.path)));
  const inCatalog = new Set(catalog.flatMap((row) => (row.path ? [keyOf(row.path)] : [])));
  let added = 0;
  let changed = 0;
  for (const entry of filePaths) {
    const category = mapped.get(keyOf(entry.path));
    if (category === undefined) added += 1;
    else if (category !== entry.category) changed += 1;
  }
  return {
    source,
    hasRow: state.sources.includes(source),
    inFile: filePaths.length,
    existing: mapped.size,
    added,
    changed,
    same: filePaths.length - added - changed,
    removed: [...mapped.keys()].filter((key) => !inFile.has(key)).length,
    unmapped: catalog.filter((row) => row.activeModels > 0 && !(row.path && inFile.has(keyOf(row.path))))
      .map((row) => ({ path: row.path, models: row.activeModels })).sort((a, b) => b.models - a.models),
    stale: filePaths.filter((entry) => !inCatalog.has(keyOf(entry.path))).map((entry) => entry.path),
  };
}

// What a sync would change, and what the file leaves out: the sources of the files, of the database and of mappings
// already written
export function planSync(state: SyncState, taxonomy: Taxonomy): SyncPlan {
  const sources = [...new Set([...Object.keys(taxonomy.paths), ...state.sources, ...state.mappings.map((row) => row.source)])]
    .sort();
  return { categories: planCategories(state, taxonomy), sources: sources.map((source) => planSource(source, state, taxonomy)) };
}

function listed(source: string, title: string, paths: string[]): string[] {
  if (!paths.length) return [];
  const more = paths.length > MAX_LISTED_PATHS ? [`${source}:   ... and ${paths.length - MAX_LISTED_PATHS} more`] : [];
  return [`${source}: ${title}:`, ...paths.slice(0, MAX_LISTED_PATHS).map((path) => `${source}:   ${path}`), ...more];
}

function sourceLines(source: SourcePlan): string[] {
  const { source: code } = source;
  // Its paths are left out of the write (the JOIN on source): a source never imported, or a file key no source has
  if (!source.hasRow) return [`WARNING ${code}: no such source in the database, its ${source.inFile} paths are not written`];
  const unmappedModels = source.unmapped.reduce((sum, row) => sum + row.models, 0);
  return [
    `${code}: ${source.inFile} paths in the file; new ${source.added}, changed ${source.changed}, same ${source.same},`
      + ` removed ${source.removed}`,
    `${code}: ${source.unmapped.length} paths of active models without a category (${unmappedModels} models)`,
    ...listed(code, "without a category", source.unmapped.map((row) =>
      `${row.path ? row.path.join(PATH_SEPARATOR) : "(no English category)"} (${row.models} models)`)),
    ...listed(code, "in the file, but no model has the path", source.stale.map((path) => path.join(PATH_SEPARATOR))),
  ];
}

// The last line sums up what needs a hand: paths to add to the files, sources whose paths wait
export function planLines(plan: SyncPlan): string[] {
  const { categories } = plan;
  const lines = [`categories: ${categories.inFile} in the files; new ${categories.added.length}, changed`
    + ` ${categories.changed.length}, same ${categories.same}, deactivated ${categories.deactivated.length}`];
  if (categories.deactivated.length) lines.push(`categories: deactivated ${categories.deactivated.join(", ")}`);
  for (const source of plan.sources) lines.push(...sourceLines(source));
  const unmapped = plan.sources.flatMap((source) => (source.hasRow ? source.unmapped : []));
  const waiting = plan.sources.filter((source) => !source.hasRow).map((source) => source.source);
  lines.push(`summary: ${unmapped.length} paths of active models without a category`
    + ` (${unmapped.reduce((sum, row) => sum + row.models, 0)} models)`
    + (waiting.length ? `, paths not written for ${waiting.join(", ")}` : ""));
  return lines;
}

// Why the sync stops before writing, if it would deactivate or remove a large share of what there is
export function massRemoval(plan: SyncPlan): string | undefined {
  const reasons: string[] = [];
  const { categories } = plan;
  if (categories.deactivated.length > categories.activeInDb * MASS_REMOVAL_SHARE) {
    reasons.push(`${categories.deactivated.length} of ${categories.activeInDb} active categories deactivated`);
  }
  for (const source of plan.sources) {
    if (source.removed > source.existing * MASS_REMOVAL_SHARE) {
      reasons.push(`${source.source}: ${source.removed} of ${source.existing} paths removed`);
    }
  }
  if (!reasons.length) return undefined;
  return `${reasons.join("; ")}: stopped before any write (--allow-mass-removal if it is meant)`;
}

// One level of the list: groups first, so their categories find the parent's id
function upsertCategories(entries: CategoryEntry[]): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO category AS t (code, parent_id, name, position, is_active)
    SELECT x.code, p.id, x.name, x.position, true
    FROM jsonb_to_recordset(${jsonParam(entries)}::jsonb) AS x(code text, parent text, name jsonb, position integer)
    LEFT JOIN category p ON p.code = x.parent
    ON CONFLICT (code) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, position = excluded.position,
      is_active = true
    WHERE (t.parent_id, t.name, t.position, t.is_active)
      IS DISTINCT FROM (excluded.parent_id, excluded.name, excluded.position, true)`;
}

interface CategoryWriteCounts {
  categories: number;
  deactivated: number;
  pathsRemoved: number;
  pathsWritten: number;
}

// The mappings are derived from the files: a path the files no longer have is deleted, of every source
async function writeTaxonomy(db: PrismaClient, taxonomy: Taxonomy): Promise<CategoryWriteCounts> {
  const codes = jsonParam(taxonomy.entries.map((entry) => entry.code));
  const paths = jsonParam(Object.entries(taxonomy.paths)
    .flatMap(([source, entries]) => entries.map((entry) => ({ source, path: entry.path, category: entry.category }))));
  const [groups, categories, deactivated, pathsRemoved, pathsWritten] = await db.$transaction([
    db.$executeRaw(upsertCategories(taxonomy.entries.filter((entry) => entry.parent === null))),
    db.$executeRaw(upsertCategories(taxonomy.entries.filter((entry) => entry.parent !== null))),
    db.$executeRaw`UPDATE category SET is_active = false
      WHERE is_active AND code NOT IN (SELECT jsonb_array_elements_text(${codes}::jsonb))`,
    db.$executeRaw`DELETE FROM source_category sc USING source s
      WHERE s.id = sc.source_id AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(${paths}::jsonb) AS x(source text, path jsonb, category text)
        WHERE x.source = s.code AND x.path = sc.path)`,
    db.$executeRaw`INSERT INTO source_category AS t (source_id, path, category_id)
      SELECT s.id, x.path, c.id
      FROM jsonb_to_recordset(${paths}::jsonb) AS x(source text, path jsonb, category text)
      JOIN source s ON s.code = x.source JOIN category c ON c.code = x.category
      ON CONFLICT (source_id, path) DO UPDATE SET category_id = excluded.category_id
      WHERE t.category_id <> excluded.category_id`,
  ]);
  return { categories: groups + categories, deactivated, pathsRemoved, pathsWritten };
}

export interface CategorySyncOptions {
  isDryRun: boolean;
  allowMassRemoval: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
}

export async function runCategorySync(db: PrismaClient, options: CategorySyncOptions): Promise<void> {
  const { log, signal } = options;
  // The files first: a broken one stops the run before the database
  const taxonomy = loadTaxonomy();
  await checkDatabase(db, log);
  const plan = planSync(await readSyncState(db), taxonomy);
  for (const line of planLines(plan)) log(line);
  const refusal = massRemoval(plan);
  if (refusal && !options.allowMassRemoval) throw new ImportStopped(refusal);
  if (options.isDryRun) {
    log("dry run, nothing written");
    return;
  }
  signal.throwIfAborted();
  const written = await writeTaxonomy(db, taxonomy);
  log(`written: categories ${written.categories}, deactivated ${written.deactivated}, paths ${written.pathsWritten},`
    + ` paths removed ${written.pathsRemoved}`);
}
