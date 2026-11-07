-- Guards the import's values cannot pass (the normalizers count such values and leave them out) and room for the
-- updates every import makes. Additive: no column, index or row changes.
-- Locks: ADD CONSTRAINT scans the table under ACCESS EXCLUSIVE; price holds about 44k rows and product_model 7k
-- after the demo import (a second or less). SET (...) takes SHARE UPDATE EXCLUSIVE and rewrites nothing.
SET lock_timeout = '5s';

ALTER TABLE "price" ADD CONSTRAINT "price_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "price" ADD CONSTRAINT "price_min_quantity_check" CHECK ("min_quantity" >= 1);
ALTER TABLE "product_model" ADD CONSTRAINT "product_model_weight_grams_check" CHECK ("weight_grams" >= 0);

-- Each import updates every row it sees (last_seen_run_id): free room on a page keeps the update on that page (a HOT
-- update, no index entries), and autovacuum comes after 2% of dead rows instead of 20%
ALTER TABLE "product_model" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "variant" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "photo" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "photo_variant" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "price" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE "stock" SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);
