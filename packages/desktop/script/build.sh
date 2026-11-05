#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
root=$(CDPATH= cd -- "$here/../.." && pwd -P)
found=
for directory in "$here" "$root/packages/cli" "$root"; do
  if [ ! -d "$directory" ] || [ ! -r "$directory" ] || [ ! -x "$directory" ]; then
    echo "A build directory cannot be listed for dotenv files, so the build is refused." >&2
    exit 1
  fi
  for entry in "$directory"/.[!.]* "$directory"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    case "$name" in
      .[eE][nN][vV]*) found="$found $entry" ;;
    esac
  done
done
if [ -n "$found" ]; then
  echo "Dotenv files are present:$found. Bun would load them at startup. They were not read or changed, and the build is refused." >&2
  exit 1
fi
for name in MODELS_DEV_API_JSON YCODING_MACOS_SIGNING_IDENTITY YCODING_MACOS_SIGNING_KEYCHAIN YCODING_ANTIGRAVITY_CLIENT_SECRET YCODING_MUSE_CLIENT_SECRET APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_PROVIDER_SHORT_NAME TAURI_CONFIG TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if eval "[ \"\${$name+set}\" = set ]"; then
    echo "$name is set. This build refuses it; its value was not read and the environment is unchanged." >&2
    exit 1
  fi
done
cd "$here"
exec bun run script/build.ts "$@"
