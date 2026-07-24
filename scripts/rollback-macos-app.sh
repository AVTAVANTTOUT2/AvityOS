#!/bin/bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 /absolute/AvityOS.app.backup-TIMESTAMP-PID /absolute/install/directory" >&2
  exit 64
fi

backup_app="$1"
destination_dir="$2"

if [[ "$backup_app" != /* || "$destination_dir" != /* ]]; then
  echo "Backup and destination paths must be absolute" >&2
  exit 64
fi
if [[ "$destination_dir" == "/" || ! -d "$destination_dir" || -L "$destination_dir" ]]; then
  echo "Destination must be an existing non-symlink directory" >&2
  exit 73
fi
if [[ ! -d "$backup_app" || -L "$backup_app" ]]; then
  echo "Backup application must be a non-symlink directory" >&2
  exit 66
fi
if [[ ! "$(basename "$backup_app")" =~ ^AvityOS\.app\.backup-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]; then
  echo "Backup name does not match an AvityOS installer backup" >&2
  exit 64
fi

destination_dir="$(cd "$destination_dir" && pwd -P)"
backup_parent="$(cd "$(dirname "$backup_app")" && pwd -P)"
if [[ "$backup_parent" != "$destination_dir" ]]; then
  echo "Backup must belong to the selected installation directory" >&2
  exit 64
fi
backup_app="$backup_parent/$(basename "$backup_app")"
destination_app="$destination_dir/AvityOS.app"
if [[ ! -d "$destination_app" || -L "$destination_app" ]]; then
  echo "Current AvityOS.app installation is required for rollback" >&2
  exit 66
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/macos-update-common.sh"
"$script_dir/verify-macos-app.sh" "$destination_app"
"$script_dir/verify-macos-app.sh" "$backup_app"

current_team="$(codesign -dv --verbose=4 "$destination_app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
backup_team="$(codesign -dv --verbose=4 "$backup_app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
public_rollback=false
if [[
  -z "$backup_team" ||
  "$backup_team" == "not set"
]]; then
  if [[ -n "$current_team" && "$current_team" != "not set" ]]; then
    echo "Refusing to replace a Developer ID installation with an ad hoc backup" >&2
    exit 78
  fi
else
  expected_team_identifier="${AVITY_UPDATE_TEAM_ID:-}"
  if [[ ! "$expected_team_identifier" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "AVITY_UPDATE_TEAM_ID is required to trust a public rollback backup" >&2
    exit 78
  fi
  avity_require_public_release_app "$backup_app" "$expected_team_identifier"
  public_rollback=true
fi

staging_app="$destination_dir/.AvityOS.app.rollback.$$"
failed_app="$destination_dir/AvityOS.app.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
installed=false

cleanup() {
  if [[ -d "$staging_app" ]]; then
    rm -rf "$staging_app"
  fi
  if [[ "$installed" != true && -e "$failed_app" && ! -e "$destination_app" ]]; then
    mv "$failed_app" "$destination_app"
  fi
}
trap cleanup EXIT

ditto "$backup_app" "$staging_app"
if [[ "$public_rollback" == true ]]; then
  avity_require_public_release_app "$staging_app" "$expected_team_identifier"
else
  "$script_dir/verify-macos-app.sh" "$staging_app"
fi
mv "$destination_app" "$failed_app"
mv "$staging_app" "$destination_app"
installed=true

echo "Rolled back: $destination_app"
echo "Replaced installation preserved at: $failed_app"
echo "Original installer backup retained at: $backup_app"
