-- CreateEnum
CREATE TYPE "result_grade_value" AS ENUM ('exact', 'suitable', 'wrong');

-- CreateTable
CREATE TABLE "result_grade" (
    "search_id" UUID NOT NULL,
    "model_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "grade" "result_grade_value" NOT NULL,
    "query_text" TEXT,
    "has_photo" BOOLEAN NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "rank" INTEGER NOT NULL,
    "confidence_percent" INTEGER,
    "lists" JSONB NOT NULL DEFAULT '{}',
    "condition_match" JSONB,
    "matched_code" TEXT,
    "graded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_grade_pkey" PRIMARY KEY ("search_id","model_id","user_id")
);

-- CreateIndex
CREATE INDEX "result_grade_model_id_idx" ON "result_grade"("model_id");

-- CreateIndex
CREATE INDEX "result_grade_user_id_idx" ON "result_grade"("user_id");

-- AddForeignKey
ALTER TABLE "result_grade" ADD CONSTRAINT "result_grade_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "product_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_grade" ADD CONSTRAINT "result_grade_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
