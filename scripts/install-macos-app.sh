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
if [[ ! -d "$destination_dir" || ! -w "$destination_dir" ]]; then
  echo "Destination must already exist and be writable: $destination_dir" >&2
  exit 73
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-macos-app.sh" "$source_app"

destination_app="$destination_dir/AvityOS.app"
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
