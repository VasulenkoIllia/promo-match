#!/usr/bin/env bash
# CI gate: every commit in the range has the expected author and no co-author.
#
#   check-commits.sh <expected author emails> <base sha or empty> <head sha>
#
# The emails are separated by spaces: the owner's git email and the noreply address GitHub writes on merges and squashes
# made through its site or API. The check stays on merge commits: anyone else's merge still fails.
#
# An empty, all-zero or unknown base (first push, force push) checks the whole history of head.
set -euo pipefail

expected_emails=${1:-}
base=${2:-}
head=${3:?usage: check-commits.sh <email> <base> <head>}

[ -n "$expected_emails" ] || { echo "::error::repository variable COMMIT_AUTHOR_EMAIL is not set" >&2; exit 1; }

if [[ "$base" =~ ^0*$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  range=$head
else
  range=$base..$head
fi

failed=false
checked=0
while read -r commit; do
  checked=$((checked + 1))
  author=$(git show -s --format=%ae "$commit")
  if [[ " $expected_emails " != *" $author "* ]]; then
    echo "::error::$commit has another author"
    failed=true
  fi
  if git show -s --format=%B "$commit" | grep -qi '^co-authored-by:'; then
    echo "::error::$commit has a Co-authored-by trailer"
    failed=true
  fi
done < <(git rev-list "$range")

echo "checked $checked commits in $range"
[ "$failed" = false ]
