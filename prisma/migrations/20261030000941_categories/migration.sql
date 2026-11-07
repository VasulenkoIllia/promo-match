-- The shared category list (decision 2026-10-30, docs/integrations.md, «Спільні категорії»): two new tables, filled by
-- WORKER=categories from src/categories/*.json. Additive: no existing column, index or row changes.
-- Locks: the foreign key to source takes SHARE ROW EXCLUSIVE on source (a few rows; the import's lease updates wait
-- at most lock_timeout).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "category" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "parent_id" INTEGER,
    "name" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_category" (
    "source_id" INTEGER NOT NULL,
    "path" JSONB NOT NULL,
    "category_id" INTEGER NOT NULL,

    CONSTRAINT "source_category_pkey" PRIMARY KEY ("source_id","path")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_code_key" ON "category"("code");

-- CreateIndex
CREATE INDEX "category_parent_id_idx" ON "category"("parent_id");

-- CreateIndex
CREATE INDEX "source_category_category_id_idx" ON "source_category"("category_id");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_category" ADD CONSTRAINT "source_category_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_category" ADD CONSTRAINT "source_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guards the sync's own checks hold too, which Prisma does not model: a group has no parent and a code without a dot,
-- a category has both; a path is the JSON array product_model.category->'en' holds
ALTER TABLE "category" ADD CONSTRAINT "category_level_check"
  CHECK (("parent_id" IS NULL) = (strpos("code", '.') = 0));
ALTER TABLE "source_category" ADD CONSTRAINT "source_category_path_check" CHECK (jsonb_typeof("path") = 'array');
