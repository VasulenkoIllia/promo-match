-- The dimension of a vector matches the one in its model's name ("voyage-multimodal-3.5/1024"): the column has no
-- dimension of its own, and a stray vector would break the model's HNSW index of stage 4 and every search across it.
-- Additive: two CHECK constraints, which Prisma does not model.
-- Locks: ADD CONSTRAINT scans the table under ACCESS EXCLUSIVE; both tables are empty when this runs (stage 3 starts
-- after it), so it takes a moment.
SET lock_timeout = '5s';

ALTER TABLE "photo_embedding" ADD CONSTRAINT "photo_embedding_dimension_check"
  CHECK (vector_dims("embedding") = split_part("embedding_model", '/', 2)::integer);
ALTER TABLE "text_embedding" ADD CONSTRAINT "text_embedding_dimension_check"
  CHECK (vector_dims("embedding") = split_part("embedding_model", '/', 2)::integer);
