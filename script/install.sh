#!/bin/sh

set -eu

repository="Althenia/ycoding"
install_dir="$HOME/.local/bin"
temporary=
candidate=
helper_candidate=
app_candidate=
binary_backup=
helper_backup=
app_backup=
install_transaction=false
binary_backed_up=false
helper_backed_up=false
app_backed_up=false
binary_installed=false
helper_installed=false
app_installed=false

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  set +e
  if [ "$install_transaction" = true ]; then
    restore_status=0
    if [ "$binary_installed" = true ] || [ "$binary_backed_up" = true ]; then
      rm -f "$install_dir/ycoding" || restore_status=1
    fi
    if [ "$helper_installed" = true ] || [ "$helper_backed_up" = true ]; then
      rm -f "$install_dir/ycoding-computer-helper" || restore_status=1
    fi
    if [ "$app_installed" = true ] || [ "$app_backed_up" = true ]; then
      rm -rf "$install_dir/ycoding-computer-helper.app" || restore_status=1
    fi
    if [ "$binary_backed_up" = true ]; then
      if mv -f "$binary_backup" "$install_dir/ycoding"; then
        binary_backed_up=false
        binary_backup=
      else
        printf 'ycoding installer: YCoding executable backup retained at %s\n' "$binary_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/ycoding" >&2
        restore_status=1
      fi
    fi
    if [ "$helper_backed_up" = true ]; then
      if mv -f "$helper_backup" "$install_dir/ycoding-computer-helper"; then
        helper_backed_up=false
        helper_backup=
      else
        printf 'ycoding installer: Computer helper backup retained at %s\n' "$helper_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/ycoding-computer-helper" >&2
        restore_status=1
      fi
    fi
    if [ "$app_backed_up" = true ]; then
      if mv -f "$app_backup" "$install_dir/ycoding-computer-helper.app"; then
        app_backed_up=false
        app_backup=
      else
        printf 'ycoding installer: Computer helper app backup retained at %s\n' "$app_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/ycoding-computer-helper.app" >&2
        restore_status=1
      fi
    fi
    if [ "$restore_status" -ne 0 ]; then
      printf 'ycoding installer: Failed to restore the previously installed release\n' >&2
      status=1
    fi
  fi
  if [ -n "$candidate" ]; then rm -f "$candidate"; fi
  if [ -n "$helper_candidate" ]; then rm -f "$helper_candidate"; fi
  if [ -n "$app_candidate" ]; then rm -rf "$app_candidate"; fi
  if [ -n "$binary_backup" ] && [ "$binary_backed_up" = false ]; then rm -f "$binary_backup"; fi
  if [ -n "$helper_backup" ] && [ "$helper_backed_up" = false ]; then rm -f "$helper_backup"; fi
  if [ -n "$app_backup" ] && [ "$app_backed_up" = false ]; then rm -rf "$app_backup"; fi
  if [ -n "$temporary" ]; then rm -rf "$temporary"; fi
  exit "$status"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

fail() {
  printf 'ycoding installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

# An unknown argument fails rather than being ignored, because silently accepting
# a misspelled flag would install less than the user asked for.
while [ "$#" -gt 0 ]; do
  case "$1" in
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

version=${YCODING_VERSION:-}
if [ -z "$version" ]; then
  latest_url=$(curl --proto '=https' --proto-redir '=https' -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest") ||
    fail "Failed to resolve the latest release"
  case "$latest_url" in
    "https://github.com/$repository/releases/tag/v"*) version=${latest_url##*/v} ;;
    *) fail "GitHub returned an invalid latest release URL" ;;
  esac
fi

printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' ||
  fail "Invalid YCoding version: $version"

case "$(uname -s)" in
  Darwin) operating_system=darwin ;;
  Linux) operating_system=linux ;;
  *) fail "Unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) architecture=arm64 ;;
  x86_64 | amd64) architecture=x64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

target="$operating_system-$architecture"
case "$target" in
  darwin-arm64 | darwin-x64 | linux-x64) ;;
  *) fail "Unsupported platform: $target" ;;
esac

