#!/bin/bash

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 https://updates.example/stable.json /absolute/update-public-key.pem /absolute/install/directory" >&2
  exit 64
fi

manifest_url="$1"
public_key_path="$2"
destination_dir="$3"
expected_team_identifier="${AVITY_UPDATE_TEAM_ID:-}"

if [[ "$manifest_url" != https://* ]]; then
  echo "Update manifest URL must use HTTPS" >&2
  exit 64
fi
if [[ "$public_key_path" != /* || "$destination_dir" != /* ]]; then
  echo "Public key and destination paths must be absolute" >&2
  exit 64
fi
if [[ "$destination_dir" == "/" || ! -d "$destination_dir" || -L "$destination_dir" ]]; then
  echo "Destination must be an existing non-symlink directory" >&2
  exit 73
fi
if [[ ! "$expected_team_identifier" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "AVITY_UPDATE_TEAM_ID must be the pinned 10-character Apple Team ID" >&2
  exit 78
fi

for required_command in node codesign ditto unzip sandbox-exec xcrun spctl sw_vers; do
  command -v "$required_command" >/dev/null || {
    echo "Required update command is unavailable: $required_command" >&2
    exit 69
  }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
source "$script_dir/lib/macos-update-common.sh"
cli_path="$repository_root/packages/app-update/dist/cli.js"
if [[ ! -f "$cli_path" ]]; then
  echo "Build @avityos/app-update before applying an update: pnpm --filter @avityos/app-update build" >&2
  exit 69
fi

destination_dir="$(cd "$destination_dir" && pwd -P)"
installed_app="$destination_dir/AvityOS.app"
if [[ ! -d "$installed_app" || -L "$installed_app" ]]; then
  echo "A non-symlink AvityOS.app installation is required before update" >&2
  exit 66
fi
avity_require_public_release_app "$installed_app" "$expected_team_identifier"

update_root="$(mktemp -d "${TMPDIR:-/tmp}/avityos-update.XXXXXX")"
cleanup() {
  rm -rf "$update_root"
}
trap cleanup EXIT
archive_path="$update_root/AvityOS.zip"
verified_manifest_path="$update_root/verified-manifest.json"

AVITY_UPDATE_MANIFEST_URL="$manifest_url" \
AVITY_UPDATE_PUBLIC_KEY_PATH="$public_key_path" \
AVITY_UPDATE_INSTALLED_VERSION="$(avity_plist_value "$installed_app" CFBundleShortVersionString)" \
AVITY_UPDATE_INSTALLED_BUILD_NUMBER="$(avity_plist_value "$installed_app" CFBundleVersion)" \
AVITY_UPDATE_ARCHIVE_PATH="$archive_path" \
AVITY_UPDATE_VERIFIED_MANIFEST_PATH="$verified_manifest_path" \
  node "$cli_path" download

extraction_dir="$update_root/extracted"
mkdir -m 700 "$extraction_dir"
avity_extract_macos_update_archive "$archive_path" "$extraction_dir"
candidate_app="$extraction_dir/AvityOS.app"
avity_require_public_release_app "$candidate_app" "$expected_team_identifier"

AVITY_UPDATE_VERIFIED_MANIFEST_PATH="$verified_manifest_path" \
AVITY_UPDATE_BUNDLE_VERSION="$(avity_plist_value "$candidate_app" CFBundleShortVersionString)" \
AVITY_UPDATE_BUNDLE_BUILD_NUMBER="$(avity_plist_value "$candidate_app" CFBundleVersion)" \
AVITY_UPDATE_BUNDLE_MINIMUM_SYSTEM_VERSION="$(avity_plist_value "$candidate_app" LSMinimumSystemVersion)" \
AVITY_UPDATE_BUNDLE_TEAM_ID="$(avity_team_identifier "$candidate_app")" \
AVITY_UPDATE_SYSTEM_VERSION="$(sw_vers -productVersion)" \
  node "$cli_path" check-bundle

AVITY_INSTALL_TEAM_ID="$expected_team_identifier" \
  "$script_dir/install-macos-app.sh" "$candidate_app" "$destination_dir"
echo "Update installed. Quit and relaunch AvityOS to run the new version."
