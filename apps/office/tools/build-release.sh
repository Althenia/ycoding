#!/bin/sh
# Build a release artifact for the native desktop client.
#
# One command produces exactly one archive plus a checksum line, so the CI job and
# a developer's local build take the same path. The archive names and their layouts
# are a contract with script/install.sh; changing them here without changing the
# installer breaks every download.
#
# Usage:
#   build-release.sh --version 0.2.4 --target darwin-universal --outdir dist/office
#
# Targets:
#   darwin-universal  YCoding Office.app/ in a disk image, which is what a Mac user
#                     expects to mount and drag into Applications
#   linux-x64         ycoding-office plus ycoding-office.pck in a tar.gz
#   windows-x64       ycoding-office.exe plus ycoding-office.pck in a zip
#
# The macOS target needs macOS: it uses ditto and hdiutil, which have no
# equivalent elsewhere. The Linux and Windows targets build on any host.
#
# GODOT_BIN overrides the engine binary. It must be a Godot 4.7.x build with the
# matching export templates installed:
#   https://godotengine.org/download/archive/4.7.2-stable/

set -eu

here=$(cd "$(dirname "$0")" && pwd)
project=$(cd "$here/.." && pwd)

version=""
target=""
outdir=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --outdir) outdir=$2; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "build-release: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "build-release: $1" >&2
  exit 1
}

[ -n "$version" ] || fail "--version is required (for example --version 0.2.4)"
[ -n "$target" ] || fail "--target is required (darwin-universal, linux-x64 or windows-x64)"
[ -n "$outdir" ] || fail "--outdir is required"

# A release version the installer can parse. This accepts the same version shapes
# the release workflow accepts, because the workflow passes its resolved version
# straight to --version; a stricter rule here would reject a version CI allowed.
printf '%s\n' "$version" | grep -qxE '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?' ||
  fail "version '$version' is not a release version (expected MAJOR.MINOR.PATCH)"

case "$target" in
  darwin-universal|linux-x64|windows-x64) ;;
  *) fail "unknown target '$target'" ;;
esac

# ditto and hdiutil have no equivalent off macOS. Refusing before the project file
# is touched is clearer than a missing command partway through an export.
if [ "$target" = "darwin-universal" ] && [ "$(uname -s)" != "Darwin" ]; then
  fail "the darwin-universal target must be built on macOS (ditto and hdiutil are required)"
fi

godot=${GODOT_BIN:-}
if [ -z "$godot" ]; then
  for candidate in \
    /Applications/Godot.app/Contents/MacOS/Godot \
    "$(command -v godot 2>/dev/null || true)" \
    "$(command -v godot4 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      godot=$candidate
      break
    fi
  done
fi
[ -n "$godot" ] && [ -x "$godot" ] || fail "no Godot binary found; set GODOT_BIN"

# The engine must be the version the project pins. A different minor version
# exports against different templates and can silently produce a broken bundle.
engine=$("$godot" --version 2>/dev/null | head -n 1 | sed 's/\.stable.*//')
case "$engine" in
  4.7*) ;;
  *) fail "Godot $engine is not the pinned 4.7 release train; set GODOT_BIN to a 4.7.x build" ;;
esac

if [ -d "$outdir" ]; then
  outdir=$(cd "$outdir" && pwd)
else
  mkdir -p "$outdir"
  outdir=$(cd "$outdir" && pwd)
fi

# The version is read from the project at runtime, so the build must carry the
# version it claims. Substituting into project.godot is the only way to make a
# released build report the release it came from.
project_file="$project/project.godot"
original=$(cat "$project_file")

staging=$(mktemp -d)
restore() {
  printf '%s\n' "$original" >"$project_file"
  rm -rf "$staging"
}
trap restore EXIT INT TERM

printf '%s\n' "$original" |
  sed "s#^config/version=.*#config/version=\"$version\"#" >"$project_file"

# The project must resolve the version it will report, or the export ships a
# build whose identity does not match its filename.
grep -q "^config/version=\"$version\"\$" "$project_file" ||
  fail "could not set config/version in project.godot"

echo "build-release: exporting $target at $version"

case "$target" in
  darwin-universal)
    archive="$outdir/ycoding-office-$version-darwin-universal.dmg"
    payload="$staging/YCoding Office.app"
    # binary_format/architecture is universal in the preset, so one bundle covers
    # both Mac architectures.
    "$godot" --headless --path "$project" --export-release "macOS" "$payload" >/dev/null
    [ -d "$payload" ] || fail "the export produced no app bundle"

    # The bundle must report the version it was built with. A preset that ignores
    # the injected project version would ship an app whose identity disagrees with
    # its filename, and only the mounted bundle can answer this.
    reported=$(plutil -extract CFBundleShortVersionString raw -o - "$payload/Contents/Info.plist" 2>/dev/null || true)
    [ "$reported" = "$version" ] ||
      fail "the exported bundle reports version '$reported' instead of '$version'"

    # The drag-to-Applications affordance is what makes a disk image worth more
    # than a zip: the image carries the destination beside the app.
    ln -s /Applications "$staging/Applications"
    rm -f "$archive"
    hdiutil create -volname "YCoding Office" -srcfolder "$staging" -ov -format UDZO "$archive" >/dev/null ||
      fail "could not create the disk image"
    ;;
  linux-x64)
    archive="$outdir/ycoding-office-$version-linux-x64.tar.gz"
    payload="$staging/ycoding-office"
    "$godot" --headless --path "$project" --export-release "Linux" "$payload" >/dev/null
    [ -f "$payload" ] || fail "the export produced no Linux binary"
    # Godot writes the data pack beside the binary; the client needs both.
    if [ ! -f "$staging/ycoding-office.pck" ]; then
      [ -f "$payload.pck" ] || fail "the export produced no data pack beside the binary"
      mv "$payload.pck" "$staging/ycoding-office.pck"
    fi
    chmod +x "$payload"
    tar -C "$staging" -czf "$archive" ycoding-office ycoding-office.pck
    ;;
  windows-x64)
    archive="$outdir/ycoding-office-$version-windows-x64.zip"
    payload="$staging/ycoding-office.exe"
    "$godot" --headless --path "$project" --export-release "Windows Desktop" "$payload" >/dev/null
    [ -f "$payload" ] || fail "the export produced no Windows binary"
    if [ ! -f "$staging/ycoding-office.pck" ]; then
      [ -f "$payload.pck" ] || fail "the export produced no data pack beside the binary"
      mv "$payload.pck" "$staging/ycoding-office.pck"
    fi
    (cd "$staging" && zip -q "$archive" ycoding-office.exe ycoding-office.pck)
    ;;
esac

[ -f "$archive" ] || fail "no archive was produced"

# One checksum line, in the same format the CLI release uses, so the installer can
# verify either with the same code. The tool is chosen up front: a fallback after
# the fact would not run, because awk succeeds on the empty input of a missing
# sha256 tool and silently yields an empty hash.
if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  sum=$(shasum -a 256 "$archive" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required to checksum the archive"
fi
name=$(basename "$archive")
[ -n "$sum" ] || fail "could not checksum $name"
printf '%s  %s\n' "$sum" "$name" >"$outdir/ycoding-office-$version-checksums.txt"

echo "build-release: wrote $name ($(wc -c <"$archive" | tr -d ' ') bytes)"
echo "build-release: sha256 $sum"
