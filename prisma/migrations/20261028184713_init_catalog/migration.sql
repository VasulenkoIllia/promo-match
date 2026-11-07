-- pgvector for the embeddings of stage 3, enabled with the first model (docs/decisions.md)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "source_kind" AS ENUM ('supplier', 'competitor');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "photo_status" AS ENUM ('pending', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "price_kind" AS ENUM ('net', 'catalog', 'final');

-- CreateTable
CREATE TABLE "source" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "source_kind" NOT NULL,
    "sync_lease_run_id" INTEGER,
    "sync_lease_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_model" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "external_id" TEXT,
    "name" JSONB NOT NULL DEFAULT '{}',
    "description" JSONB NOT NULL DEFAULT '{}',
    "category" JSONB NOT NULL DEFAULT '{}',
    "category_code" TEXT,
    "material" JSONB NOT NULL DEFAULT '{}',
    "brand" TEXT,
    "dimensions" TEXT,
    "weight_grams" DECIMAL(12,3),
    "country_of_origin" TEXT,
    "printing" JSONB,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_run_id" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ,

    CONSTRAINT "product_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "model_id" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "external_id" TEXT,
    "ean" TEXT,
    "color" JSONB NOT NULL DEFAULT '{}',
    "color_code" TEXT,
    "color_group" TEXT,
    "size" TEXT,
    "status" TEXT,
    "printing" JSONB,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_run_id" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ,

    CONSTRAINT "variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo" (
    "id" SERIAL NOT NULL,
    "model_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "url_large" TEXT,
    "kind" TEXT,
    "position" INTEGER NOT NULL,
    "status" "photo_status" NOT NULL DEFAULT 'pending',
    "status_changed_at" TIMESTAMPTZ,
    "error" TEXT,
    "content_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_run_id" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ,

    CONSTRAINT "photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_variant" (
    "photo_id" INTEGER NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "last_seen_run_id" INTEGER NOT NULL,

    CONSTRAINT "photo_variant_pkey" PRIMARY KEY ("photo_id","variant_id")
);

-- CreateTable
CREATE TABLE "price" (
    "id" SERIAL NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "kind" "price_kind" NOT NULL,
    "min_quantity" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "valid_until" DATE,
    "content_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_run_id" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ,

    CONSTRAINT "price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock" (
    "variant_id" INTEGER NOT NULL,
    "in_stock" INTEGER NOT NULL,
    "reserved" INTEGER,
    "on_order" INTEGER,
    "next_arrival_quantity" INTEGER,
    "next_arrival_date" DATE,
    "lead_time" TEXT,
    "arrivals" JSONB NOT NULL DEFAULT '[]',
    "source_updated_at" TIMESTAMPTZ,
    "content_hash" TEXT NOT NULL,
    "last_seen_run_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_pkey" PRIMARY KEY ("variant_id")
);

-- CreateTable
CREATE TABLE "print_technique" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "last_seen_run_id" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_technique_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_record" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "feed" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "sync_run_id" INTEGER NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "raw_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" SERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "sync_status" NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_code_key" ON "source"("code");

-- CreateIndex
CREATE UNIQUE INDEX "product_model_source_id_code_key" ON "product_model"("source_id", "code");

-- CreateIndex
CREATE INDEX "variant_model_id_idx" ON "variant"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_source_id_sku_key" ON "variant"("source_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "photo_model_id_url_key" ON "photo"("model_id", "url");

-- CreateIndex
CREATE INDEX "photo_variant_variant_id_idx" ON "photo_variant"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_variant_id_kind_min_quantity_key" ON "price"("variant_id", "kind", "min_quantity");

-- CreateIndex
CREATE UNIQUE INDEX "print_technique_source_id_code_key" ON "print_technique"("source_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "raw_record_source_id_feed_external_id_key" ON "raw_record"("source_id", "feed", "external_id");

-- CreateIndex
CREATE INDEX "sync_run_source_id_started_at_idx" ON "sync_run"("source_id", "started_at");

-- AddForeignKey
ALTER TABLE "product_model" ADD CONSTRAINT "product_model_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant" ADD CONSTRAINT "variant_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant" ADD CONSTRAINT "variant_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo" ADD CONSTRAINT "photo_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_variant" ADD CONSTRAINT "photo_variant_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_variant" ADD CONSTRAINT "photo_variant_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price" ADD CONSTRAINT "price_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock" ADD CONSTRAINT "stock_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_technique" ADD CONSTRAINT "print_technique_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_record" ADD CONSTRAINT "raw_record_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
