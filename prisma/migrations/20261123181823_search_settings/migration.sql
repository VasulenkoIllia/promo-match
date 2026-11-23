-- The search settings (docs/integrations.md, «Налаштування пошуку»). Additive: a nullable column of the journal, a new
-- table with its index and a foreign key to app_user. Locks: the column and its CHECK take ACCESS EXCLUSIVE on
-- search_journal for one scan of its heap (the photos lie in TOAST and are not read; at 100 searches a day a few
-- thousand rows), the foreign key SHARE ROW EXCLUSIVE on app_user (a few rows); the new table is empty.
SET lock_timeout = '5s';

-- AlterTable
-- null: a search of before the settings; no default, so no row is rewritten
ALTER TABLE "search_journal" ADD COLUMN     "settings" JSONB;
ALTER TABLE "search_journal" ADD CONSTRAINT "search_journal_settings_check"
    CHECK ("settings" IS NULL OR jsonb_typeof("settings") = 'object');

-- CreateTable
CREATE TABLE "search_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" INTEGER,

    CONSTRAINT "search_settings_pkey" PRIMARY KEY ("id"),
    -- Not modelled by Prisma: the one row of the defaults, its settings an object
    CONSTRAINT "search_settings_single_row_check" CHECK ("id" = 1),
    CONSTRAINT "search_settings_object_check" CHECK (jsonb_typeof("settings") = 'object')
);

-- CreateIndex
CREATE INDEX "search_settings_updated_by_id_idx" ON "search_settings"("updated_by_id");

-- AddForeignKey
ALTER TABLE "search_settings" ADD CONSTRAINT "search_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
