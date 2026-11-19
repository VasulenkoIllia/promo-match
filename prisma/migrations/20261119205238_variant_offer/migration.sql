-- Promotion and sale marks of a variant for the result card (docs/decisions.md, 2026-11-19). Additive: a nullable
-- column without a default, so Postgres writes no row; variant holds tens of thousands of rows, and its lock is held
-- for a moment. lock_timeout as in the neighbouring migrations.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "offer_kind" AS ENUM ('promotion', 'sale');

-- AlterTable
ALTER TABLE "variant" ADD COLUMN     "offer" "offer_kind";
