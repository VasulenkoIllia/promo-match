-- Statistics for the index of migration search_index_product_model_category (docs/integrations.md, «Точний пошук»):
-- ANALYZE collects those of the expression category->'en', so the planner sees how few models a category's paths have
-- and takes the index rather than a scan of every model. Without it they come with the autoanalyze after the next
-- import, up to a day later. A migration of its own: the index's runs outside a transaction as its only statement.
-- Changes no schema and no rows. Takes SHARE UPDATE EXCLUSIVE, which waits only for another VACUUM, ANALYZE or index
-- build of the table, never for the import's writes; reads a sample of at most 30,000 rows.
ANALYZE "product_model";
