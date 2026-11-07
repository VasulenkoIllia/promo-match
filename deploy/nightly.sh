#!/usr/bin/env bash
# The nightly catalogue job, on the deploy user's cron: the import of the suppliers read every day (without Macma and
# Easy Gifts: those only by hand with --only), then the embeddings of what the import added. Runs the image that is
# live now, through the worker service of its compose file.
#
# Installed by hand into <environment folder>-deploy, like deploy-entry.sh, and never updated by a release: it runs on
# the shared host with access to Docker, so a new image must not be able to change it (docs/deployment.md, «Розклад»).
#
#   nightly.sh             import, then embeddings (paid: each run stops at EMBED_BUDGET_USD of .env)
#   nightly.sh --dry-run   both plans and the cost at list prices, no writes and no paid calls
#
# Two runs of one source never overlap anyway: the import and the embeddings each keep a lease in the database
# (src/import/lock.ts, src/embeddings/lease.ts). The locks here keep the import away from a deploy, whose migrations
# would wait for its transactions while the search stands still.
set -euo pipefail
umask 077
export LC_ALL=C
# Cron's PATH stops at /usr/bin:/bin. Set here, not in the crontab: a PATH line there changes other projects' jobs too.
export PATH=$PATH:/usr/local/bin

readonly PROJECT=promo-match
# Above the worst case of a deploy, which holds the lock: see the timeout of the deploy job in ci.yml
readonly LOCK_WAIT_SECONDS=3600
readonly IMPORT_TIMEOUT_SECONDS=10800
readonly EMBED_TIMEOUT_SECONDS=21600
# The worker stops between requests on SIGTERM and exits within 30 s (src/worker.ts)
readonly STOP_GRACE_SECONDS=45

mode=${1:-}
if [ -n "$mode" ] && [ "$mode" != --dry-run ]; then
  echo "usage: nightly.sh [--dry-run]" >&2
  exit 64
fi

deploy_dir=$(cd "$(dirname "$0")" && pwd)
env_dir=${deploy_dir%-deploy}
if [ "$env_dir" = "$deploy_dir" ] || [ ! -f "$env_dir/.env" ]; then echo "nightly: no environment next to $deploy_dir" >&2; exit 78; fi

say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) nightly: $1"; }

# A run that is still going (a slow night) makes the next one wait for tomorrow, not start a second import
exec 8>"$env_dir/.nightly.lock"
flock -n 8 || { say "the previous run is still going, skipped"; exit 0; }

[ -s "$env_dir/current_tag" ] || { say "FAILED: nothing is deployed yet (no current_tag)" >&2; exit 1; }
tag=$(cat "$env_dir/current_tag")
[[ "$tag" =~ ^sha-[0-9a-f]{40}$ ]] || { say "FAILED: current_tag holds no image tag" >&2; exit 1; }
compose=(docker compose --project-name "$PROJECT" --env-file "$env_dir/.env" -f "$env_dir/release/docker-compose.yml")

# A named container, so a job that ran out of time is stopped for sure: killing the compose client alone could leave
# it running without anyone watching
run_job() {
  local job=$1 seconds=$2 container=$PROJECT-nightly-$1 code=0
  shift 2
  docker rm -f "$container" >/dev/null 2>&1 || true
  # -T and stdin from /dev/null: timeout puts compose in a background process group, and a run that attaches the
  # terminal is then stopped by SIGTTIN, holding .deploy.lock (a dry run by hand hung so on 2026-11-07). Cron has none.
  IMAGE_TAG=$tag timeout --kill-after=60 "$seconds" "${compose[@]}" run --rm --no-deps -T --name "$container" \
    -e "WORKER=$job" worker node dist/main.js "$@" </dev/null || code=$?
  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
    say "$job ran out of $seconds s, stopping it" >&2
    docker stop -t "$STOP_GRACE_SECONDS" "$container" >/dev/null 2>&1 || true
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  return "$code"
}

failed=false
say "start, image $tag${mode:+, $mode}"

exec 9>"$env_dir/.deploy.lock"
if flock -w "$LOCK_WAIT_SECONDS" 9; then
  run_job import "$IMPORT_TIMEOUT_SECONDS" ${mode:+"$mode"} || { code=$?; failed=true; say "import failed, exit $code" >&2; }
else
  failed=true
  say "a deploy held the lock for $LOCK_WAIT_SECONDS s, import skipped" >&2
fi
# The embeddings neither change the schema nor hold long transactions: a deploy may go on meanwhile
exec 9>&-

# Also after a failed import: the sources that did import still get their vectors
run_job embed "$EMBED_TIMEOUT_SECONDS" ${mode:+"$mode"} || { code=$?; failed=true; say "embeddings failed, exit $code" >&2; }

if [ "$failed" = true ]; then
  say "FAILED, see above"
  exit 1
fi
say "done"
