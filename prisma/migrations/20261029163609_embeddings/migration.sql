-- Embeddings of stage 3 (docs/integrations.md, «Ембедінги каталогу»): vectors of photos and of model texts by
-- embedding model, and the lease of the embeddings worker. Additive: three new tables, nothing else changes.
-- The vector column has no dimension: it depends on the model, and the HNSW index of a model (stage 4) casts to it.
-- Locks: the two foreign keys take SHARE ROW EXCLUSIVE on photo (about 140k rows) and product_model (7k) for a moment;
-- the new tables are empty, so there is nothing to validate.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "photo_embedding" (
    "photo_id" INTEGER NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "image_sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_embedding_pkey" PRIMARY KEY ("photo_id","embedding_model")
);

-- CreateTable
CREATE TABLE "text_embedding" (
    "model_id" INTEGER NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "text_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "text_embedding_pkey" PRIMARY KEY ("model_id","embedding_model")
);

-- CreateTable
CREATE TABLE "worker_lease" (
    "name" TEXT NOT NULL,
    "run_id" INTEGER NOT NULL,
    "until" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "worker_lease_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "photo_embedding_embedding_model_image_sha256_idx" ON "photo_embedding"("embedding_model", "image_sha256");

-- AddForeignKey
ALTER TABLE "photo_embedding" ADD CONSTRAINT "photo_embedding_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_embedding" ADD CONSTRAINT "text_embedding_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
