#!/usr/bin/env bash
set -euo pipefail

number='(0|[1-9][0-9]*)'
prerelease="($number|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
build='[0-9A-Za-z-]+'
pattern="^$number\.$number\.$number(-$prerelease(\.$prerelease)*)?(\+$build(\.$build)*)?$"

if [[ ${GITHUB_EVENT_NAME:-} == push ]]; then
  case ${GITHUB_REF:-} in
    refs/tags/desktop-v*) target=desktop ;;
    refs/tags/web-v*) target=web ;;
    refs/tags/v*) target=full ;;
    *) target=unknown ;;
  esac
  if [[ $target == unknown && ${1:-} != --target ]]; then target=full; fi
else
  target=${REQUESTED_RELEASE_TARGET:-full}
fi
case $target in
  full) tag_prefix=v tag_notes=docs/releases suites='["types","web","cli","tui-project","tui-runtime"]' ;;
  desktop) tag_prefix=desktop-v tag_notes=docs/releases/desktop suites='["types","cli","tui-project","tui-runtime"]' ;;
  web) tag_prefix=web-v tag_notes=docs/releases/web suites='["types","web"]' ;;
  *) echo 'Invalid release target' >&2; exit 1 ;;
esac
if [[ ${GITHUB_EVENT_NAME:-} == push ]]; then
  prefix=$tag_prefix notes_dir=$tag_notes
else
  prefix=v notes_dir=docs/releases
fi

if [[ ${1:-} == --target ]]; then
  printf 'target=%s\nsuites=%s\n' "$target" "$suites" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [[ ${1:-} == --verify-tag ]]; then
  ref=${GITHUB_REF:-}
  [[ ${GITHUB_EVENT_NAME:-} == push && $ref == "refs/tags/$prefix"* && ${ref#"refs/tags/$prefix"} =~ $pattern && ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a version tag push with a commit SHA' >&2; exit 1; }
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
    [[ $ref == "$prefix"* ]] || { echo 'Invalid release version' >&2; exit 1; }
    version=${ref#"$prefix"}
  else
    version=$(printf '%s\n' "$notes_dir"/v*.md | sed -e 's#.*/v##' -e 's#\.md$##' | sort -V | tail -n 1)
  fi
fi

[[ $version =~ $pattern ]] || { echo 'Invalid release version' >&2; exit 1; }
if [[ ${GITHUB_EVENT_NAME:-} == push && ${GITHUB_REF:-} != "refs/tags/$prefix$version" ]]; then
  echo 'Release version does not match the pushed tag' >&2
  exit 1
fi
notes="$notes_dir/v$version.md"
[[ -f $notes && -s $notes ]] || { printf 'Missing or empty release notes: %s\n' "$notes" >&2; exit 1; }
printf 'RELEASE_VERSION=%s\nYCODING_VERSION=%s\n' "$version" "$version" >> "$GITHUB_ENV"
