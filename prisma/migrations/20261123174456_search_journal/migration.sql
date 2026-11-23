-- The journal of searches (docs/integrations.md, «Журнал пошуків»). Additive: a new table, its indexes and a foreign
-- key to app_user. Locks: the foreign key takes SHARE ROW EXCLUSIVE on app_user (a few rows) for a moment; the new
-- table is empty.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "search_journal" (
    "search_id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query_text" TEXT,
    "query_parse" JSONB,
    "has_photo" BOOLEAN NOT NULL,
    "photo" BYTEA,
    "photo_size_bytes" INTEGER,
    "embedding_model" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "result_limit" INTEGER NOT NULL,
    "is_parse_query" BOOLEAN NOT NULL,
    "is_condition_pass" BOOLEAN NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "took_ms" INTEGER NOT NULL,

    CONSTRAINT "search_journal_pkey" PRIMARY KEY ("search_id"),
    -- Not modelled by Prisma: a search has a text or a photo; the size is there exactly when a photo was, a kept photo
    -- is that size; the counts are not negative. Each part is true or false, never NULL, which a CHECK would let pass.
    CONSTRAINT "search_journal_input_check" CHECK ("query_text" IS NOT NULL OR "has_photo"),
    CONSTRAINT "search_journal_photo_check" CHECK (
        "has_photo" = ("photo_size_bytes" IS NOT NULL)
        AND ("photo_size_bytes" IS NULL OR "photo_size_bytes" > 0)
        AND ("photo" IS NULL OR ("photo_size_bytes" IS NOT NULL AND octet_length("photo") = "photo_size_bytes"))
    ),
    CONSTRAINT "search_journal_counts_check" CHECK ("result_limit" >= 1 AND "took_ms" >= 0),
    CONSTRAINT "search_journal_results_check" CHECK (jsonb_typeof("results") = 'array')
);

-- A JPEG does not compress: the photo goes out of line as it is, without a try at compressing it
ALTER TABLE "search_journal" ALTER COLUMN "photo" SET STORAGE EXTERNAL;
-- The pruning deletes the oldest photos every 6 hours: the TOAST table is vacuumed after 5% of dead chunks, not 20%,
-- so their room is used again sooner
ALTER TABLE "search_journal" SET (toast.autovacuum_vacuum_scale_factor = 0.05);

-- CreateIndex
CREATE INDEX "search_journal_user_id_idx" ON "search_journal"("user_id");

-- CreateIndex
CREATE INDEX "search_journal_created_at_idx" ON "search_journal"("created_at");

-- AddForeignKey
ALTER TABLE "search_journal" ADD CONSTRAINT "search_journal_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
