-- Search index for the category filters (docs/integrations.md, «Пошук», 2026-10-30): the shared category filter joins
-- source_category to the model's whole English path, and an exact list starts from the models that pass, so a narrow
-- category reads its few models instead of every model of the source. Partial on active models: the search reads only
-- those. ANALYZE then keeps statistics of the expression, so the planner sees how few models a path has. Prisma does
-- not model an index on an expression (schema.prisma).
-- Additive. CONCURRENTLY does not block the import's writes, and runs outside a transaction only as the single
-- statement of its file. A failed build leaves an INVALID index of this name: DROP INDEX CONCURRENTLY it, then
-- `prisma migrate resolve --rolled-back` this migration and deploy again.
CREATE INDEX CONCURRENTLY "product_model_source_id_category_en_idx" ON "product_model" ("source_id", ("category" -> 'en'))
  WHERE "is_active";
