#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }

main_checkout() {
  [[ ${GITHUB_EVENT_NAME:-} == workflow_dispatch && ${GITHUB_REF:-} == refs/heads/main &&
     ${GITHUB_REF_PROTECTED:-} == true && ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a protected main dispatch'
  [[ $(git rev-parse HEAD) == "$GITHUB_SHA" ]] || fail 'Checkout does not match the release SHA'
}

sha256() { shasum -a 256 <"$1" | cut -d ' ' -f 1; }

identity() {
  jq -nc --arg repo "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" --arg version "$RELEASE_VERSION" \
    --arg run "$1" --arg checksums "$2" '
      {repository:$repo, workflow:".github/workflows/release.yml", ref:"refs/heads/main", sha:$sha,
       event:"workflow_dispatch", attempt:1, version:$version, run:$run, checksums:$checksums}'
}

case "${1:-}" in
  stage)
    main_checkout
    [[ $GITHUB_RUN_ATTEMPT == 1 ]] || fail 'Only the first staging attempt can be promoted'
    [[ -z ${PUBLISH_STAGED_RUN_ID:-}${PUBLISH_CHECKSUMS:-} && ${PROMOTE_LATEST:-false} == false ]] || fail 'A promotion is not a staging run'
    identity "$GITHUB_RUN_ID" "$(sha256 "release/ycoding-$RELEASE_VERSION-checksums.txt")" > "$2"
    ;;
  control)
    main_checkout
    [[ $(git rev-parse refs/remotes/origin/main) == "$GITHUB_SHA" ]] || fail 'Protected main no longer points at the release SHA'
    endpoint="repos/$GITHUB_REPOSITORY/environments/release-production"
    [[ ${RELEASE_REVIEWER_ID:-} =~ ^[1-9][0-9]*$ ]] || fail 'The approved release reviewer ID is required'
    gh api "$endpoint" | jq -e --arg reviewer "$RELEASE_REVIEWER_ID" '
      .name == "release-production" and .can_admins_bypass == false and
      .deployment_branch_policy == {protected_branches:false, custom_branch_policies:true} and
      ([.protection_rules[] | select(.type == "required_reviewers")] |
        length == 1 and (.[0] | .prevent_self_review == false and
         (.reviewers | length == 1 and (.[0] | .type == "User" and (.reviewer.id | tostring) == $reviewer))))
    ' >/dev/null || fail 'release-production must require a decision from the sole approved reviewer and disallow administrator bypass'
    gh api "$endpoint/deployment-branch-policies?per_page=100" | jq -e '
      .total_count == 1 and (.branch_policies | length) == 1 and
      (.branch_policies[0] | .name == "main" and .type == "branch")
    ' >/dev/null || fail 'Restrict release-production to the main branch only'
    ;;
  artifacts)
    main_checkout
    [[ ${VERIFIED_STAGE_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || fail 'A verified stage run ID is required'
    artifacts=$(gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/actions/runs/$VERIFIED_STAGE_RUN_ID/artifacts?per_page=100")
    outputs=$(jq -er --arg version "$RELEASE_VERSION" --arg run "$VERIFIED_STAGE_RUN_ID" --arg sha "$GITHUB_SHA" '
      [.[].artifacts[]] as $all |
      def id($name): [$all[] | select(.name == $name)] |
        if length == 1 and (.[0] | .expired == false and (.id | type == "number") and
          (.digest | test("^sha256:[0-9a-f]{64}$")) and (.workflow_run.id | tostring) == $run and .workflow_run.head_sha == $sha)
        then .[0].id | tostring else error("Missing or invalid original artifact: " + $name) end;
      "archives=" + id("release-archive-darwin-arm64") + "," + id("release-archive-desktop-darwin-arm64"),
      "checksums=" + id("release-checksums-" + $version),
      "stage=" + id("release-stage-" + $version),
      "web=" + id("verified-web")
    ' <<< "$artifacts") || fail 'Original staging artifacts are missing, ambiguous or expired'
    printf '%s\n' "$outputs" >> "$GITHUB_OUTPUT"
    ;;
  verify)
    main_checkout
    [[ $(sha256 "checksums/ycoding-$RELEASE_VERSION-checksums.txt") == "$VERIFIED_STAGE_CHECKSUMS" ]] || fail 'Checksum manifest digest does not match the promotion input'
    jq -e --argjson expected "$(identity "$VERIFIED_STAGE_RUN_ID" "$VERIFIED_STAGE_CHECKSUMS")" '. == $expected' stage/identity.json >/dev/null || fail 'Stage identity does not match the requested promotion'
    test -s apps/web/dist/index.html && test -s apps/web/dist/_bun/index.html || fail 'Missing staged Rust or Bun Web entry point'
    bun script/release-archive.ts finalize "$RELEASE_VERSION" archives release
    cmp "checksums/ycoding-$RELEASE_VERSION-checksums.txt" "release/ycoding-$RELEASE_VERSION-checksums.txt" || fail 'Staged archives, LICENSE or NOTICE differ from the manifest'
    ;;
  signatures)
    payload=$(mktemp -d "$RUNNER_TEMP/release-signatures.XXXXXX")
    trap 'rm -rf -- "$payload"' EXIT
    mkdir "$payload/native" "$payload/desktop" "$payload/inner"
    tar -xf "release/ycoding-$RELEASE_VERSION-darwin-arm64.tar.gz" -C "$payload/native"
    tar -xf "release/YCoding-Desktop-v$RELEASE_VERSION-darwin-arm64.zip" -C "$payload/desktop"
    pin=9dd524184b0db949ffac7f0ada0ae860ac7f5f85
    codesign --verify --strict -R "=identifier \"app.ycoding.cli\" and certificate leaf = H\"$pin\"" "$payload/native/ycoding-native"
    codesign --verify --deep --strict -R "=identifier \"app.ycoding.interaction\" and certificate leaf = H\"$pin\"" "$payload/native/YCoding Interaction.app"
    app="$payload/desktop/YCoding Desktop.app"
    requirement="=identifier \"app.ycoding.desktop\" and certificate leaf = H\"$pin\""
    codesign --verify --deep --strict -R "$requirement" "$app"
    resources="$app/Contents/Resources"
    hash=$(jq -er '.hash | select(test("^[a-z0-9]+$"))' "$resources/metadata.json")
    tar -xf "$resources/$hash.tar.zst" -C "$payload/inner"
    codesign --verify --deep --strict -R "$requirement" "$payload/inner/YCoding Desktop.app"
    ;;
  *) fail 'Use stage, control, artifacts, verify or signatures' ;;
esac
