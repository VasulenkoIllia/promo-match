#!/usr/bin/env bash
# Rolls the environment out to an image already pulled by deploy-entry.sh, which also holds the deploy lock and keeps
# this script running if its SSH session dies. Runs from <env dir>/release/deploy. The server is shared: this script
# touches only its own compose project, its own files and old images of this repository, and never uses prune,
# `down -v` or anything host-wide.
#
#   deploy.sh <sha-tag> [--skip-migrate]
set -euo pipefail
umask 077

readonly PROJECT=promo-match
readonly IMAGE_REPO=ghcr.io/vasulenkoillia/promo-match
readonly READY_TIMEOUT_SECONDS=120
readonly DB_READY_TIMEOUT_SECONDS=90
# HNSW indexes of a new embeddings model are built by a migration (docs/deployment.md, «Нотатки до міграцій»)
readonly MIGRATE_TIMEOUT_SECONDS=1800
readonly DUMP_TIMEOUT_SECONDS=1800
readonly CATEGORIES_TIMEOUT_SECONDS=600
readonly ROUTE_CHECK_ATTEMPTS=10
readonly ROUTE_CHECK_DELAY_SECONDS=2
readonly IMAGES_TO_KEEP=5
# A dump of the catalogue with its vectors is about 2 GB: three before-deploy copies are enough to go back
readonly DUMPS_TO_KEEP=3
# The disk is shared: a dump that fills it stops every other project on the host
readonly MIN_FREE_MB=2048

tag=${1:?usage: deploy.sh <tag> [--skip-migrate]}
skip_migrate=${2:-}

env_dir=$(cd "$(dirname "$0")/../.." && pwd)
env_file=$env_dir/.env
tag_file=$env_dir/current_tag
previous_tag_file=$env_dir/previous_tag
compose_file=$env_dir/release/docker-compose.yml

step=start
is_reported=
say() { step=$1; printf '\n== %s\n' "$1"; }
die() { is_reported=true; echo "deploy: $1" >&2; exit 1; }
# Only lines like these reach the public log of the GitHub run (deploy-entry.sh): a command that fails under errexit
# without die still names its step there, the details stay in deploy.log
trap 'code=$?; [ "$code" -eq 0 ] || [ -n "$is_reported" ] ||
  echo "deploy: step «$step» failed with exit $code, the details are in deploy.log on the server" >&2' EXIT

# The project name is explicit in every call: without it compose derives one from the folder and starts a second,
# empty database next to the real one.
compose_command=(docker compose --project-name "$PROJECT" --env-file "$env_file")

