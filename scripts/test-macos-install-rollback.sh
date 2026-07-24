#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 || "$1" != /* || ! -d "$1" ]]; then
  echo "Usage: $0 /absolute/path/to/AvityOS.app" >&2
  exit 64
fi

for required_command in codesign ditto node openssl sandbox-exec unzip; do
  command -v "$required_command" >/dev/null || {
    echo "Required test command is unavailable: $required_command" >&2
    exit 69
  }
done

source_app="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/avityos-update-test.XXXXXX")"
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

install_dir="$test_root/install"
outside_dir="$test_root/outside"
candidate_app="$test_root/candidate/AvityOS.app"
extraction_dir="$test_root/extracted"
mkdir -m 700 \
  "$install_dir" \
  "$outside_dir" \
  "$extraction_dir" \
  "$(dirname "$candidate_app")"

archive_path="$(dirname "$source_app")/AvityOS-macos-universal.zip"
if [[ ! -f "$archive_path" || -L "$archive_path" ]]; then
  echo "The verified universal update archive is required beside the app" >&2
  exit 66
fi
source "$script_dir/lib/macos-update-common.sh"
avity_extract_macos_update_archive "$archive_path" "$extraction_dir"
"$script_dir/verify-macos-app.sh" "$extraction_dir/AvityOS.app"

original_version="$(/usr/libexec/PlistBuddy -c \
  'Print :CFBundleShortVersionString' \
  "$source_app/Contents/Info.plist")"
original_build="$(/usr/libexec/PlistBuddy -c \
  'Print :CFBundleVersion' \
  "$source_app/Contents/Info.plist")"
ditto "$source_app" "$candidate_app"
/usr/libexec/PlistBuddy -c \
  'Set :CFBundleShortVersionString 99.99.99' \
  "$candidate_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c \
  'Set :CFBundleVersion 999999' \
  "$candidate_app/Contents/Info.plist"
codesign --force --deep --options runtime --timestamp=none --sign - \
  "$candidate_app"
"$script_dir/verify-macos-app.sh" "$candidate_app"

"$script_dir/install-macos-app.sh" "$source_app" "$install_dir"
"$script_dir/install-macos-app.sh" "$candidate_app" "$install_dir"
if [[
  "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
    "$install_dir/AvityOS.app/Contents/Info.plist")" != 999999
]]; then
  echo "Installer did not activate the candidate build" >&2
  exit 1
fi
backup_app="$(find "$install_dir" -mindepth 1 -maxdepth 1 \
  -type d -name 'AvityOS.app.backup-*' -print -quit)"
if [[ -z "$backup_app" ]]; then
  echo "Installer did not preserve the previous application" >&2
  exit 1
fi

outside_backup="$outside_dir/$(basename "$backup_app")"
ditto "$backup_app" "$outside_backup"
if "$script_dir/rollback-macos-app.sh" "$outside_backup" "$install_dir"; then
  echo "Rollback accepted a backup outside the installation directory" >&2
  exit 1
fi

"$script_dir/rollback-macos-app.sh" "$backup_app" "$install_dir"
"$script_dir/verify-macos-app.sh" "$install_dir/AvityOS.app"
if [[
  "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$install_dir/AvityOS.app/Contents/Info.plist")" != "$original_version" ||
  "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
    "$install_dir/AvityOS.app/Contents/Info.plist")" != "$original_build"
]]; then
  echo "Rollback did not restore the original application version" >&2
  exit 1
fi
if [[
  "$(find "$install_dir" -mindepth 1 -maxdepth 1 \
    -type d -name 'AvityOS.app.failed-*' | wc -l | tr -d ' ')" != 1
]]; then
  echo "Rollback did not preserve the replaced installation" >&2
  exit 1
fi
if [[ ! -d "$backup_app" ]]; then
  echo "Rollback removed the original installer backup" >&2
  exit 1
fi

private_key="$test_root/update-private.pem"
public_key="$test_root/update-public.pem"
openssl genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
chmod 600 "$private_key"
openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
chmod 644 "$public_key"
cli_path="$script_dir/../packages/app-update/dist/cli.js"
if [[ ! -f "$cli_path" ]]; then
  echo "Build @avityos/app-update before running the macOS update test" >&2
  exit 69
fi
local_manifest_path="$test_root/local-stable.json"
AVITY_UPDATE_ARCHIVE_PATH="$archive_path" \
AVITY_UPDATE_MANIFEST_PATH="$local_manifest_path" \
AVITY_UPDATE_SIGNING_KEY_PATH="$private_key" \
AVITY_UPDATE_PUBLIC_KEY_PATH="$public_key" \
AVITY_UPDATE_VERSION="99.99.99" \
AVITY_UPDATE_BUILD_NUMBER="999999" \
AVITY_UPDATE_MINIMUM_SYSTEM_VERSION="14.0" \
AVITY_UPDATE_PUBLISHED_AT="2026-07-24T12:00:00.000Z" \
AVITY_UPDATE_TEAM_ID="ABCDE12345" \
AVITY_UPDATE_ARCHIVE_URL="https://updates.example/AvityOS.zip" \
AVITY_UPDATE_RELEASE_NOTES_URL="https://updates.example/releases/99.99.99" \
  node "$cli_path" create
if [[ ! -f "$local_manifest_path" || "$(stat -f '%Lp' "$local_manifest_path")" != 600 ]]; then
  echo "Update CLI did not create a private signed manifest" >&2
  exit 1
fi

rejected_manifest_path="$test_root/rejected-stable.json"
if AVITY_UPDATE_TEAM_ID="ABCDE12345" \
  AVITY_UPDATE_SIGNING_KEY_PATH="$private_key" \
  AVITY_UPDATE_PUBLIC_KEY_PATH="$public_key" \
  "$script_dir/create-macos-update-manifest.sh" \
    "$source_app" \
    "$archive_path" \
    "https://updates.example/AvityOS.zip" \
    "https://updates.example/releases/0.1.0" \
    "$rejected_manifest_path"; then
  echo "Public feed creation accepted an ad hoc signed application" >&2
  exit 1
fi
if [[ -e "$rejected_manifest_path" ]]; then
  echo "Rejected public feed creation left a manifest behind" >&2
  exit 1
fi

echo "macOS sandbox extraction, install, scoped rollback and ad hoc release rejection passed"
