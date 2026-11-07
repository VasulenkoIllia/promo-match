// The lease that keeps two embeddings runs of one source apart: a row in worker_lease named "embed:<source code>",
// taken with one statement, like the import's source.sync_lease_until (src/import/lock.ts). A crashed run blocks the
// next one until its lease runs out. The import keeps its own lease, so an import and an embeddings run of one source
// may overlap: the import never touches a photo's status or vectors.
import type { PrismaClient } from "../generated/prisma/client.js";
import { ImportStopped } from "../import/errors.js";

// Renewed before every provider call and page. One call can take 4 attempts of 120 s with waits between (about
// 9.5 minutes), and a page of downloads several minutes on a bad day, so the lease outlasts both; a run that crashed
// is taken over after this long.
const LEASE_SECONDS = 1_800;

export function leaseName(sourceCode: string): string {
  return `embed:${sourceCode}`;
}

// Taken when free or run out; otherwise says who holds it until when. An earlier embeddings run of the source still
// "running" lost its lease and is closed as failed.
export async function takeWorkerLease(db: PrismaClient, name: string, sourceId: number, runId: number):
  Promise<string | undefined> {
  const taken = await db.$executeRaw`
    INSERT INTO worker_lease AS l (name, run_id, until)
    VALUES (${name}, ${runId}, now() + make_interval(secs => ${LEASE_SECONDS}))
    ON CONFLICT (name) DO UPDATE SET run_id = excluded.run_id, until = excluded.until
    WHERE l.until < now() OR l.run_id = excluded.run_id`;
  if (taken) {
    await db.$executeRaw`
      UPDATE sync_run SET status = 'failed', finished_at = now(),
        error = ${`abandoned: sync_run ${runId} took the lease`}
      WHERE source_id = ${sourceId} AND kind = 'embed' AND status = 'running' AND id < ${runId}`;
    return undefined;
  }
  const holder = await db.workerLease.findUnique({ where: { name }, select: { runId: true, until: true } });
  return `another embeddings run (sync_run ${holder?.runId ?? "?"}) holds ${name}`
    + ` until ${holder?.until.toISOString() ?? "?"}`;
}

// Renewed by its own run only; a lease another run took meanwhile stops this one before its next write
export async function renewWorkerLease(db: PrismaClient, name: string, runId: number): Promise<void> {
  const renewed = await db.$executeRaw`
    UPDATE worker_lease SET until = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE name = ${name} AND run_id = ${runId}`;
  if (!renewed) throw new ImportStopped(`sync_run ${runId} lost the lease ${name} to another run`);
}

export async function releaseWorkerLease(db: PrismaClient, name: string, runId: number): Promise<void> {
  await db.$executeRaw`DELETE FROM worker_lease WHERE name = ${name} AND run_id = ${runId}`;
}
