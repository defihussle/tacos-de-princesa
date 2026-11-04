#!/bin/sh
# Optional deploy command for preview (non-production) builds in Workers
# Builds, in place of `npx wrangler preview`:
#   sh scripts/deploy-preview.sh
# Deploys the Preview, passing the commit in as BUILD_COMMIT (shown by
# /api/health). If CLOVER_PRIVATE_TOKEN is set as a build variable
# (Settings > Build > Variables and secrets), it's then uploaded to this
# Preview as a runtime secret, which creates one more deployment.
set -eu

commit="${WORKERS_CI_COMMIT_SHA:-unknown}"
# The Preview's name is its branch. Workers Builds may check out a commit
# rather than the branch, so name it explicitly when the build says which.
set --
if [ -n "${WORKERS_CI_BRANCH:-}" ]; then
  set -- --name "$WORKERS_CI_BRANCH"
fi
echo "deploy-preview: commit $commit, branch ${WORKERS_CI_BRANCH:-(from git)}"
npx wrangler preview "$@" --var "BUILD_COMMIT:$commit"

if [ -n "${CLOVER_PRIVATE_TOKEN:-}" ]; then
  # Outside the repo: the repo root is published as the website
  secrets="$(mktemp)"
  trap 'rm -f "$secrets"' EXIT
  printf 'CLOVER_PRIVATE_TOKEN=%s\n' "$CLOVER_PRIVATE_TOKEN" > "$secrets"
  echo "deploy-preview: uploading the CLOVER_PRIVATE_TOKEN build variable as a Preview secret"
  npx wrangler preview secret bulk "$secrets" "$@"
else
  echo "deploy-preview: no CLOVER_PRIVATE_TOKEN build variable; the Preview keeps the secrets it already has"
fi
