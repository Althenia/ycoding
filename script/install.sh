#!/bin/sh

set -eu

repository="Althenia/ycoding"
install_dir="$HOME/.local/bin"
receipt="$install_dir/.ycoding-native-release"
temporary=
candidate=
receipt_candidate=
helper_candidate=
app_candidate=
binary_backup=
receipt_backup=
helper_backup=
app_backup=
legacy_app_backup=
computer_use_backup=
legacy_helper_backup=
app_name=
app_executable=ycoding-computer-helper
helper_required=true
bundle_id=app.ycoding.computer-helper
legacy_app=ycoding-computer-helper.app
computer_use_app="YCoding Computer Use.app"
legacy_helper=ycoding-computer-helper
extension_name=ycoding-chrome-extension
extension_files="icons/ycoding-128.png icons/ycoding-16.png icons/ycoding-32.png icons/ycoding-48.png manifest.json popup.css popup.html popup.js protocol.js service-worker.js"
extension_required=false
extension_candidate=
extension_backup=
install_transaction=false
binary_backed_up=false
receipt_backed_up=false
helper_backed_up=false
app_backed_up=false
legacy_app_backed_up=false
legacy_helper_backed_up=false
extension_backed_up=false
extension_installed=false
binary_installed=false
receipt_installed=false
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
    if [ "$receipt_installed" = true ]; then
      rm -f "$receipt" || restore_status=1
    fi
    if [ "$helper_installed" = true ] || [ "$helper_backed_up" = true ]; then
      rm -f "$install_dir/$legacy_helper" || restore_status=1
    fi
    if [ "$app_installed" = true ] || [ "$app_backed_up" = true ]; then
      rm -rf "$install_dir/$app_name" || restore_status=1
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
    if [ "$receipt_backed_up" = true ]; then
      if mv -f "$receipt_backup" "$receipt"; then
        receipt_backed_up=false
        receipt_backup=
      else
        printf 'ycoding installer: Native release receipt backup retained at %s\n' "$receipt_backup" >&2
        restore_status=1
      fi
    fi
    if [ "$helper_backed_up" = true ]; then
      if mv -f "$helper_backup" "$install_dir/$legacy_helper"; then
        helper_backed_up=false
        helper_backup=
      else
        printf 'ycoding installer: Computer helper backup retained at %s\n' "$helper_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/$legacy_helper" >&2
        restore_status=1
      fi
    fi
    if [ "$app_backed_up" = true ]; then
      if mv -f "$app_backup" "$install_dir/$app_name"; then
        app_backed_up=false
        app_backup=
      else
        printf 'ycoding installer: Computer helper app backup retained at %s\n' "$app_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/$app_name" >&2
        restore_status=1
      fi
    fi
    if [ "$legacy_app_backed_up" = true ]; then
      if mv -f "$legacy_app_backup" "$install_dir/$legacy_app"; then
        legacy_app_backed_up=false
        legacy_app_backup=
      else
        printf 'ycoding installer: Computer helper app backup retained at %s\n' "$legacy_app_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/$legacy_app" >&2
        restore_status=1
      fi
    fi
    if [ "$extension_installed" = true ] || [ "$extension_backed_up" = true ]; then
      rm -rf "$install_dir/$extension_name" || restore_status=1
    fi
    if [ -n "$computer_use_backup" ] && [ -d "$computer_use_backup/$computer_use_app" ]; then
      if ! mv -f "$computer_use_backup/$computer_use_app" "$install_dir/$computer_use_app"; then
        printf 'ycoding installer: Computer Use app backup retained at %s\n' "$computer_use_backup/$computer_use_app" >&2
        restore_status=1
      fi
    fi
    if [ "$extension_backed_up" = true ]; then
      if mv -f "$extension_backup" "$install_dir/$extension_name"; then
        extension_backed_up=false
        extension_backup=
      else
        printf 'ycoding installer: Chrome extension backup retained at %s\n' "$extension_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/$extension_name" >&2
        restore_status=1
      fi
    fi
    if [ "$legacy_helper_backed_up" = true ]; then
      if mv -f "$legacy_helper_backup" "$install_dir/$legacy_helper"; then
        legacy_helper_backed_up=false
        legacy_helper_backup=
      else
        printf 'ycoding installer: Computer helper backup retained at %s\n' "$legacy_helper_backup" >&2
        printf 'ycoding installer: Move that backup to %s before retrying\n' "$install_dir/$legacy_helper" >&2
        restore_status=1
      fi
    fi
    if [ "$restore_status" -ne 0 ]; then
      printf 'ycoding installer: Failed to restore the previously installed release\n' >&2
      status=1
    fi
  fi
  if [ -n "$candidate" ]; then rm -f "$candidate"; fi
  if [ -n "$receipt_candidate" ]; then rm -f "$receipt_candidate"; fi
  if [ -n "$helper_candidate" ]; then rm -f "$helper_candidate"; fi
  if [ -n "$app_candidate" ]; then rm -rf "$app_candidate"; fi
  if [ -n "$binary_backup" ] && [ "$binary_backed_up" = false ]; then rm -f "$binary_backup"; fi
  if [ -n "$receipt_backup" ] && [ "$receipt_backed_up" = false ]; then rm -f "$receipt_backup"; fi
  if [ -n "$helper_backup" ] && [ "$helper_backed_up" = false ]; then rm -f "$helper_backup"; fi
  if [ -n "$app_backup" ] && [ "$app_backed_up" = false ]; then rm -rf "$app_backup"; fi
  if [ -n "$legacy_app_backup" ] && [ "$legacy_app_backed_up" = false ]; then rm -rf "$legacy_app_backup"; fi
  if [ -n "$computer_use_backup" ] && [ ! -e "$computer_use_backup/$computer_use_app" ]; then rmdir "$computer_use_backup"; fi
  if [ -n "$legacy_helper_backup" ] && [ "$legacy_helper_backed_up" = false ]; then rm -f "$legacy_helper_backup"; fi
  if [ -n "$extension_candidate" ]; then rm -rf "$extension_candidate"; fi
  if [ -n "$extension_backup" ] && [ "$extension_backed_up" = false ]; then rm -rf "$extension_backup"; fi
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