asset="ycoding-$version-$target.tar.gz"
checksums="ycoding-$version-checksums.txt"
release_url="https://github.com/$repository/releases/download/v$version"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-install.XXXXXX") || fail "Failed to create a temporary directory"

# Download the release asset and verify it against the release checksum file.
fetch_verified() {
  file=$1
  curl --proto '=https' --proto-redir '=https' --max-filesize 536870912 -fsSL -o "$temporary/$file" "$release_url/$file" ||
    fail "Failed to download $file"
  [ "$(wc -c < "$temporary/$file")" -le 536870912 ] || fail "Download is too large: $file"
  expected=$(awk -v wanted="$file" '
    ($2 == wanted || $2 == "*" wanted) {
      if (found) exit 2
      print $1
      found = 1
    }
    END { if (!found) exit 1 }
  ' "$temporary/$checksums") || fail "Checksum file does not contain exactly one entry for $file"
  printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "Checksum file contains an invalid SHA256 value"

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary/$file" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$temporary/$file" | awk '{ print $1 }')
  else
    fail "sha256sum or shasum is required"
  fi
  [ "$actual" = "$expected" ] || fail "Checksum verification failed for $file"
}

curl --proto '=https' --proto-redir '=https' --max-filesize 1048576 -fsSL -o "$temporary/$checksums" "$release_url/$checksums" || fail "Failed to download $checksums"
[ "$(wc -c < "$temporary/$checksums")" -le 1048576 ] || fail "Checksum file is too large"
fetch_verified "$asset"

# The first bundled macOS release is 0.7.1; prereleases of that version
# precede it, while prereleases of later versions follow it.
app_required=false
if [ "$operating_system" = darwin ]; then
  version_core=${version%%+*}
  prerelease=false
  case "$version_core" in *-*) prerelease=true ;; esac
  if printf '%s\n' "${version_core%%-*}" | awk -F . -v prerelease="$prerelease" '
    $1 > 0 || ($1 == 0 && ($2 > 7 || ($2 == 7 && ($3 > 1 || ($3 == 1 && prerelease == "false"))))) { found=1 }
    END { exit !found }
  '; then app_required=true; fi
fi

tar -tzf "$temporary/$asset" >"$temporary/entries" || fail "Failed to inspect $asset"
entries=$(LC_ALL=C sort "$temporary/entries")
expected_entries=ycoding
if [ "$operating_system" = "darwin" ]; then
  expected_entries=$(printf '%s\n' ycoding ycoding-computer-helper | LC_ALL=C sort)
  if [ "$app_required" = true ]; then
    expected_entries=$(printf '%s\n' ycoding ycoding-computer-helper \
      ycoding-computer-helper.app/ \
      ycoding-computer-helper.app/Contents/ \
      ycoding-computer-helper.app/Contents/Info.plist \
      ycoding-computer-helper.app/Contents/MacOS/ \
      ycoding-computer-helper.app/Contents/MacOS/ycoding-computer-helper \
      ycoding-computer-helper.app/Contents/Resources/ \
      ycoding-computer-helper.app/Contents/Resources/YCoding.icns \
      ycoding-computer-helper.app/Contents/_CodeSignature/ \
      ycoding-computer-helper.app/Contents/_CodeSignature/CodeResources | LC_ALL=C sort)
  fi
fi
[ "$entries" = "$expected_entries" ] || fail "Release archive has invalid direct entries"
# Check types and advertised uncompressed sizes before writing extracted files.
tar -tvzf "$temporary/$asset" >"$temporary/details" || fail "Failed to inspect archive entry types"
awk '
  substr($1, 1, 1) == "d" { next }
  { size = $3 ~ /^[0-9]+$/ ? $3 : $5 }
  substr($1, 1, 1) != "-" || size !~ /^[0-9]+$/ || size < 1 || size > 536870912 { exit 1 }
  { total += size; if (total > 536870912) exit 1 }
' "$temporary/details" || fail "Release archive has invalid entry types or sizes"
awk '{ print substr($1, 1, 1) }' "$temporary/details" >"$temporary/types" || fail "Failed to inspect archive entry types"
paste "$temporary/entries" "$temporary/types" | while IFS="$(printf '\t')" read -r entry type; do
  case "$entry" in
    */) [ "$type" = d ] || exit 1 ;;
    *) [ "$type" = - ] || exit 1 ;;
  esac