compose() {
  IMAGE_TAG=$tag "${compose_command[@]}" -f "$compose_file" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

check_env_file() {
  local name
  for name in APP_NAME APP_DOMAIN TRAEFIK_NETWORK POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
    [ -n "$(env_value "$name")" ] || die "$env_file must set $name"
  done
  docker network inspect "$(env_value TRAEFIK_NETWORK)" >/dev/null 2>&1 || die "docker network $(env_value TRAEFIK_NETWORK) not found"
}

# The live container is the truth about what runs; the file is the fallback when nothing healthy runs
running_tag() {
  local image
  image=$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=app" \
    --filter "health=healthy" \
    --format '{{.Image}}' | head -n 1)
  if [ -n "$image" ]; then
    echo "${image##*:}"
  elif [ -f "$tag_file" ]; then
    cat "$tag_file"
  fi
}

start_db() {
  compose up -d --no-deps --wait --wait-timeout "$DB_READY_TIMEOUT_SECONDS" db
}

ensure_free_space() {
  local dump_dir=$1 bytes=0 newest needed_mb free_mb
  # shellcheck disable=SC2012 # our own timestamped names without spaces
  newest=$(ls -1t "$dump_dir"/*.dump 2>/dev/null | head -n 1 || true)
  [ -z "$newest" ] || bytes=$(wc -c <"$newest")
  needed_mb=$((bytes * 2 / 1048576 + MIN_FREE_MB))
  free_mb=$(df -Pk "$dump_dir" | awk 'NR == 2 { print int($4 / 1024) }')
  [ "$free_mb" -ge "$needed_mb" ] || die "only $free_mb MB free for the dump, $needed_mb MB needed"
}

# Written as .part and named only after the read check: a failed dump must neither stay among the kept ones nor push a
# good one out of the rotation
dump_database() {
  local dump_dir=$env_dir/backups dump part
  mkdir -p "$dump_dir"
  rm -f "$dump_dir"/predeploy-*.part
  ensure_free_space "$dump_dir"
  dump=$dump_dir/predeploy-$(date +%Y%m%d-%H%M%S)-$tag.dump
  part=$dump.part
  # IMAGE_TAG: compose reads the whole file, the image line too, even for an exec into db. timeout cannot run the
  # compose() function, hence the variable here.
  # shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
  if ! IMAGE_TAG=$tag timeout "$DUMP_TIMEOUT_SECONDS" "${compose_command[@]}" -f "$compose_file" exec -T db \
    sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$part"; then
    rm -f "$part"
    die "pg_dump failed, nothing changed"
  fi
  # grep without -q reads to the end: stopping at the first match would kill pg_restore with SIGPIPE under pipefail
  if ! compose exec -T db pg_restore --list <"$part" | grep 'TABLE DATA' >/dev/null; then
    rm -f "$part"
    die "the dump failed the read check, nothing changed"
  fi
  mv "$part" "$dump"
  echo "dump: $dump ($(wc -c <"$dump") bytes)"
  # shellcheck disable=SC2012 # our own timestamped names without spaces; keeps the newest dumps
  ls -1t "$dump_dir"/predeploy-*.dump | tail -n +$((DUMPS_TO_KEEP + 1)) | while read -r old_dump; do
    rm -f "$old_dump"
  done
}

# Outside any `if`, and strict about the answer: a failed check must stop the deploy, not read as an empty database
# and let a migration run without a dump.
dump_unless_empty() {
  local count
  # shellcheck disable=SC2016 # $POSTGRES_* expand inside the db container, on purpose
  count=$(compose exec -T db sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from pg_tables where schemaname = '\''public'\''"') ||
    die "could not read the database, refusing to go on without a dump"
  [[ "$count" =~ ^[0-9]+$ ]] || die "unexpected table count: $count"
  if [ "$count" -gt 0 ]; then
    dump_database
  else
    echo "empty database: nothing to dump"
  fi
}

# A timeout, because a migration stuck on a lock would hold the deploy lock for good. The running version keeps
# serving meanwhile: the app container is replaced only after this.
migrate() {
  IMAGE_TAG=$tag timeout "$MIGRATE_TIMEOUT_SECONDS" "${compose_command[@]}" -f "$compose_file" run --rm migrate ||
    die "migration failed or took over $MIGRATE_TIMEOUT_SECONDS s: see «Коли міграція впала» in docs/deployment.md"
}

# The shared categories come from files of the image (src/categories/*.json): a release that changed them must write
# them before it serves filters, or a filter by a new category answers 400. A second run changes nothing. A plan that
# would remove over 20% stops here, before the app is replaced: then the owner runs it by hand with --allow-mass-removal.
sync_categories() {
  IMAGE_TAG=$tag timeout "$CATEGORIES_TIMEOUT_SECONDS" "${compose_command[@]}" -f "$compose_file" \
    run --rm --no-deps -e WORKER=categories worker ||
    die "categories sync failed, $tag was not started: see «Ручні задачі» in docs/deployment.md"
}

# `--wait` follows the container healthcheck, which calls /ready, and fails as soon as it turns unhealthy
start_app() {
  compose up -d --no-deps --wait --wait-timeout "$READY_TIMEOUT_SECONDS" app
}

roll_back_to() {
  local previous_tag=$1 log=$env_dir/failed-start.log
  # Into a file: this output reaches the CI log, and application logs do not belong there
  compose logs --tail 100 app >"$log" 2>&1 || true
  echo "application log of the failed start: $log" >&2
  [ -n "$previous_tag" ] || die "$tag is not ready and there is no previous version to return to"
  say "Returning to $previous_tag"
  tag=$previous_tag
  [ ! -f "$env_dir/release.prev/docker-compose.yml" ] || compose_file=$env_dir/release.prev/docker-compose.yml
  start_app || die "$previous_tag did not become ready either: the app is down"
  die "new version was not ready, $previous_tag is running again"
}

record_release() {
  local previous_tag=$1
  [ -z "$previous_tag" ] || [ "$previous_tag" = "$tag" ] || echo "$previous_tag" >"$previous_tag_file"
  echo "$tag" >"$tag_file"
  : >"$env_dir/release/.live"
}

# `image rm` refuses an image a container runs, which is what we want here, so its failures are not errors
remove_old_images() {
  local kept_tags
  kept_tags=$(cat "$tag_file" "$previous_tag_file" 2>/dev/null || true)
  docker image ls --format '{{.CreatedAt}} {{.Repository}}:{{.Tag}}' "$IMAGE_REPO" |
    sort -r |
    awk '{print $NF}' |
    grep ':sha-' |
    tail -n +$((IMAGES_TO_KEEP + 1)) |
    while read -r old_image; do
      grep -qxF "${old_image##*:}" <<<"$kept_tags" && continue
      docker image rm "$old_image" >/dev/null 2>&1 || echo "keeping $old_image"
    done
}

# A healthy container says nothing about Traefik: a wrong label or a clash on Host gives 404 behind a green deploy.
# Traefik needs a few seconds to pick the container up.
check_route() {
  local domain code=000
  domain=$(env_value APP_DOMAIN)
  for _ in $(seq 1 "$ROUTE_CHECK_ATTEMPTS"); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$domain:443:127.0.0.1" \
      "https://$domain/health" || true)
    [ "$code" != 200 ] || return 0
    sleep "$ROUTE_CHECK_DELAY_SECONDS"
  done
  # Without the domain: this line reaches the public log of the GitHub run
  die "$tag runs, but Traefik answers $code for APP_DOMAIN: check the labels and the DNS record"
}

main() {
  check_env_file
  local previous_tag
  previous_tag=$(running_tag)
  echo "new: $tag, running: ${previous_tag:-none}"

  say "Database"
  # The dump comes first: `up` applies this release's db settings and may recreate the container
  [ -n "$(compose ps --status running --quiet db)" ] || start_db
  dump_unless_empty
  start_db || die "db did not start with the settings of $tag; to return: ${previous_tag:-none} --skip-migrate"

  # A return to an older tag skips both: its migrations are in already, and its older category files would undo newer ones
  if [ "$skip_migrate" = "--skip-migrate" ]; then
    say "Migrations and categories skipped"
  else
    say "Migrations"
    migrate
    say "Categories"
    sync_categories
  fi

  say "Starting $tag"
  start_app || roll_back_to "$previous_tag"

  record_release "$previous_tag"
  remove_old_images
  if [ -n "$previous_tag" ] && [ "$previous_tag" != "$tag" ]; then
    echo "to return: send '$previous_tag --skip-migrate' with the deploy key"
  fi

  say "Traefik"
  check_route
  say "Done: runs $tag"
}

main
