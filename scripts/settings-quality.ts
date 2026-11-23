// The report of quality by variant (stage 2a, README «Тест якості пошуку»): from the journal of searches and the
// managers' grades, for each set of search settings, where the first model graded exact stood (src/search/
// settings-quality.ts). Reads only, against the database of DATABASE_URL (a copy of the prod database, docs/deployment.md);
// prints counts only, no text of a query.
//   pnpm run search:settings-quality
import { config } from "../src/config.js";
import { createPrisma, databasePassword } from "../src/db.js";
import { type JournalSearch, qualityByVariant, qualityLines } from "../src/search/settings-quality.js";
import { scrub } from "../src/suppliers/secrets.js";

const secrets = [databasePassword(config.databaseUrl)].filter(Boolean);

function databaseName(url: string): string {
  return URL.canParse(url) ? new URL(url).pathname.slice(1) : "?";
}

async function main(): Promise<void> {
  const db = createPrisma(config.databaseUrl, (error) => console.error(scrub(`database pool error: ${error.message}`, secrets)));
  try {
    // The name first: a DATABASE_URL of the prod database shows before anything is read
    console.log(`database ${databaseName(config.databaseUrl)}`);
    // One row per search the journal keeps with its settings (90 days at most), its grades counted beside it; in a
    // read-only transaction, so the report can write nothing whatever the URL
    const [, searches] = await db.$transaction([
      db.$executeRaw`SET TRANSACTION READ ONLY`,
      db.$queryRaw<JournalSearch[]>`
        SELECT j.settings, j.has_photo AS "hasPhoto", j.query_text IS NOT NULL AS "hasText",
          count(g.search_id)::int AS grades, min(g.rank) FILTER (WHERE g.grade = 'exact') AS "firstExactRank"
        FROM search_journal j LEFT JOIN result_grade g ON g.search_id = j.search_id
        WHERE j.settings IS NOT NULL
        GROUP BY j.search_id`,
    ]);
    const graded = searches.filter((search) => search.grades > 0).length;
    console.log(`${searches.length} searches with their settings, ${graded} graded`);
    for (const line of qualityLines(qualityByVariant(searches))) console.log(line);
    console.log("not a blind test: a manager grades what the search showed, and a search without a grade counts in no place");
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(scrub(error instanceof Error ? error.stack ?? error.message : String(error), secrets));
  process.exitCode = 1;
}
