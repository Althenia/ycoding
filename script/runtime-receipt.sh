#!/usr/bin/env bash
set -euo pipefail

profile=${RECEIPT_PROFILE:-dev}
schema=ycoding.debug-runtime.receipt/1
command="cargo build --locked --manifest-path rust/Cargo.toml -p ycoding-runtime --bin ycoding-runtime"
binary_name=ycoding-runtime
policy=(CARGO_INCREMENTAL CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_TARGET_DIR CC CXX CFLAGS CXXFLAGS RUSTUP_TOOLCHAIN)

fail() {
  echo "$profile runtime receipt: $*" >&2
  exit 1
}

case "$profile" in
  dev) ;;
  release)
    schema=ycoding.release-runtime.receipt/1
    command="cargo build --message-format=json-render-diagnostics --locked --manifest-path rust/Cargo.toml --release -p ycoding-runtime --bin ycoding-runtime"
    policy+=(AWS_LC_SYS_PREBUILT_NASM)
    ;;
  *) fail "RECEIPT_PROFILE must be dev or release" ;;
esac

digest() {
  set -e
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

host_target() {
  set -e
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo darwin-arm64 ;;
    Linux-x86_64) echo linux-x64 ;;
    MINGW64_NT-*-x86_64 | MSYS_NT-*-x86_64) echo windows-x64 ;;
    *) fail "unsupported host $(uname -s)-$(uname -m)" ;;
  esac
}

identity() {
  set -e
  local target sdk="" sdk_build="" cc="" cxx="" msvc="" rustc_version cargo_version protoc=""
  target="$(host_target)"
  case "$target" in
    darwin-*)
      sdk="$(xcrun --show-sdk-version)"
      sdk_build="$(xcrun --show-sdk-build-version)"
      cc="$(clang --version | sed -n 1p)"
      cxx="$(clang++ --version | sed -n 1p)"
      ;;
    windows-x64)
      msvc="$(powershell -NoProfile -NonInteractive -Command '
        $ErrorActionPreference = "Stop"
        $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
        $installation = & $vswhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (!$installation) { throw "MSVC x64 tools are not installed" }
        (Get-Content -LiteralPath (Join-Path $installation "VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt") -Raw).Trim()
      ' | tr -d '\r')"
      test -n "$msvc" || fail "MSVC version is unavailable"
      ;;
    *)
      cc="$(cc --version | sed -n 1p)"
      cxx="$(c++ --version | sed -n 1p)"
      ;;
  esac
  if [ -n "${PROTOC:-}" ]; then protoc="$("$PROTOC" --version | tr -d '\r')"; fi
  rustc_version="$(rustc -vV | tr -d '\r')"
  cargo_version="$(cargo -V | tr -d '\r')"
  if [ "$target" = windows-x64 ]; then
    grep -Fxq 'host: x86_64-pc-windows-msvc' <<<"$rustc_version" || fail "Windows receipts require the native x64 MSVC Rust toolchain"
  fi
  jq -S -c -n \
    --arg target "$target" \
    --arg image_os "${ImageOS:-}" \
    --arg image_version "${ImageVersion:-}" \
    --arg rustc "$rustc_version" \
    --arg cargo "$cargo_version" \
    --arg sdk "$sdk" \
    --arg sdk_build "$sdk_build" \
    --arg cc "$cc" \
    --arg cxx "$cxx" \
    --arg msvc "$msvc" \
    --arg protoc "$protoc" \
    --args \
    '{
      target: $target,
      image: {os: $image_os, version: $image_version},
      rustc: $rustc,
      cargo: $cargo,
      compilers: (if $target == "windows-x64" then {msvc: $msvc} elif ($target | startswith("darwin-")) then {sdk: $sdk, sdk_build: $sdk_build, cc: $cc, cxx: $cxx} else {cc: $cc, cxx: $cxx} end),
      protoc: (if $protoc == "" then null else $protoc end),
      environment: ([$ARGS.positional[] as $name | {($name): ($ENV[$name] // null)}] | add)
    }' "${policy[@]}"
}

catalog() {
  set -e
  local bundled="" snapshot
  if [ -n "${YCODING_BUNDLED_MODELS_PATH+set}" ]; then
    test -f "$YCODING_BUNDLED_MODELS_PATH" || fail "YCODING_BUNDLED_MODELS_PATH does not name a file"
    bundled="$(digest "$YCODING_BUNDLED_MODELS_PATH")"
  fi
  snapshot="$(digest packages/cli/script/models-dev.snapshot.json)"
  jq -S -c -n --arg snapshot "$snapshot" --arg bundled "$bundled" \
    '{snapshot_sha256: $snapshot, bundled_models_path: (if $bundled == "" then null else {sha256: $bundled} end)}'
}

require_run() {
  printf '%s\n' "${GITHUB_SHA:-}" | grep -Eqx '[0-9a-f]{40}' || fail "GITHUB_SHA must be a full commit SHA"
  test -n "${RELEASE_VERSION:-}" || fail "RELEASE_VERSION is required"
  case "${YCODING_CHANNEL:-}" in beta | latest) ;; *) fail "YCODING_CHANNEL must be beta or latest" ;; esac
  case "${RECEIPT_TARGET:-}" in
    darwin-arm64 | linux-x64) ;;
    windows-x64) binary_name=ycoding-runtime.exe ;;
    *) fail "RECEIPT_TARGET must be darwin-arm64, linux-x64 or windows-x64" ;;
  esac
  test "$RECEIPT_TARGET" = "$(host_target)" || fail "RECEIPT_TARGET $RECEIPT_TARGET does not match host $(host_target)"
}

