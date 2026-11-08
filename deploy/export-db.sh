#!/usr/bin/env bash
# On the Mac, for the move of the database to the server (docs/deployment.md, «Перенос бази»): a copy of the local
# database, promo_match_export, without the users, their sessions, invites and grades and without the vectors the
# server does not search with; then VACUUM, the counts of both databases and a pg_dump -Fc of the copy. The vectors
# move with the base, nothing is embedded again. The working database is only read.
#
#   deploy/export-db.sh           plan: the counts and what the copy would leave out, nothing written
#   deploy/export-db.sh --write   the copy, its counts and the dump in output/export/ (purchase prices: mode 600)
#
# Run from the repository root, with the dev database up (pnpm run db:up).
set -euo pipefail
umask 077

readonly EXPORT_DB=promo_match_export
readonly OUT_DIR=output/export
# Not searched on the server: Voyage is off the screen, the brand-free texts are a candidate that did not pass
readonly DROPPED_MODELS="'voyage-multimodal-3.5/1024', 'gemini-embedding-2-brand-free/1536'"
# Index builds of the restore (HNSW) run faster with more memory. Without parallel workers: theirs is shared memory,
# and the 64 MB /dev/shm of the container ends the build with "could not resize shared memory segment" (2026-11-07).
readonly RESTORE_PGOPTIONS="-c maintenance_work_mem=512MB -c max_parallel_maintenance_workers=0"

mode=${1:-}
if [ -n "$mode" ] && [ "$mode" != --write ]; then
  echo "usage: deploy/export-db.sh [--write]" >&2
  exit 64
fi

dev=(docker compose -f docker-compose.dev.yml)
say() { printf '\n== %s\n' "$1"; }
die() { echo "export-db: $1" >&2; exit 1; }

# SQL on stdin into one database: empty name is the working one, read only by the session's setting
sql_in() {
  local target=$1 options='-c default_transaction_read_only=on'
  [ -z "$target" ] || options=
  # shellcheck disable=SC2016 # $POSTGRES_* and $TARGET_DB expand inside the db container, on purpose
  "${dev[@]}" exec -T -e TARGET_DB="$target" -e PGOPTIONS="$options" db \
    sh -c 'psql -U "$POSTGRES_USER" -d "${TARGET_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -X -q -At'
}

export_exists() {
  # shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
  "${dev[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -X -q -At -c "select 1 from pg_database where datname = '\'"$EXPORT_DB"\''"'
}

left_out_sql="select format(E'photo_vectors_left_out\t%s', count(*)) from photo_embedding where embedding_model in ($DROPPED_MODELS)
  union all select format(E'text_vectors_left_out\t%s', count(*)) from text_embedding where embedding_model in ($DROPPED_MODELS)
  union all select format(E'leases_cleared\t%s', (select count(*) from worker_lease)
    + (select count(*) from source where sync_lease_until is not null));"

# No CASCADE: a table that references the users and is not named here stops the export instead of losing its rows
clean_sql="begin;
  delete from photo_embedding where embedding_model in ($DROPPED_MODELS);
  delete from text_embedding where embedding_model in ($DROPPED_MODELS);
  truncate result_grade, user_session, user_invite, app_user;
  delete from worker_lease;
  update source set sync_lease_run_id = null, sync_lease_until = null where sync_lease_until is not null;
commit;"

"${dev[@]}" ps --status running --quiet db | grep -q . || die "the dev database is not running: pnpm run db:up"
mkdir -p "$OUT_DIR"
stamp=$(date +%Y%m%d-%H%M%S)

say "Working database"
sql_in "" <deploy/counts.sql | tee "$OUT_DIR/counts-working-$stamp.tsv"
say "Left out of the copy"
sql_in "" <<<"$left_out_sql"
echo "users, sessions, invites, grades: all rows (see the rows lines above)"

if [ "$mode" != --write ]; then
  [ -z "$(export_exists)" ] || echo "note: $EXPORT_DB exists already, --write will stop"
  echo "plan only; the copy and the dump: deploy/export-db.sh --write"
  exit 0
fi

[ -z "$(export_exists)" ] || die "$EXPORT_DB exists: drop it by hand first (docs/deployment.md, «Перенос бази»)"

say "Copy"
# The copy is ours from here: a run that fails halfway drops it, so the next run starts clean
is_copy_started=
drop_failed_copy() {
  local code=$?
  [ "$code" -ne 0 ] && [ -n "$is_copy_started" ] || return 0
  echo "export-db: the copy failed, dropping the unfinished $EXPORT_DB" >&2
  # shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
  "${dev[@]}" exec -T -e EXPORT_DB="$EXPORT_DB" db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$EXPORT_DB"' || true
}
trap drop_failed_copy EXIT
is_copy_started=true
# shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
"${dev[@]}" exec -T -e EXPORT_DB="$EXPORT_DB" -e RESTORE_PGOPTIONS="$RESTORE_PGOPTIONS" db sh -c '
  set -e
  createdb -U "$POSTGRES_USER" "$EXPORT_DB"
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc |
    PGOPTIONS="$RESTORE_PGOPTIONS" pg_restore -U "$POSTGRES_USER" -d "$EXPORT_DB" --exit-on-error'
sql_in "$EXPORT_DB" <<<"$clean_sql"
sql_in "$EXPORT_DB" <<<"vacuum (analyze);"

say "Copy counts"
sql_in "$EXPORT_DB" <deploy/counts.sql | tee "$OUT_DIR/counts-export-$stamp.tsv"

say "Dump"
dump=$OUT_DIR/$EXPORT_DB-$stamp.dump
# shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
"${dev[@]}" exec -T -e EXPORT_DB="$EXPORT_DB" db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$EXPORT_DB" -Fc' >"$dump"
chmod 600 "$dump"
"${dev[@]}" exec -T db pg_restore --list <"$dump" | grep 'TABLE DATA' >/dev/null || die "$dump failed the read check"
is_copy_started=
ls -l "$dump"
shasum -a 256 "$dump"
echo "differences from the working database (expected: vectors left out, users and grades 0):"
diff "$OUT_DIR/counts-working-$stamp.tsv" "$OUT_DIR/counts-export-$stamp.tsv" || true
