#!/usr/bin/env bash
# CI only (job clean-images): keeps the newest tagged versions of the image package in GHCR and deletes the older tagged
# ones. Plain API calls instead of actions/delete-package-versions, which still targets Node 20 and has no newer release
# (owner's decision 2026-11-07); the same endpoints as that action. The image of the running commit is never deleted.
#
# Untagged versions are never touched: today each push is one tagged Docker manifest (checked 2026-11-07), but an image
# index would list its platform manifests as untagged versions, and deleting one of a kept image breaks its pull. An
# orphan left by a deleted index only takes space.
#
#   clean-images.sh <package> <versions to keep> <tag of this run>     with GH_TOKEN and GITHUB_REPOSITORY_OWNER set
set -euo pipefail
export LC_ALL=C

package=${1:?usage: clean-images.sh <package> <keep> <tag>}
keep=${2:?usage: clean-images.sh <package> <keep> <tag>}
current_tag=${3:?usage: clean-images.sh <package> <keep> <tag>}
if ! [[ "$keep" =~ ^[1-9][0-9]*$ ]]; then
  echo "clean-images: the number to keep is a positive integer" >&2
  exit 64
fi
versions="/users/${GITHUB_REPOSITORY_OWNER:?}/packages/container/${package}/versions"

# id, creation time, tags, newest first: ISO 8601 times in UTC sort as text
all=$(gh api --paginate "${versions}?per_page=100" \
  --jq '.[] | [.id, .created_at, ((.metadata.container.tags // []) | join(","))] | @tsv' | sort -t $'\t' -k2,2r)
list=$(printf '%s\n' "$all" | awk -F '\t' 'NF && $3 != ""')
total=$(printf '%s\n' "$list" | grep -c . || true)
untagged=$(printf '%s\n' "$all" | awk -F '\t' 'NF && $3 == ""' | grep -c . || true)
echo "clean-images: ${total} tagged versions, keeping the newest ${keep}; ${untagged} untagged left as they are"

deleted=0
while IFS=$'\t' read -r id created tags; do
  [ -n "$id" ] || continue
  if ! [[ "$id" =~ ^[0-9]+$ ]]; then
    echo "clean-images: unexpected version id '${id}', stopped" >&2
    exit 1
  fi
  if [[ ",${tags}," == *",${current_tag},"* ]]; then
    echo "clean-images: kept ${id}, the image of this run"
    continue
  fi
  echo "clean-images: deleting ${id} (${created}, tags: ${tags:-none})"
  gh api --method DELETE "${versions}/${id}" >/dev/null
  deleted=$((deleted + 1))
done < <(printf '%s\n' "$list" | tail -n +"$((keep + 1))")
echo "clean-images: deleted ${deleted}"
