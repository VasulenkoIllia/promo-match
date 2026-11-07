-- CreateTable
CREATE TABLE "query_reading" (
    "parse_model" TEXT NOT NULL,
    "prompt_sha256" TEXT NOT NULL,
    "text_sha256" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_reading_pkey" PRIMARY KEY ("parse_model","prompt_sha256","text_sha256")
);
