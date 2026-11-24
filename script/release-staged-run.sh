#!/usr/bin/env bash
set -euo pipefail

commit=$(git rev-parse "$GITHUB_SHA^{commit}")
source_type=${1:-tag}
fail() { printf '%s\n' "$1" >&2; exit 1; }

case "$source_type" in
  tag)
    if [[ $(git cat-file -t "$GITHUB_REF") != tag || $(git rev-parse "$GITHUB_REF^{commit}") != "$commit" ]]; then
      fail 'Publication requires an annotated release tag on the staged commit'
    fi
    subject=$(git for-each-ref --format='%(contents:subject)' "$GITHUB_REF")
    pattern='^Verified release run ([1-9][0-9]*) checksums ([0-9a-f]{64})$'
    [[ $subject =~ $pattern ]] || fail 'Tag annotation must identify the verified release run and checksums digest'
    run_id=${BASH_REMATCH[1]}
    checksums=${BASH_REMATCH[2]}
    ;;
  main)
    [[ ${GITHUB_EVENT_NAME:-} == workflow_dispatch && $GITHUB_REF == refs/heads/main &&
       ${GITHUB_REF_PROTECTED:-} == true && $GITHUB_SHA == "$commit" && $(git rev-parse HEAD) == "$commit" ]] ||
      fail 'Expected a protected main dispatch on the exact release SHA'
    [[ ${REQUESTED_RELEASE_VERSION:-} == "$RELEASE_VERSION" && -n $RELEASE_VERSION &&
       $RELEASE_VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || fail 'Specify an exact stable release version'
    [[ ${PUBLISH_STAGED_RUN_ID:-} =~ ^[1-9][0-9]*$ && ${PUBLISH_CHECKSUMS:-} =~ ^[0-9a-f]{64}$ &&
       ${PROMOTE_LATEST:-} =~ ^(true|false)$ && $PUBLISH_STAGED_RUN_ID != "$GITHUB_RUN_ID" ]] || fail 'Promotion needs a distinct staging run ID and lowercase SHA-256 checksum manifest digest'
    test -s "docs/releases/v$RELEASE_VERSION.md" || fail 'Release notes are missing or empty'
    run_id=$PUBLISH_STAGED_RUN_ID
    checksums=$PUBLISH_CHECKSUMS
    ;;
  *) fail 'Expected a tag or main staging source' ;;
esac

gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" | jq --exit-status \
  --arg repo "$GITHUB_REPOSITORY" --arg sha "$commit" --arg source "$source_type" --arg run "$run_id" '
  .event == "workflow_dispatch" and .path == ".github/workflows/release.yml" and
  .head_repository.full_name == $repo and .head_sha == $sha and
  .run_attempt == 1 and .status == "completed" and .conclusion == "success" and
  ($source == "tag" or ((.id | tostring) == $run and .repository.full_name == $repo and .head_branch == "main"))
' >/dev/null || fail 'Staging run does not match the verified release source'
printf 'run-id=%s\nchecksums=%s\n' "$run_id" "$checksums" >> "$GITHUB_OUTPUT"