done || fail "Release archive has invalid entry types"
mkdir "$temporary/extract"
tar -xzf "$temporary/$asset" -C "$temporary/extract" || fail "Failed to extract $asset"
[ -f "$temporary/extract/ycoding" ] && [ ! -L "$temporary/extract/ycoding" ] && [ -s "$temporary/extract/ycoding" ] ||
  fail "Release archive did not contain a regular ycoding executable"
if [ "$operating_system" = "darwin" ]; then
  [ -f "$temporary/extract/ycoding-computer-helper" ] && [ ! -L "$temporary/extract/ycoding-computer-helper" ] && [ -s "$temporary/extract/ycoding-computer-helper" ] ||
    fail "Release archive did not contain a regular computer helper"
fi
if [ "$app_required" = true ]; then
  app="$temporary/extract/ycoding-computer-helper.app"
  for directory in "$app" "$app/Contents" "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/_CodeSignature"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || fail "Release archive contains an invalid computer helper app directory"
  done
  for file in "$app/Contents/Info.plist" "$app/Contents/MacOS/ycoding-computer-helper" "$app/Contents/Resources/YCoding.icns" "$app/Contents/_CodeSignature/CodeResources"; do
    [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || fail "Release archive contains an invalid computer helper app file"
  done
  grep -Fq '<key>CFBundleIdentifier</key><string>app.ycoding.computer-helper</string>' "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid bundle identifier"
  grep -Fq '<key>CFBundleDisplayName</key><string>YCoding Computer Use</string>' "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid display name"
  grep -Fq '<key>CFBundleIconFile</key><string>YCoding.icns</string>' "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid icon reference"
  /usr/bin/codesign --verify --deep --strict "$app" || fail "Computer helper app signature verification failed"
fi

mkdir -p "$install_dir"
[ -d "$install_dir" ] && [ ! -L "$install_dir" ] && [ -O "$install_dir" ] || fail "Install directory must be an owned directory"
for existing_file in "$install_dir/ycoding" "$install_dir/ycoding-computer-helper"; do
  if [ -e "$existing_file" ] || [ -L "$existing_file" ]; then
    [ -f "$existing_file" ] && [ ! -L "$existing_file" ] && [ -O "$existing_file" ] || fail "Installed executable must be an owned regular file: $existing_file"
  fi
done
candidate=$(mktemp "$install_dir/.ycoding.XXXXXX") || fail "Failed to create an install candidate"
cp "$temporary/extract/ycoding" "$candidate" || fail "Failed to prepare the ycoding executable"
chmod 755 "$candidate" || fail "Failed to make the ycoding executable runnable"
if [ "$operating_system" = "darwin" ]; then
  helper_candidate=$(mktemp "$install_dir/.ycoding-computer-helper.XXXXXX") || fail "Failed to create a computer helper install candidate"
  cp "$temporary/extract/ycoding-computer-helper" "$helper_candidate" || fail "Failed to prepare the computer helper"
  chmod 755 "$helper_candidate" || fail "Failed to make the computer helper runnable"
  if [ "$app_required" = true ]; then
    app_candidate=$(mktemp -d "$install_dir/.ycoding-computer-helper-app.XXXXXX") || fail "Failed to create an app install candidate"
    cp -R "$app/." "$app_candidate/" || fail "Failed to prepare the computer helper app"
    if [ -e "$install_dir/ycoding-computer-helper.app" ] || [ -L "$install_dir/ycoding-computer-helper.app" ]; then
      [ -d "$install_dir/ycoding-computer-helper.app" ] && [ ! -L "$install_dir/ycoding-computer-helper.app" ] && [ -O "$install_dir/ycoding-computer-helper.app" ] || fail "Installed computer helper app must be an owned directory"
      app_backup=$(mktemp -d "$install_dir/.ycoding-computer-helper-app-backup.XXXXXX") || fail "Failed to reserve the app rollback path"
      rmdir "$app_backup" || fail "Failed to prepare the app rollback path"
    fi
  fi

  if [ -e "$install_dir/ycoding" ] || [ -L "$install_dir/ycoding" ]; then
    binary_backup=$(mktemp "$install_dir/.ycoding-backup.XXXXXX") || fail "Failed to reserve the ycoding rollback path"
    rm -f "$binary_backup" || fail "Failed to prepare the ycoding rollback path"
  fi
  if [ -e "$install_dir/ycoding-computer-helper" ] || [ -L "$install_dir/ycoding-computer-helper" ]; then
    helper_backup=$(mktemp "$install_dir/.ycoding-computer-helper-backup.XXXXXX") || fail "Failed to reserve the computer helper rollback path"
    rm -f "$helper_backup" || fail "Failed to prepare the computer helper rollback path"
  fi

  install_transaction=true
  if [ -n "$binary_backup" ]; then
    mv -f "$install_dir/ycoding" "$binary_backup" || fail "Failed to preserve the installed ycoding executable"
    binary_backed_up=true
  fi
  if [ -n "$helper_backup" ]; then
    mv -f "$install_dir/ycoding-computer-helper" "$helper_backup" || fail "Failed to preserve the installed computer helper"
    helper_backed_up=true
  fi
  if [ -n "$app_backup" ]; then
    mv -f "$install_dir/ycoding-computer-helper.app" "$app_backup" || fail "Failed to preserve the installed computer helper app"
    app_backed_up=true
  fi
  mv -f "$helper_candidate" "$install_dir/ycoding-computer-helper" || fail "Failed to install the computer helper"
  helper_installed=true
  helper_candidate=
  if [ "$app_required" = true ]; then
    mv -f "$app_candidate" "$install_dir/ycoding-computer-helper.app" || fail "Failed to install the computer helper app"
    app_installed=true
    app_candidate=
  fi
fi
mv -f "$candidate" "$install_dir/ycoding" || fail "Failed to install ycoding"
binary_installed=true
candidate=
install_transaction=false
if [ -n "$binary_backup" ]; then rm -f "$binary_backup"; fi
if [ -n "$helper_backup" ]; then rm -f "$helper_backup"; fi
if [ -n "$app_backup" ]; then rm -rf "$app_backup"; fi
binary_backup=
helper_backup=
app_backup=

printf 'Installed ycoding %s to %s/ycoding\n' "$version" "$install_dir"

case ":${PATH:-}:" in
  *":$install_dir:"*) exit 0 ;;
