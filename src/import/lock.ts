// The source row, its sync_run log and the lease that keeps two imports of one source apart. The lease is a time in
// source.sync_lease_until, taken with one UPDATE: a crashed import blocks the next one until its lease runs out.
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { SourceInfo } from "../suppliers/types.js";
import { ImportStopped } from "./errors.js";

// Longer than a full import takes (minutes); renewed after the read, on every batch and before the deactivation
const LEASE_SECONDS = 1_800;
const MAX_ERROR_CHARS = 2_000;

export async function upsertSource(db: PrismaClient, source: SourceInfo): Promise<number> {
  const row = await db.source.upsert({
    where: { code: source.code },
    create: { code: source.code, name: source.name, kind: source.kind },
    update: { name: source.name },
    select: { id: true },
  });
  return row.id;
}

export async function findSource(db: PrismaClient, code: string): Promise<number | null> {
  const row = await db.source.findUnique({ where: { code }, select: { id: true } });
  return row?.id ?? null;
}

// kind: "catalog" for the import, "embed" for the embeddings worker (src/embeddings)
export async function startRun(db: PrismaClient, sourceId: number, kind: "catalog" | "embed" = "catalog"):
  Promise<number> {
  const run = await db.syncRun.create({ data: { sourceId, kind, status: "running" }, select: { id: true } });
  return run.id;
}

export async function finishRun(db: PrismaClient, runId: number, counts: object, error?: string): Promise<void> {
  await db.syncRun.update({
    where: { id: runId },
    data: {
      status: error === undefined ? "succeeded" : "failed",
      finishedAt: new Date(),
      counts: JSON.parse(JSON.stringify(counts)) as object,
      error: error?.slice(0, MAX_ERROR_CHARS) ?? null,
    },
  });
}

// Taken when free or run out; otherwise says who holds it until when. An earlier import of the source still "running"
// lost its lease (it crashed, or was killed after the forced exit) and is closed as failed: its own close, if it ever
// comes, writes over this. Only kind catalog: an embeddings run has a lease of its own (src/embeddings/lease.ts).
export async function takeLease(db: PrismaClient, sourceId: number, runId: number): Promise<string | undefined> {
  const taken = await db.$executeRaw`
    UPDATE source SET sync_lease_run_id = ${runId}, sync_lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = ${sourceId}
      AND (sync_lease_until IS NULL OR sync_lease_until < now() OR sync_lease_run_id = ${runId})`;
  if (taken) {
    await db.$executeRaw`
      UPDATE sync_run SET status = 'failed', finished_at = now(), error = ${`abandoned: sync_run ${runId} took the lease`}
      WHERE source_id = ${sourceId} AND kind = 'catalog' AND status = 'running' AND id < ${runId}`;
    return undefined;
  }
  const holder = await db.source.findUnique({
    where: { id: sourceId }, select: { syncLeaseRunId: true, syncLeaseUntil: true },
  });
  return `another import (sync_run ${holder?.syncLeaseRunId ?? "?"}) holds the source until `
    + `${holder?.syncLeaseUntil?.toISOString() ?? "?"}`;
}

// Renewed by its own run only; a lease another import took meanwhile stops this one before its next write. Inside a
// transaction the source row stays locked to its end, so no other import takes the lease halfway.
export async function renewLease(db: Prisma.TransactionClient, sourceId: number, runId: number): Promise<void> {
  const renewed = await db.$executeRaw`
    UPDATE source SET sync_lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = ${sourceId} AND sync_lease_run_id = ${runId}`;
  if (!renewed) throw new ImportStopped(`sync_run ${runId} lost the lease of the source to another import`);
}

export async function releaseLease(db: PrismaClient, sourceId: number, runId: number): Promise<void> {
  await db.$executeRaw`
    UPDATE source SET sync_lease_run_id = NULL, sync_lease_until = NULL
    WHERE id = ${sourceId} AND sync_lease_run_id = ${runId}`;
}
