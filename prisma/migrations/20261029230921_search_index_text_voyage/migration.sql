-- Search index of stage 4, as 20261029230918_search_index_photo_gemini (read there): model texts of Voyage.
CREATE INDEX CONCURRENTLY "text_embedding_voyage_1024_hnsw" ON "text_embedding"
  USING hnsw (("embedding"::halfvec(1024)) halfvec_cosine_ops)
  WHERE "embedding_model" = 'voyage-multimodal-3.5/1024';
