-- Own products and their links to the models of sources (stage 6, docs/integrations.md, «Свої товари»): two new tables.
-- Additive: no existing column, index or row changes.
-- Locks: the foreign key to product_model takes SHARE ROW EXCLUSIVE on it without a scan, since the new table is empty;
-- writes of a running import wait at most lock_timeout.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "own_product_link_type" AS ENUM ('same', 'analog');

-- CreateTable
CREATE TABLE "own_product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "own_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "own_product_link" (
    "own_product_id" INTEGER NOT NULL,
    "model_id" INTEGER NOT NULL,
    "type" "own_product_link_type" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "own_product_link_pkey" PRIMARY KEY ("own_product_id","model_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "own_product_name_key" ON "own_product"("name");

-- CreateIndex
CREATE UNIQUE INDEX "own_product_code_key" ON "own_product"("code");

-- CreateIndex
CREATE INDEX "own_product_link_model_id_idx" ON "own_product_link"("model_id");

-- AddForeignKey
ALTER TABLE "own_product_link" ADD CONSTRAINT "own_product_link_own_product_id_fkey" FOREIGN KEY ("own_product_id") REFERENCES "own_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "own_product_link" ADD CONSTRAINT "own_product_link_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

