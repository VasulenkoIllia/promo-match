-- Search index of stage 4 (docs/integrations.md, «Пошук»), one of four: an HNSW index per embedding model and table,
-- partial on the model's name and over the vector cast to halfvec of the model's dimension (the column has none).
-- halfvec takes half the memory of vector at about the same recall. The search casts its query the same way and puts
-- the model's name in as a literal (src/search/models.ts), or the planner would not use the index. Cosine distance.
-- Additive. CONCURRENTLY does not block writes of the embeddings worker, and runs outside a transaction only as the
-- single statement of its file, hence a migration per index. A failed build leaves an INVALID index of this name:
-- DROP INDEX CONCURRENTLY it, then `prisma migrate resolve --rolled-back` this migration and deploy again.
-- Default settings (maintenance_work_mem 64 MB, /dev/shm 64 MB in Docker): 30.6 s for 51,095 photos, 181 MB
-- (2026-10-29, local). A new embedding model gets indexes of its own in migrations of their own.
CREATE INDEX CONCURRENTLY "photo_embedding_gemini_1536_hnsw" ON "photo_embedding"
  USING hnsw (("embedding"::halfvec(1536)) halfvec_cosine_ops)
  WHERE "embedding_model" = 'gemini-embedding-2/1536';
