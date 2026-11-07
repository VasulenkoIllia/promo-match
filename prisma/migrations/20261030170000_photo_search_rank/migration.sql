-- The place of a photo among its model's pictures for the search (docs/integrations.md, «Ембедінги каталогу»).
-- Additive and nullable, no rewrite of the table: until an embeddings run or an import ranks the photos
-- (src/embeddings/store.ts, refreshSearchRanks) the search treats null as in, as it did before this column.
-- Locks: ACCESS EXCLUSIVE on photo for a moment; a running import makes it wait at most lock_timeout.
SET lock_timeout = '5s';

ALTER TABLE "photo" ADD COLUMN "search_rank" INTEGER;
