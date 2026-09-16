#!/bin/sh

set -eu

repository="Althenia/ycoding"
install_dir="$HOME/.local/bin"
temporary=
candidate=
helper_candidate=
binary_backup=
helper_backup=
office_candidate=
office_pck_candidate=
office_staged=
office_mount=
office_attached=false
install_transaction=false
binary_backed_up=false
helper_backed_up=false
binary_installed=false
helper_installed=false

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
    if [ "$restore_status" -ne 0 ]; then
      printf 'ycoding installer: Failed to restore the previously installed executable pair\n' >&2
      status=1
    fi
  fi
  if [ -n "$candidate" ]; then rm -f "$candidate"; fi
  if [ -n "$helper_candidate" ]; then rm -f "$helper_candidate"; fi
  if [ -n "$binary_backup" ] && [ "$binary_backed_up" = false ]; then rm -f "$binary_backup"; fi
  if [ -n "$helper_backup" ] && [ "$helper_backed_up" = false ]; then rm -f "$helper_backup"; fi
  # A mounted image must be released even when the install failed, or the user is
  # left with a volume they did not mount.
  if [ "$office_attached" = true ] && [ -n "$office_mount" ]; then
    hdiutil detach "$office_mount" >/dev/null 2>&1 || true
    office_attached=false
  fi
  if [ -n "$office_candidate" ]; then rm -f "$office_candidate"; fi
  if [ -n "$office_pck_candidate" ]; then rm -f "$office_pck_candidate"; fi
  if [ -n "$office_staged" ]; then rm -rf "$office_staged"; fi
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

# The native desktop client is opt-in so the terminal install is unchanged:
#   curl -fsSL <url> | sh -s -- --office
# An unknown argument fails rather than being ignored, because silently accepting
# a misspelled flag would install less than the user asked for.
install_office=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --office) install_office=true ;;
    *) fail "Unknown argument: $1 (supported: --office)" ;;
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
case "$operating_system" in
  darwin) office_asset_suffix=darwin-universal.dmg ;;
  *) office_asset_suffix=linux-x64.tar.gz ;;
esac
release_url="https://github.com/$repository/releases/download/v$version"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/ycoding-install.XXXXXX") || fail "Failed to create a temporary directory"