replace_bun=${YCODING_REPLACE_BUN:-}
# An unknown argument fails rather than being ignored, because silently accepting
# a misspelled flag would install less than the user asked for.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace-bun) replace_bun=1 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

valid_version() {
  LC_ALL=C awk '
    NR == 1 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/ { valid = 1 }
    END { exit !(NR == 1 && valid) }
  '
}

uses_native_layout() {
  printf '%s\n' "${1%%[-+]*}" | LC_ALL=C awk -F . '
    $1 > 0 || ($1 == 0 && $2 >= 13) { native = 1 }
    END { exit !native }
  '
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || return 1
  else
    return 1
  fi
  printf '%s\n' "${digest%% *}"
}

installed_native() {
  [ -d "$install_dir" ] && [ ! -L "$install_dir" ] && [ -O "$install_dir" ] &&
    [ -f "$install_dir/ycoding" ] && [ ! -L "$install_dir/ycoding" ] && [ -O "$install_dir/ycoding" ] &&
    [ -f "$receipt" ] && [ ! -L "$receipt" ] && [ -O "$receipt" ] || return 1
  [ "$(wc -c < "$receipt")" -le 512 ] && [ "$(wc -l < "$receipt")" -eq 1 ] || return 1
  IFS= read -r record < "$receipt" || return 1
  installed_version=${record%% *}
  expected_digest=${record#* }
  printf '%s\n' "$installed_version" | valid_version && uses_native_layout "$installed_version" &&
    printf '%s\n' "$expected_digest" | grep -Eq '^[a-f0-9]{64}$' &&
    [ "$(sha256 "$install_dir/ycoding")" = "$expected_digest" ] || return 1
  [ "$(wc -c < "$receipt")" -eq "$((${#installed_version} + 66))" ]
}

stable_version() {
  LC_ALL=C awk '
    function token(   result) {
      while (1) {
        sub(/^[ \t\r]+/, "", line)
        if (line != "") break
        if ((getline line) <= 0) return ""
      }
      if (!match(line, /^([{}\[\],:]|true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?|"([^"\\\001-\037]|\\(["\\\/bfnrt]|u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]))*")/)) exit 1
      result = substr(line, 1, RLENGTH)
      line = substr(line, RLENGTH + 1)
      return result
    }
    function value(first, depth,   item) {
      if (depth > 64 || first == "") exit 1
      if (first == "{" || first == "[") {
        item = token()
        if (item == (first == "{" ? "}" : "]")) return
        while (1) {
          if (first == "{") {
            if (substr(item, 1, 1) != "\"" || token() != ":") exit 1
            item = token()
          }
          value(item, depth + 1)
          item = token()
          if (item == (first == "{" ? "}" : "]")) return
          if (item != ",") exit 1
          item = token()
        }
      }
      if (first ~ /^["0-9-]/ || first == "true" || first == "false" || first == "null") return
      exit 1
    }
    function compare(left, right,   a, b, i) {
      split(left, a, /[.+]/)
      split(right, b, /[.+]/)
      for (i = 1; i <= 3; i++) {
        if (length(a[i]) != length(b[i])) return length(a[i]) > length(b[i]) ? 1 : -1
        if ("v" a[i] != "v" b[i]) return "v" a[i] > "v" b[i] ? 1 : -1
      }
      return 0
    }
    function release(   key, item, tag, draft, prerelease, version, order) {
      while (1) {
        key = token()
        if (substr(key, 1, 1) != "\"" || key ~ /\\/ || token() != ":") exit 1
        item = token()
        if (key == "\"tag_name\"") {
          if (tag != "" || substr(item, 1, 1) != "\"") exit 1
          tag = item
        } else if (key == "\"draft\"") {
          if (draft != "" || item !~ /^(true|false)$/) exit 1
          draft = item
        } else if (key == "\"prerelease\"") {
          if (prerelease != "" || item !~ /^(true|false)$/) exit 1
          prerelease = item
        } else value(item, 1)
        item = token()
        if (item == "}") break
        if (item != ",") exit 1
      }
      if (tag == "" || draft == "" || prerelease == "") exit 1
      if (draft == "true" || prerelease == "true" || tag !~ /^"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?"$/) return
      version = substr(tag, 3, length(tag) - 3)
      order = best == "" ? 1 : compare(version, best)
      if (order > 0) { best = version; ambiguous = 0 }
      else if (order == 0) ambiguous = 1
    }
    BEGIN {
      if (token() != "[") exit 1
      item = token()
      while (1) {
        if (++releases > 20 || item != "{") exit 1
        release()
        item = token()
        if (item == "]") break
        if (item != ",") exit 1
        item = token()
      }
      if (token() != "" || best == "" || ambiguous) exit 1
      print best
    }
  ' "$1"
}

version=${YCODING_VERSION:-}
if [ -z "$version" ]; then
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-install.XXXXXX") || fail "Failed to create a temporary directory"
  status_code=$(curl --proto '=https' --proto-redir '=https' --max-filesize 2097152 -fsS -o "$temporary/releases" -w '%{http_code}' "https://api.github.com/repos/$repository/releases?per_page=20") ||
    fail "Failed to fetch the GitHub release list"
  [ "$status_code" = 200 ] && [ "$(wc -c < "$temporary/releases")" -le 2097152 ] || fail "Invalid GitHub release list response"
  version=$(stable_version "$temporary/releases") || fail "Invalid GitHub release list or no stable version found"
fi

printf '%s\n' "$version" | valid_version ||
  fail "Invalid YCoding version: $version"

binary=ycoding
if uses_native_layout "$version"; then
  binary=ycoding-native
  if [ "$replace_bun" != 1 ] && [ "$replace_bun" != true ]; then
    data="${XDG_DATA_HOME:-$HOME/.local/share}/ycoding"
    if { { [ -e "$install_dir/ycoding" ] || [ -L "$install_dir/ycoding" ]; } && ! installed_native; } ||
      { { [ -e "$data/ycoding.db" ] || [ -L "$data/ycoding.db" ]; } &&
        ! { [ -f "$data/core.redb" ] && [ ! -L "$data/core.redb" ] && [ -s "$data/core.redb" ] && [ -O "$data/core.redb" ]; }; }; then
      fail "An existing Bun or unrecognized installation was found. Set YCODING_VERSION=0.12.2 to stay on Bun, or pass --replace-bun to replace the executable without migrating data."
    fi
  fi
fi

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
if [ -z "$temporary" ]; then
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-install.XXXXXX") || fail "Failed to create a temporary directory"
fi

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

  actual=$(sha256 "$temporary/$file") || fail "Failed to compute the SHA256 value; sha256sum or shasum is required"
  [ "$actual" = "$expected" ] || fail "Checksum verification failed for $file"
}

curl --proto '=https' --proto-redir '=https' --max-filesize 1048576 -fsSL -o "$temporary/$checksums" "$release_url/$checksums" || fail "Failed to download $checksums"
[ "$(wc -c < "$temporary/$checksums")" -le 1048576 ] || fail "Checksum file is too large"
fetch_verified "$asset"

# The first bundled macOS release is 0.7.1; prereleases of that version
# precede it, while prereleases of later versions follow it.
app_required=false
version_core=${version%%+*}
interaction_layout=false
if printf '%s\n' "${version_core%%-*}" | awk -F . '
  $1 > 0 || ($1 == 0 && $2 >= 12) { found=1 }
  END { exit !found }
'; then
  interaction_layout=true
  extension_files="icons/active-16.png icons/active-32.png icons/idle-128.png icons/idle-16.png icons/idle-32.png icons/idle-48.png manifest.json panel.css panel.html panel.js popup.css popup.html popup.js service-worker.js"
fi
# Releases after 0.7.1, including their prereleases, include the Chrome extension.
if printf '%s\n' "${version_core%%-*}" | awk -F . '
  $1 > 0 || ($1 == 0 && ($2 > 7 || ($2 == 7 && $3 > 1))) { found=1 }
  END { exit !found }
'; then extension_required=true; fi
if [ "$operating_system" = darwin ]; then
  prerelease=false
  case "$version_core" in *-*) prerelease=true ;; esac
  if printf '%s\n' "${version_core%%-*}" | awk -F . -v prerelease="$prerelease" '
    $1 > 0 || ($1 == 0 && ($2 > 7 || ($2 == 7 && ($3 > 1 || ($3 == 1 && prerelease == "false"))))) { found=1 }
    END { exit !found }
  '; then app_required=true; fi
  # Releases after 0.7.1, including their prereleases, ship only the computer-use app;
  # its filename is its macOS privacy-settings display name.
  app_name=$legacy_app
  app_display_name="YCoding Computer Use"
  if printf '%s\n' "${version_core%%-*}" | awk -F . '
    $1 > 0 || ($1 == 0 && ($2 > 7 || ($2 == 7 && $3 > 1))) { found=1 }
    END { exit !found }
  '; then
    app_name=$computer_use_app
    app_executable=ycoding-computer-use
    helper_required=false
    bundle_id=app.ycoding.computer-use
  fi
  if [ "$interaction_layout" = true ]; then
    app_name="YCoding Interaction.app"
    app_display_name="YCoding Interaction"
    app_executable=ycoding-interaction
    bundle_id=app.ycoding.interaction
  fi
fi

tar -tzf "$temporary/$asset" >"$temporary/entries" || fail "Failed to inspect $asset"
tar -tvzf "$temporary/$asset" >"$temporary/details" || fail "Failed to inspect archive entry types"
[ "$(wc -l <"$temporary/entries")" -eq "$(wc -l <"$temporary/details")" ] || fail "Release archive has invalid entry names"
LC_ALL=C awk '
  { name = $0; sub(/\/$/, "", name) }
  name == "" || name ~ /^\// || name ~ /\/$/ || name ~ /\\/ || name ~ /[[:cntrl:]]/ || name ~ /(^|\/)\.\.?(\/|$)/ { bad = 1 }
  seen[name]++ { bad = 1 }
  END { exit bad || NR > 1024 }
' "$temporary/entries" || fail "Release archive has unsafe or duplicate entry names, or too many entries"
required_files=$binary
if [ "$operating_system" = "darwin" ]; then
  if [ "$helper_required" = true ]; then required_files=$(printf '%s\n' "$required_files" "$legacy_helper"); fi
  if [ "$app_required" = true ]; then
    required_files=$(printf '%s\n' "$required_files" \
      "$app_name/Contents/Info.plist" \
      "$app_name/Contents/MacOS/$app_executable" \
      "$app_name/Contents/Resources/YCoding.icns" \
      "$app_name/Contents/_CodeSignature/CodeResources")
  fi
fi
if [ "$extension_required" = true ]; then
  required_files=$({
    printf '%s\n' "$required_files"
    for file in $extension_files; do printf '%s\n' "$extension_name/$file"; done
  })
fi
printf '%s\n' "$required_files" >"$temporary/required"
if [ "$interaction_layout" = true ]; then
  awk 'NR == FNR {
    allowed[$0] = 1
    dir = $0
    while (sub(/\/[^\/]+$/, "", dir)) allowed[dir "/"] = 1
    next
  }
  !($0 in allowed) { exit 1 }
  ' "$temporary/required" "$temporary/entries" || fail "Release archive has unexpected entries"
fi
missing=$(while IFS= read -r file; do grep -Fx -- "$file" "$temporary/entries" >/dev/null || printf '%s ' "$file"; done <"$temporary/required")
[ -z "$missing" ] || fail "Release archive is missing required entries: $missing"
# Check types and advertised uncompressed sizes before writing extracted files.
awk '
  substr($1, 1, 1) == "d" { next }
  { size = $3 ~ /^[0-9]+$/ ? $3 : $5 }
  substr($1, 1, 1) != "-" || size !~ /^[0-9]+$/ || size > 536870912 { exit 1 }
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
tar -xzf "$temporary/$asset" -C "$temporary/extract" -T "$temporary/required" || fail "Failed to extract $asset"
binary_file="$temporary/extract/$binary"
[ -f "$binary_file" ] && [ ! -L "$binary_file" ] && [ -s "$binary_file" ] ||
  fail "Release archive did not contain a regular ycoding executable"
if [ "$operating_system" = "darwin" ] && [ "$helper_required" = true ]; then
  [ -f "$temporary/extract/$legacy_helper" ] && [ ! -L "$temporary/extract/$legacy_helper" ] && [ -s "$temporary/extract/$legacy_helper" ] ||
    fail "Release archive did not contain a regular computer helper"
fi
if [ "$app_required" = true ]; then
  app="$temporary/extract/$app_name"
  for directory in "$app" "$app/Contents" "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/_CodeSignature"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || fail "Release archive contains an invalid computer helper app directory"
  done
  for file in "$app/Contents/Info.plist" "$app/Contents/MacOS/$app_executable" "$app/Contents/Resources/YCoding.icns" "$app/Contents/_CodeSignature/CodeResources"; do
    [ -f "$file" ] && [ ! -L "$file" ] && [ -s "$file" ] || fail "Release archive contains an invalid computer helper app file"
  done
  grep -Fq "<key>CFBundleIdentifier</key><string>$bundle_id</string>" "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid bundle identifier"
  grep -Fq "<key>CFBundleDisplayName</key><string>$app_display_name</string>" "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid display name"
  grep -Fq '<key>CFBundleIconFile</key><string>YCoding.icns</string>' "$app/Contents/Info.plist" ||
    fail "Computer helper app has an invalid icon reference"
  if [ "$interaction_layout" = true ]; then
    signer=9dd524184b0db949ffac7f0ada0ae860ac7f5f85
    /usr/bin/codesign --verify --strict -R "=identifier \"app.ycoding.cli\" and certificate leaf = H\"$signer\"" "$binary_file" ||
      fail "YCoding executable signature verification failed"
    /usr/bin/codesign --verify --deep --strict -R "=identifier \"$bundle_id\" and certificate leaf = H\"$signer\"" "$app" ||
      fail "Interaction app signature verification failed"
  else
    /usr/bin/codesign --verify --deep --strict "$app" || fail "Computer helper app signature verification failed"
  fi
fi
if [ "$extension_required" = true ]; then
  extension="$temporary/extract/$extension_name"
  [ -d "$extension" ] && [ ! -L "$extension" ] || fail "Release archive contains an invalid Chrome extension directory"
  if [ "$interaction_layout" = false ]; then
    [ -d "$extension/icons" ] && [ ! -L "$extension/icons" ] || fail "Release archive contains an invalid Chrome extension icons directory"
  fi
  for file in $extension_files; do
    [ -f "$extension/$file" ] && [ ! -L "$extension/$file" ] && [ -s "$extension/$file" ] || fail "Release archive contains an invalid Chrome extension file"
  done
fi

mkdir -p "$install_dir"
[ -d "$install_dir" ] && [ ! -L "$install_dir" ] && [ -O "$install_dir" ] || fail "Install directory must be an owned directory"
for existing_file in "$install_dir/ycoding" "$install_dir/$legacy_helper" "$receipt"; do
  if [ -e "$existing_file" ] || [ -L "$existing_file" ]; then
    [ -f "$existing_file" ] && [ ! -L "$existing_file" ] && [ -O "$existing_file" ] || fail "Installed executable must be an owned regular file: $existing_file"
  fi
done
candidate=$(mktemp "$install_dir/.ycoding.XXXXXX") || fail "Failed to create an install candidate"
cp "$binary_file" "$candidate" || fail "Failed to prepare the ycoding executable"
chmod 755 "$candidate" || fail "Failed to make the ycoding executable runnable"
if [ "$binary" = ycoding-native ]; then
  binary_digest=$(sha256 "$candidate") || fail "Failed to compute the native executable digest"
  receipt_candidate=$(mktemp "$install_dir/.ycoding-native-receipt.XXXXXX") || fail "Failed to create a native release receipt candidate"
  printf '%s %s\n' "$version" "$binary_digest" > "$receipt_candidate" || fail "Failed to write the native release receipt candidate"
fi
if [ "$extension_required" = true ]; then
  extension_candidate=$(mktemp -d "$install_dir/.ycoding-chrome-extension.XXXXXX") || fail "Failed to create a Chrome extension install candidate"
  cp -R "$extension/." "$extension_candidate/" || fail "Failed to prepare the Chrome extension"
  if [ -e "$install_dir/$extension_name" ] || [ -L "$install_dir/$extension_name" ]; then
    [ -d "$install_dir/$extension_name" ] && [ ! -L "$install_dir/$extension_name" ] && [ -O "$install_dir/$extension_name" ] || fail "Installed Chrome extension must be an owned directory"
    extension_backup=$(mktemp -d "$install_dir/.ycoding-chrome-extension-backup.XXXXXX") || fail "Failed to reserve the Chrome extension rollback path"
    rmdir "$extension_backup" || fail "Failed to prepare the Chrome extension rollback path"
  fi
fi
if [ "$operating_system" = "darwin" ]; then
  if [ "$helper_required" = true ]; then
    helper_candidate=$(mktemp "$install_dir/.ycoding-computer-helper.XXXXXX") || fail "Failed to create a computer helper install candidate"
    cp "$temporary/extract/$legacy_helper" "$helper_candidate" || fail "Failed to prepare the computer helper"
    chmod 755 "$helper_candidate" || fail "Failed to make the computer helper runnable"
  fi
  if [ "$app_required" = true ]; then
    app_candidate=$(mktemp -d "$install_dir/.ycoding-computer-helper-app.XXXXXX") || fail "Failed to create an app install candidate"
    cp -R "$app/." "$app_candidate/" || fail "Failed to prepare the computer helper app"
    if [ -e "$install_dir/$app_name" ] || [ -L "$install_dir/$app_name" ]; then
      [ -d "$install_dir/$app_name" ] && [ ! -L "$install_dir/$app_name" ] && [ -O "$install_dir/$app_name" ] || fail "Installed computer helper app must be an owned directory"
      app_backup=$(mktemp -d "$install_dir/.ycoding-computer-helper-app-backup.XXXXXX") || fail "Failed to reserve the app rollback path"
      rmdir "$app_backup" || fail "Failed to prepare the app rollback path"
    fi
    if [ "$app_name" != "$legacy_app" ] && { [ -e "$install_dir/$legacy_app" ] || [ -L "$install_dir/$legacy_app" ]; }; then
      [ -d "$install_dir/$legacy_app" ] && [ ! -L "$install_dir/$legacy_app" ] && [ -O "$install_dir/$legacy_app" ] || fail "Installed computer helper app must be an owned directory"
      legacy_app_backup=$(mktemp -d "$install_dir/.ycoding-computer-helper-legacy-app-backup.XXXXXX") || fail "Failed to reserve the legacy app rollback path"
      rmdir "$legacy_app_backup" || fail "Failed to prepare the legacy app rollback path"
    fi
  fi

  if [ "$helper_required" = true ] && { [ -e "$install_dir/$legacy_helper" ] || [ -L "$install_dir/$legacy_helper" ]; }; then
    helper_backup=$(mktemp "$install_dir/.ycoding-computer-helper-backup.XXXXXX") || fail "Failed to reserve the computer helper rollback path"
    rm -f "$helper_backup" || fail "Failed to prepare the computer helper rollback path"
  fi
  if [ "$helper_required" = false ] && { [ -e "$install_dir/$legacy_helper" ] || [ -L "$install_dir/$legacy_helper" ]; }; then
    legacy_helper_backup=$(mktemp "$install_dir/.ycoding-computer-helper-legacy-backup.XXXXXX") || fail "Failed to reserve the legacy computer helper rollback path"
    rm -f "$legacy_helper_backup" || fail "Failed to prepare the legacy computer helper rollback path"
  fi

  install_transaction=true
  if [ "$interaction_layout" = true ] && { [ -e "$install_dir/$computer_use_app" ] || [ -L "$install_dir/$computer_use_app" ]; }; then
    [ -d "$install_dir/$computer_use_app" ] && [ ! -L "$install_dir/$computer_use_app" ] && [ -O "$install_dir/$computer_use_app" ] || fail "Installed Computer Use app must be an owned directory"
    computer_use_backup=$(mktemp -d "$install_dir/.ycoding-computer-use-backup.XXXXXX") || fail "Failed to reserve the Computer Use app rollback path"
    mv -f "$install_dir/$computer_use_app" "$computer_use_backup/$computer_use_app" || fail "Failed to preserve the superseded Computer Use app"
  fi
  if [ -n "$helper_backup" ]; then
    mv -f "$install_dir/$legacy_helper" "$helper_backup" || fail "Failed to preserve the installed computer helper"
    helper_backed_up=true
  fi
  if [ -n "$app_backup" ]; then
    mv -f "$install_dir/$app_name" "$app_backup" || fail "Failed to preserve the installed computer helper app"
    app_backed_up=true
  fi
  if [ -n "$legacy_app_backup" ]; then
    mv -f "$install_dir/$legacy_app" "$legacy_app_backup" || fail "Failed to preserve the superseded computer helper app"
    legacy_app_backed_up=true
  fi
  if [ -n "$legacy_helper_backup" ]; then
    mv -f "$install_dir/$legacy_helper" "$legacy_helper_backup" || fail "Failed to preserve the superseded computer helper"
    legacy_helper_backed_up=true
  fi
  if [ "$helper_required" = true ]; then
    mv -f "$helper_candidate" "$install_dir/$legacy_helper" || fail "Failed to install the computer helper"
    helper_installed=true
    helper_candidate=
  fi
  if [ "$app_required" = true ]; then
    mv -f "$app_candidate" "$install_dir/$app_name" || fail "Failed to install the computer helper app"
    app_installed=true
    app_candidate=
  fi
fi
if [ "$extension_required" = true ]; then
  install_transaction=true
  if [ -n "$extension_backup" ]; then
    mv -f "$install_dir/$extension_name" "$extension_backup" || fail "Failed to preserve the installed Chrome extension"
    extension_backed_up=true
  fi
  mv -f "$extension_candidate" "$install_dir/$extension_name" || fail "Failed to install the Chrome extension"
  extension_installed=true
  extension_candidate=
fi
install_transaction=true
if [ -f "$install_dir/ycoding" ]; then
  binary_backup=$(mktemp "$install_dir/.ycoding-backup.XXXXXX") || fail "Failed to reserve the ycoding rollback path"
  mv -f "$install_dir/ycoding" "$binary_backup" || fail "Failed to preserve the installed ycoding executable"
  binary_backed_up=true
fi
if [ -f "$receipt" ]; then
  receipt_backup=$(mktemp "$install_dir/.ycoding-native-receipt-backup.XXXXXX") || fail "Failed to reserve the native release receipt rollback path"
  mv -f "$receipt" "$receipt_backup" || fail "Failed to preserve the native release receipt"
  receipt_backed_up=true
fi
mv -f "$candidate" "$install_dir/ycoding" || fail "Failed to install ycoding"
binary_installed=true
candidate=
if [ -n "$receipt_candidate" ]; then
  mv -f "$receipt_candidate" "$receipt" || fail "Failed to install the native release receipt"
  receipt_installed=true
  receipt_candidate=
fi
install_transaction=false
if [ -n "$binary_backup" ]; then rm -f "$binary_backup"; fi
if [ -n "$receipt_backup" ]; then rm -f "$receipt_backup"; fi
if [ -n "$helper_backup" ]; then rm -f "$helper_backup"; fi
if [ -n "$app_backup" ]; then rm -rf "$app_backup"; fi
if [ -n "$legacy_app_backup" ]; then rm -rf "$legacy_app_backup"; fi
if [ -n "$computer_use_backup" ]; then rm -rf "$computer_use_backup"; fi
if [ -n "$legacy_helper_backup" ]; then rm -f "$legacy_helper_backup"; fi
if [ -n "$extension_backup" ]; then rm -rf "$extension_backup"; fi
binary_backup=
receipt_backup=
helper_backup=
app_backup=
legacy_app_backup=
computer_use_backup=
legacy_helper_backup=
extension_backup=

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
