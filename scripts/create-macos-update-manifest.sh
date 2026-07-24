#!/bin/bash

set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 /absolute/AvityOS.app /absolute/AvityOS.zip https://archive-url https://release-notes-url /absolute/stable.json" >&2
  exit 64
fi

app_path="$1"
archive_path="$2"
archive_url="$3"
release_notes_url="$4"
manifest_path="$5"
expected_team_identifier="${AVITY_UPDATE_TEAM_ID:-}"
signing_key_path="${AVITY_UPDATE_SIGNING_KEY_PATH:-}"
public_key_path="${AVITY_UPDATE_PUBLIC_KEY_PATH:-}"

for path in "$app_path" "$archive_path" "$manifest_path"; do
  if [[ "$path" != /* || "$path" == "/" ]]; then
    echo "Application, archive and manifest paths must be absolute and non-root" >&2
    exit 64
  fi
done
if [[ "$archive_url" != https://* || "$release_notes_url" != https://* ]]; then
  echo "Archive and release-notes URLs must use HTTPS" >&2
  exit 64
fi
if [[ ! "$expected_team_identifier" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "AVITY_UPDATE_TEAM_ID must be the pinned 10-character Apple Team ID" >&2
  exit 78
fi
if [[ "$signing_key_path" != /* || "$public_key_path" != /* ]]; then
  echo "Update signing and public key paths must be absolute" >&2
  exit 78
fi
if [[ -e "$manifest_path" ]]; then
  echo "Refusing to replace an existing update manifest: $manifest_path" >&2
  exit 73
fi

for required_command in codesign ditto node sandbox-exec spctl unzip xcrun; do
  command -v "$required_command" >/dev/null || {
    echo "Required manifest command is unavailable: $required_command" >&2
    exit 69
  }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/lib/macos-update-common.sh"

cli_path="$repository_root/packages/app-update/dist/cli.js"
if [[ ! -f "$cli_path" ]]; then
  echo "Build @avityos/app-update before creating a manifest: pnpm --filter @avityos/app-update build" >&2
  exit 69
fi
avity_require_public_release_app "$app_path" "$expected_team_identifier"

validation_root="$(mktemp -d "${TMPDIR:-/tmp}/avityos-update-manifest.XXXXXX")"
cleanup() {
  rm -rf "$validation_root"
}
trap cleanup EXIT
extraction_dir="$validation_root/extracted"
mkdir -m 700 "$extraction_dir"
avity_extract_macos_update_archive "$archive_path" "$extraction_dir"
archive_app="$extraction_dir/AvityOS.app"
avity_require_public_release_app "$archive_app" "$expected_team_identifier"

for key in CFBundleShortVersionString CFBundleVersion LSMinimumSystemVersion; do
  if [[
    "$(avity_plist_value "$app_path" "$key")" != \
    "$(avity_plist_value "$archive_app" "$key")"
  ]]; then
    echo "Archive application metadata does not match the supplied application" >&2
    exit 65
  fi
done

AVITY_UPDATE_ARCHIVE_PATH="$archive_path" \
AVITY_UPDATE_MANIFEST_PATH="$manifest_path" \
AVITY_UPDATE_SIGNING_KEY_PATH="$signing_key_path" \
AVITY_UPDATE_PUBLIC_KEY_PATH="$public_key_path" \
AVITY_UPDATE_VERSION="$(avity_plist_value "$app_path" CFBundleShortVersionString)" \
AVITY_UPDATE_BUILD_NUMBER="$(avity_plist_value "$app_path" CFBundleVersion)" \
AVITY_UPDATE_MINIMUM_SYSTEM_VERSION="$(avity_plist_value "$app_path" LSMinimumSystemVersion)" \
AVITY_UPDATE_TEAM_ID="$expected_team_identifier" \
AVITY_UPDATE_ARCHIVE_URL="$archive_url" \
AVITY_UPDATE_RELEASE_NOTES_URL="$release_notes_url" \
  node "$cli_path" create

echo "Signed update manifest: $manifest_path"
