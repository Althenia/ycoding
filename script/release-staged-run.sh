#!/usr/bin/env bash
set -euo pipefail

commit=$(git rev-parse "$GITHUB_SHA^{commit}")
if [[ $(git cat-file -t "$GITHUB_REF") != tag || $(git rev-parse "$GITHUB_REF^{commit}") != "$commit" ]]; then
  echo 'Publication requires an annotated release tag on the staged commit' >&2
  exit 1
fi
subject=$(git for-each-ref --format='%(contents:subject)' "$GITHUB_REF")
pattern='^Verified release run ([1-9][0-9]*) checksums ([0-9a-f]{64})$'
if [[ ! $subject =~ $pattern ]]; then
  echo 'Tag annotation must identify the verified release run and checksums digest' >&2
  exit 1
fi
run_id=${BASH_REMATCH[1]}
checksums=${BASH_REMATCH[2]}

gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" | jq --exit-status \
  --arg repo "$GITHUB_REPOSITORY" --arg sha "$commit" '
  .event == "workflow_dispatch" and .path == ".github/workflows/release.yml" and
  .head_repository.full_name == $repo and .head_sha == $sha and
  .run_attempt == 1 and .status == "completed" and .conclusion == "success"
' >/dev/null
printf 'run-id=%s\nchecksums=%s\n' "$run_id" "$checksums" >> "$GITHUB_OUTPUT"
