#!/bin/sh

set -eu

repository="Althenia/ycoding"
install_dir="$HOME/.local/bin"
temporary=
candidate=

cleanup() {
  if [ -n "$candidate" ]; then rm -f "$candidate"; fi
  if [ -n "$temporary" ]; then rm -rf "$temporary"; fi
}
trap cleanup 0 HUP INT TERM

fail() {
  printf 'ycoding installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

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

curl --proto '=https' --proto-redir '=https' -fsSL -o "$temporary/$checksums" "$release_url/$checksums" || fail "Failed to download $checksums"
curl --proto '=https' --proto-redir '=https' -fsSL -o "$temporary/$asset" "$release_url/$asset" || fail "Failed to download $asset"

expected=$(awk -v file="$asset" '
  ($2 == file || $2 == "*" file) {
    if (found) exit 2
    print $1
    found = 1
  }
  END { if (!found) exit 1 }
' "$temporary/$checksums") || fail "Checksum file does not contain exactly one entry for $asset"
printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || fail "Checksum file contains an invalid SHA256 value"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || fail "Checksum verification failed for $asset"

entries=$(tar -tzf "$temporary/$asset") || fail "Failed to inspect $asset"
[ "$entries" = "ycoding" ] || fail "Release archive must contain only the direct ycoding executable"
mkdir "$temporary/extract"
tar -xzf "$temporary/$asset" -C "$temporary/extract" || fail "Failed to extract $asset"
[ -f "$temporary/extract/ycoding" ] && [ ! -L "$temporary/extract/ycoding" ] && [ -s "$temporary/extract/ycoding" ] ||
  fail "Release archive did not contain a regular ycoding executable"

mkdir -p "$install_dir"
candidate=$(mktemp "$install_dir/.ycoding.XXXXXX") || fail "Failed to create an install candidate"
cp "$temporary/extract/ycoding" "$candidate" || fail "Failed to prepare the ycoding executable"
chmod 755 "$candidate" || fail "Failed to make the ycoding executable runnable"
mv -f "$candidate" "$install_dir/ycoding" || fail "Failed to install ycoding"
candidate=

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
