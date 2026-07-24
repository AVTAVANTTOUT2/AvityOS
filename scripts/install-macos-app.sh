#!/bin/bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 /absolute/path/to/AvityOS.app /absolute/install/directory" >&2
  exit 64
fi

source_app="$1"
destination_dir="$2"

if [[ "$source_app" != /* || "$destination_dir" != /* ]]; then
  echo "Source and destination paths must be absolute" >&2
  exit 64
fi
if [[ "$destination_dir" == "/" ]]; then
  echo "Refusing to install directly at the filesystem root" >&2
  exit 64
fi
if [[
  ! -d "$destination_dir" ||
  -L "$destination_dir" ||
  ! -w "$destination_dir"
]]; then
  echo "Destination must already exist and be writable: $destination_dir" >&2
  exit 73
fi
if [[ ! -d "$source_app" || -L "$source_app" ]]; then
  echo "Source application must be a non-symlink directory" >&2
  exit 66
fi

destination_dir="$(cd "$destination_dir" && pwd -P)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-macos-app.sh" "$source_app"

destination_app="$destination_dir/AvityOS.app"
if [[ -L "$destination_app" ]]; then
  echo "Refusing to replace a symbolic-link application destination" >&2
  exit 73
fi
staging_app="$destination_dir/.AvityOS.app.install.$$"
backup_app=""
installed=false

cleanup() {
  if [[ -d "$staging_app" ]]; then
    rm -rf "$staging_app"
  fi
  if [[ "$installed" != true && -n "$backup_app" && -e "$backup_app" && ! -e "$destination_app" ]]; then
    mv "$backup_app" "$destination_app"
  fi
}
trap cleanup EXIT

ditto "$source_app" "$staging_app"
if [[ -n "${AVITY_INSTALL_TEAM_ID:-}" ]]; then
  source "$script_dir/lib/macos-update-common.sh"
  avity_require_public_release_app "$staging_app" "$AVITY_INSTALL_TEAM_ID"
else
  "$script_dir/verify-macos-app.sh" "$staging_app"
fi
if [[ -e "$destination_app" ]]; then
  backup_app="$destination_dir/AvityOS.app.backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv "$destination_app" "$backup_app"
fi
mv "$staging_app" "$destination_app"
installed=true

echo "Installed: $destination_app"
if [[ -n "$backup_app" ]]; then
  echo "Previous installation preserved at: $backup_app"
fi