expected() {
  set -e
  local binary=$1 toolchain catalog lock sha256 bytes
  toolchain="$(identity)"
  catalog="$(catalog)"
  lock="$(digest rust/Cargo.lock)"
  sha256="$(digest "$binary")"
  bytes="$(wc -c <"$binary" | tr -d ' ')"
  jq -S -c -n \
    --arg schema "$schema" \
    --arg commit "$GITHUB_SHA" \
    --arg version "$RELEASE_VERSION" \
    --arg channel "$YCODING_CHANNEL" \
    --arg target "$RECEIPT_TARGET" \
    --arg profile "$profile" \
    --arg command "$command" \
    --arg binary_name "$binary_name" \
    --argjson toolchain "$toolchain" \
    --argjson catalog "$catalog" \
    --arg lock "$lock" \
    --arg sha256 "$sha256" \
    --argjson bytes "$bytes" \
    '{schema: $schema, source: {commit: $commit}, version: $version, channel: $channel, target: $target, profile: $profile, command: $command, toolchain: $toolchain, catalog: $catalog, lock_sha256: $lock, binary: {name: $binary_name, sha256: $sha256, bytes: $bytes}}'
}

write() {
  local binary=$1 out=$2
  require_run
  test "$(basename "$binary")" = "$binary_name" || fail "expected $binary_name"
  test -f "$binary" && test ! -L "$binary" && test -x "$binary" || fail "$binary is not an executable regular file"
  test ! -e "$out" || fail "$out already exists"
  mkdir -p "$out"
  cp "$binary" "$out/$binary_name"
  expected "$out/$binary_name" >"$out/receipt.json"
  jq -r '"\(.profile) runtime target=\(.target) bytes=\(.binary.bytes) sha256=\(.binary.sha256)"' "$out/receipt.json"
}

verify() {
  local artifact=$1 destination=$2
  require_run
  test "$(basename "$destination")" = "$binary_name" || fail "expected destination $binary_name"
  test -d "$artifact" && test ! -L "$artifact" || fail "$artifact is not a directory"
  local name listing
  listing="$(cd "$artifact" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')"
  test "$listing" = "./receipt.json ./$binary_name " || fail "the artifact must contain exactly receipt.json and $binary_name"
  for name in receipt.json "$binary_name"; do
    test -f "$artifact/$name" && test ! -L "$artifact/$name" || fail "$name is not a regular file"
  done
  local receipt want mismatch directory staged
  receipt="$(jq -S -c 'if type == "object" then . else error("not an object") end' "$artifact/receipt.json" 2>/dev/null)" || fail "receipt.json is not a JSON object"
  want="$(expected "$artifact/$binary_name")"
  mismatch="$(jq -r -n --argjson receipt "$receipt" --argjson want "$want" '
    if ([$receipt | paths] | sort) != ([$want | paths] | sort) then "fields"
    else (first(("schema source version channel target profile command toolchain catalog lock_sha256 binary" | split(" "))[] | select($receipt[.] != $want[.])) // "")
    end')"
  test "$mismatch" != fields || fail "receipt fields differ from schema $schema"
  test -z "$mismatch" || fail "receipt $mismatch does not match this run"
  directory="$(dirname "$destination")"
  mkdir -p "$directory"
  staged="$(mktemp "$directory/.ycoding-runtime.XXXXXX")"
  cp "$artifact/$binary_name" "$staged"
  chmod 0755 "$staged"
  mv -f "$staged" "$destination"
  test -x "$destination" && test "$(digest "$destination")" = "$(jq -r .binary.sha256 <<<"$receipt")" || fail "installed runtime does not match the receipt"
  local descriptor=$profile
  if [ "$profile" = dev ]; then descriptor=debug; fi
  echo "verified $descriptor runtime target=$RECEIPT_TARGET bytes=$(jq -r .binary.bytes <<<"$receipt") sha256=$(jq -r .binary.sha256 <<<"$receipt")" >&2
  echo "$destination"
}

case "${1:-}" in
  identity) identity ;;
  write) test "$#" -eq 3 || fail "usage: write <binary> <out-directory>"; write "$2" "$3" ;;
  verify) test "$#" -eq 3 || fail "usage: verify <artifact-directory> <destination>"; verify "$2" "$3" ;;
  *) fail "usage: $0 identity | write <binary> <out-directory> | verify <artifact-directory> <destination>" ;;
esac
