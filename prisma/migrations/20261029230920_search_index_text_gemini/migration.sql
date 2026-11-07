-- Search index of stage 4, as 20261029230918_search_index_photo_gemini (read there): model texts of Gemini.
CREATE INDEX CONCURRENTLY "text_embedding_gemini_1536_hnsw" ON "text_embedding"
  USING hnsw (("embedding"::halfvec(1536)) halfvec_cosine_ops)
  WHERE "embedding_model" = 'gemini-embedding-2/1536';