esac

path_line='export PATH="$HOME/.local/bin:$PATH"'
shell_name=${SHELL:-}
shell_name=${shell_name##*/}
case "$shell_name" in
  zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$operating_system" = "darwin" ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
    ;;
  sh | dash | ksh) profile="$HOME/.profile" ;;
  *)
    if [ -n "$shell_name" ]; then
      printf 'Add $HOME/.local/bin to PATH in your %s shell configuration, then restart your shell.\n' "$shell_name"
      exit 0
    fi
    printf 'Add $HOME/.local/bin to PATH in your shell configuration, then restart your shell.\n'
    exit 0
    ;;
esac

profile_has_install_dir() {
  [ -f "$profile" ] && awk -v home="$HOME" '
    /^[[:space:]]*#/ { next }
    ($0 ~ /(^|[[:space:];])(export[[:space:]]+)?PATH[[:space:]]*=/) &&
      (index($0, "$HOME/.local/bin") || index($0, "${HOME}/.local/bin") || index($0, home "/.local/bin")) {
      found = 1
    }
    END { exit !found }
  ' "$profile"
}

if ! profile_has_install_dir; then
  if [ -s "$profile" ]; then
    last_character=$(tail -c 1 "$profile" 2>/dev/null || true)
    if [ -n "$last_character" ]; then printf '\n' >>"$profile"; fi
  fi
  printf '%s\n' "$path_line" >>"$profile"
  printf 'Added $HOME/.local/bin to PATH in %s. Restart your shell to use ycoding.\n' "$profile"
  exit 0
fi

printf '$HOME/.local/bin is already configured in %s. Restart your shell to use ycoding.\n' "$profile"
