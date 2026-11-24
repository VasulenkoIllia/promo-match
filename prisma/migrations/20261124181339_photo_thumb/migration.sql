-- The reduced copy of a catalogue photo (docs/integrations.md, «Сховище зменшених фото»): the sha256 of the supplier's
-- picture it was made from, which names its file in PHOTO_STORE_DIR (src/photos/thumbs.ts). Additive and nullable with
-- no default, so no row is rewritten (about 200 thousand photos on the server, 2026-11-23); null until an embeddings
-- run makes the copy, and the screen shows the supplier's link meanwhile, as before.
-- Locks: ACCESS EXCLUSIVE on photo for a moment; a running import makes it wait at most lock_timeout.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "photo" ADD COLUMN     "thumb_sha256" TEXT;
