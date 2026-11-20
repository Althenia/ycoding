#!/usr/bin/env bash
set -euo pipefail

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

pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ $version =~ $pattern ]] || { echo 'Invalid release version' >&2; exit 1; }
printf 'RELEASE_VERSION=%s\nYCODING_VERSION=%s\n' "$version" "$version" >> "$GITHUB_ENV"
