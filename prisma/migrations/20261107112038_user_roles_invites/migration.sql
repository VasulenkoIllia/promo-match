-- Roles and one-time links (docs/integrations.md, «Логін»; docs/decisions.md, 2026-11-07): two enums, a column of
-- app_user and a new table. Additive: the column has a constant default, so Postgres writes no row and every user there
-- becomes a manager; app_user holds a few rows, and its lock is held for a moment. lock_timeout as in the neighbouring
-- migrations.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'manager');

-- CreateEnum
CREATE TYPE "user_invite_kind" AS ENUM ('invite', 'reset');

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'manager';

-- CreateTable
CREATE TABLE "user_invite" (
    "id" SERIAL NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" "user_invite_kind" NOT NULL,
    "role" "user_role",
    "created_by_id" INTEGER NOT NULL,
    "user_id" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,

    CONSTRAINT "user_invite_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: an invite says the role of the user it makes, a reset says whose password it sets
    CONSTRAINT "user_invite_kind_check" CHECK (
        ("kind" = 'invite' AND "role" IS NOT NULL) OR ("kind" = 'reset' AND "user_id" IS NOT NULL AND "role" IS NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invite_token_hash_key" ON "user_invite"("token_hash");

-- CreateIndex
CREATE INDEX "user_invite_created_by_id_idx" ON "user_invite"("created_by_id");

-- CreateIndex
CREATE INDEX "user_invite_user_id_idx" ON "user_invite"("user_id");

-- AddForeignKey
ALTER TABLE "user_invite" ADD CONSTRAINT "user_invite_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invite" ADD CONSTRAINT "user_invite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
