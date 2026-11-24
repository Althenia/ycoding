#!/usr/bin/env bash
set -euo pipefail

number='(0|[1-9][0-9]*)'
prerelease="($number|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
build='[0-9A-Za-z-]+'
pattern="^$number\.$number\.$number(-$prerelease(\.$prerelease)*)?(\+$build(\.$build)*)?$"

if [[ ${1:-} == --verify-tag ]]; then
  ref=${GITHUB_REF:-}
  [[ ${GITHUB_EVENT_NAME:-} == push && $ref == refs/tags/v* && ${ref#refs/tags/v} =~ $pattern && ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a version tag push with a commit SHA' >&2; exit 1; }
  [[ $(git rev-parse HEAD) == "$GITHUB_SHA" ]] || { echo 'Checkout does not match the release commit' >&2; exit 1; }
  depth=()
  if [[ $(git rev-parse --is-shallow-repository) == true ]]; then depth+=(--unshallow); fi
  git fetch --atomic --no-tags --refmap= ${depth[@]+"${depth[@]}"} origin refs/heads/main:refs/remotes/origin/main "$ref:$ref"
  [[ $(git rev-parse --verify "$ref^{commit}") == "$GITHUB_SHA" ]] || { echo 'Fetched tag does not point to the release commit' >&2; exit 1; }
  git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main || { echo 'Release commit is not reachable from origin/main' >&2; exit 1; }
  exit 0
fi

version=${REQUESTED_RELEASE_VERSION:-}
if [[ -z $version ]]; then
  if [[ ${RELEASE_REF_TYPE:-} == tag ]]; then
    ref=${RELEASE_REF_NAME:-}
    [[ $ref == v* ]] || { echo 'Invalid release version' >&2; exit 1; }
    version=${ref#v}
  else
    version=$(printf '%s\n' docs/releases/v*.md | sed -e 's#.*/v##' -e 's#\.md$##' | sort -V | tail -n 1)
  fi
fi

[[ $version =~ $pattern ]] || { echo 'Invalid release version' >&2; exit 1; }
if [[ ${GITHUB_EVENT_NAME:-} == push && ${GITHUB_REF:-} != "refs/tags/v$version" ]]; then
  echo 'Release version does not match the pushed tag' >&2
  exit 1
fi
notes="docs/releases/v$version.md"
[[ -f $notes && -s $notes ]] || { printf 'Missing or empty release notes: %s\n' "$notes" >&2; exit 1; }
printf 'RELEASE_VERSION=%s\nYCODING_VERSION=%s\n' "$version" "$version" >> "$GITHUB_ENV"