# Download one release asset and verify it against the release checksum file.
# Every artifact goes through here so a second artifact cannot be verified by a
# weaker rule than the first.
fetch_verified() {
  file=$1
  curl --proto '=https' --proto-redir '=https' -fsSL -o "$temporary/$file" "$release_url/$file" ||
    fail "Failed to download $file"
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

# The desktop client is a separate artifact from the CLI. It is installed into a
# per-user location so no installer step needs administrator rights.
install_office_client() {
  office_asset="ycoding-office-$version-$office_asset_suffix"
  printf 'Downloading %s\n' "$office_asset"
  fetch_verified "$office_asset"
  mkdir "$temporary/app" || fail "Failed to create an extraction directory"
  if [ "$operating_system" = "darwin" ]; then
    install_office_bundle "$office_asset"
  else
    install_office_linux "$office_asset"
  fi
}

# macOS ships a disk image holding the bundle and a shortcut to Applications, so a
# user can drag the app in. The installer does the same move itself, then releases
# the image.
install_office_bundle() {
  file=$1
  command -v hdiutil >/dev/null 2>&1 || fail "hdiutil is required to install the desktop app"
  command -v ditto >/dev/null 2>&1 || fail "ditto is required to install the desktop app"

  # An explicit mount point avoids having to guess the volume name, and keeps the
  # image out of the user's Finder sidebar while it is in use.
  office_mount="$temporary/mount"
  mkdir "$office_mount" || fail "Failed to create a mount point"
  hdiutil attach -nobrowse -readonly -mountpoint "$office_mount" "$temporary/$file" >/dev/null ||
    fail "Failed to mount $file"
  office_attached=true

  bundle="$office_mount/YCoding Office.app"
  [ -d "$bundle" ] || fail "The disk image did not contain YCoding Office.app"

  # A bundle with no runnable executable inside is a directory of files, and
  # installing it would look successful while launching nothing. The loop variable
  # is deliberately not `candidate`: that name belongs to the terminal install's
  # transaction and cleanup removes it.
  office_binary=
  for bundle_binary in "$bundle/Contents/MacOS/"*; do
    if [ -f "$bundle_binary" ] && [ -x "$bundle_binary" ] && [ -s "$bundle_binary" ]; then
      office_binary=$bundle_binary
      break
    fi
  done
  [ -n "$office_binary" ] || fail "The desktop app bundle has no runnable executable"

  # /Applications is group-writable by admin on macOS, so a normal user needs no
  # elevation there. YCODING_OFFICE_DIR relocates the bundle when it is not
  # writable, or when the user wants it elsewhere.
  if [ -n "${YCODING_OFFICE_DIR:-}" ]; then
    office_dir=$YCODING_OFFICE_DIR
    mkdir -p "$office_dir" || fail "Failed to create $office_dir"
  elif [ -w /Applications ]; then
    office_dir=/Applications
  else
    office_dir="$HOME/Applications"
    mkdir -p "$office_dir" || fail "Failed to create $office_dir"
  fi

  # Staged beside its destination so a partially copied bundle never replaces a
  # working one, and copied with ditto because that is what preserves a bundle's
  # extended attributes and permissions.
  office_staged="$office_dir/.YCoding Office.app.$"
  rm -rf "$office_staged"
  ditto "$bundle" "$office_staged" || fail "Failed to stage the desktop app"

  # The destination must be gone before the move. Moving onto an existing directory
  # would nest the new bundle inside the old one and report success.
  if [ -e "$office_dir/YCoding Office.app" ]; then
    rm -rf "$office_dir/YCoding Office.app" || fail "Failed to remove the previous desktop app"
  fi
  [ ! -e "$office_dir/YCoding Office.app" ] ||
    fail "Could not replace the existing desktop app at $office_dir/YCoding Office.app"

  mv "$office_staged" "$office_dir/YCoding Office.app" || fail "Failed to install the desktop app"
  office_staged=

  hdiutil detach "$office_mount" >/dev/null || fail "Failed to release the mounted disk image"
  office_attached=false

  printf 'Installed YCoding Office %s to %s/YCoding Office.app\n' "$version" "$office_dir"
}

# Linux ships the executable and its data pack as a pair. The data pack is moved
# first so the installed executable is never runnable without its data.
install_office_linux() {
  file=$1
  tar -tzf "$temporary/$file" >"$temporary/app-entries" || fail "Failed to inspect $file"
  app_entries=$(LC_ALL=C sort "$temporary/app-entries")
  expected_app_entries=$(printf '%s\n' ycoding-office ycoding-office.pck | LC_ALL=C sort)
  [ "$app_entries" = "$expected_app_entries" ] || fail "Desktop app archive has invalid direct entries"
  tar -xzf "$temporary/$file" -C "$temporary/app" || fail "Failed to extract $file"
  [ -f "$temporary/app/ycoding-office" ] && [ ! -L "$temporary/app/ycoding-office" ] && [ -s "$temporary/app/ycoding-office" ] ||
    fail "Release archive did not contain a regular ycoding-office executable"
  [ -f "$temporary/app/ycoding-office.pck" ] && [ ! -L "$temporary/app/ycoding-office.pck" ] && [ -s "$temporary/app/ycoding-office.pck" ] ||
    fail "Release archive did not contain the desktop app data pack"

  office_candidate=$(mktemp "$install_dir/.ycoding-office.XXXXXX") || fail "Failed to create a desktop app install candidate"
  cp "$temporary/app/ycoding-office" "$office_candidate" || fail "Failed to prepare the desktop app"
  chmod 755 "$office_candidate" || fail "Failed to make the desktop app runnable"
  office_pck_candidate=$(mktemp "$install_dir/.ycoding-office-pck.XXXXXX") || fail "Failed to create a desktop app data candidate"
  cp "$temporary/app/ycoding-office.pck" "$office_pck_candidate" || fail "Failed to prepare the desktop app data"
  mv -f "$office_pck_candidate" "$install_dir/ycoding-office.pck" || fail "Failed to install the desktop app data"
  office_pck_candidate=
  mv -f "$office_candidate" "$install_dir/ycoding-office" || fail "Failed to install the desktop app"
  office_candidate=
  printf 'Installed YCoding Office %s to %s/ycoding-office\n' "$version" "$install_dir"
}

curl --proto '=https' --proto-redir '=https' -fsSL -o "$temporary/$checksums" "$release_url/$checksums" || fail "Failed to download $checksums"
fetch_verified "$asset"

tar -tzf "$temporary/$asset" >"$temporary/entries" || fail "Failed to inspect $asset"
entries=$(LC_ALL=C sort "$temporary/entries")
expected_entries=ycoding
if [ "$operating_system" = "darwin" ]; then
  expected_entries=$(printf '%s\n' ycoding ycoding-computer-helper | LC_ALL=C sort)
fi
[ "$entries" = "$expected_entries" ] || fail "Release archive has invalid direct entries"
mkdir "$temporary/extract"
tar -xzf "$temporary/$asset" -C "$temporary/extract" || fail "Failed to extract $asset"
[ -f "$temporary/extract/ycoding" ] && [ ! -L "$temporary/extract/ycoding" ] && [ -s "$temporary/extract/ycoding" ] ||
  fail "Release archive did not contain a regular ycoding executable"
if [ "$operating_system" = "darwin" ]; then
  [ -f "$temporary/extract/ycoding-computer-helper" ] && [ ! -L "$temporary/extract/ycoding-computer-helper" ] && [ -s "$temporary/extract/ycoding-computer-helper" ] ||
    fail "Release archive did not contain a regular computer helper"
fi

mkdir -p "$install_dir"
candidate=$(mktemp "$install_dir/.ycoding.XXXXXX") || fail "Failed to create an install candidate"
cp "$temporary/extract/ycoding" "$candidate" || fail "Failed to prepare the ycoding executable"
chmod 755 "$candidate" || fail "Failed to make the ycoding executable runnable"
if [ "$operating_system" = "darwin" ]; then
  helper_candidate=$(mktemp "$install_dir/.ycoding-computer-helper.XXXXXX") || fail "Failed to create a computer helper install candidate"
  cp "$temporary/extract/ycoding-computer-helper" "$helper_candidate" || fail "Failed to prepare the computer helper"
  chmod 755 "$helper_candidate" || fail "Failed to make the computer helper runnable"

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
  mv -f "$helper_candidate" "$install_dir/ycoding-computer-helper" || fail "Failed to install the computer helper"
  helper_installed=true
  helper_candidate=
fi
mv -f "$candidate" "$install_dir/ycoding" || fail "Failed to install ycoding"
binary_installed=true
candidate=
install_transaction=false
if [ -n "$binary_backup" ]; then rm -f "$binary_backup"; fi
if [ -n "$helper_backup" ]; then rm -f "$helper_backup"; fi
binary_backup=
helper_backup=

printf 'Installed ycoding %s to %s/ycoding\n' "$version" "$install_dir"

if [ "$install_office" = true ]; then
  install_office_client
fi

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
