#!/usr/bin/env bash
# CI side of a deploy: sends the tag over SSH. On the server the key's command= runs deploy-entry.sh, which takes it from
# there; the client names a tag and nothing else.
# Reads DEPLOY_SSH_KEY, DEPLOY_HOST, DEPLOY_USER and DEPLOY_KNOWN_HOSTS from the environment.
set -euo pipefail

tag=${1:?usage: remote-deploy.sh <tag>}

[[ "$tag" =~ ^sha-[0-9a-f]{40}$ ]] || { echo "::error::tag must look like sha-<full commit>" >&2; exit 1; }
: "${DEPLOY_SSH_KEY:?}" "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_KNOWN_HOSTS:?}"

ssh_dir=$(mktemp -d)
trap 'rm -rf "$ssh_dir"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" >"$ssh_dir/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$ssh_dir/known_hosts"
chmod 600 "$ssh_dir/key"

# Keepalives instead of a command timeout: a slow pull or dump is fine, a dead connection is not. The job timeout is the
# cap. -F /dev/null: no ssh config of the runner may add another key or a forwarding.
ssh -F /dev/null -i "$ssh_dir/key" \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$ssh_dir/known_hosts" \
  -o ConnectTimeout=20 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=6 \
  "$DEPLOY_USER@$DEPLOY_HOST" "$tag"
