#!/bin/bash

set -euo pipefail

update_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
update_repository_root="$(cd "$update_lib_dir/../.." && pwd)"

avity_plist_value() {
  local app_path="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" \
    "$app_path/Contents/Info.plist"
}

avity_team_identifier() {
  local app_path="$1"
  local signature_summary
  signature_summary="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
  sed -n 's/^TeamIdentifier=//p' <<<"$signature_summary"
}

avity_require_public_release_app() {
  local app_path="$1"
  local expected_team_identifier="$2"

  if [[ ! -d "$app_path" || -L "$app_path" ]]; then
    echo "Public release application must be a non-symlink directory" >&2
    return 66
  fi
  "$update_repository_root/scripts/verify-macos-app.sh" "$app_path"
  local actual_team_identifier
  actual_team_identifier="$(avity_team_identifier "$app_path")"
  if [[
    -z "$actual_team_identifier" ||
    "$actual_team_identifier" == "not set" ||
    "$actual_team_identifier" != "$expected_team_identifier"
  ]]; then
    echo "Application TeamIdentifier does not match the pinned update team" >&2
    return 78
  fi
  xcrun stapler validate "$app_path"
  spctl --assess --type execute --verbose=2 "$app_path"
}

avity_extract_macos_update_archive() {
  local archive_path="$1"
  local extraction_dir="$2"

  if [[ "$archive_path" != /* || "$extraction_dir" != /* ]]; then
    echo "Archive and extraction paths must be absolute" >&2
    return 64
  fi
  if [[ ! -f "$archive_path" || -L "$archive_path" ]]; then
    echo "Update archive must be a regular file" >&2
    return 66
  fi
  if [[ ! -d "$extraction_dir" || -L "$extraction_dir" ]]; then
    echo "Extraction directory must exist and must not be a symlink" >&2
    return 73
  fi
  extraction_dir="$(cd "$extraction_dir" && pwd -P)"
  if [[ "$extraction_dir" =~ [[:cntrl:]] ]]; then
    echo "Extraction directory must not contain control characters" >&2
    return 64
  fi
  local archive_summary
  archive_summary="$(unzip -Z -t "$archive_path")"
  if [[
    ! "$archive_summary" =~ ([0-9]+)\ files,\ ([0-9]+)\ bytes\ uncompressed
  ]]; then
    echo "Unable to determine update archive expansion size" >&2
    return 65
  fi
  local file_count="${BASH_REMATCH[1]}"
  local uncompressed_bytes="${BASH_REMATCH[2]}"
  if (( file_count < 1 || file_count > 10000 )); then
    echo "Update archive file count is outside the allowed range" >&2
    return 65
  fi
  if (( uncompressed_bytes < 1 || uncompressed_bytes > 1073741824 )); then
    echo "Update archive expands beyond the 1 GiB safety limit" >&2
    return 65
  fi

  local extraction_profile="$extraction_dir/.avity-update-extract.sb"
  local sandbox_extraction_dir="${extraction_dir//\\/\\\\}"
  sandbox_extraction_dir="${sandbox_extraction_dir//\"/\\\"}"
  {
    printf '%s\n' '(version 1)'
    printf '%s\n' '(deny default)'
    printf '%s\n' '(allow process*)'
    printf '%s\n' '(allow file-read*)'
    printf '%s\n' '(allow sysctl-read)'
    printf '%s\n' '(allow mach-lookup)'
    printf '%s\n' "(allow file-write* (subpath \"$sandbox_extraction_dir\"))"
  } >"$extraction_profile"
  chmod 600 "$extraction_profile"
  sandbox-exec -f "$extraction_profile" \
    /usr/bin/ditto -x -k "$archive_path" "$extraction_dir"
  rm -f "$extraction_profile"
  if [[ -d "$extraction_dir/__MACOSX" && ! -L "$extraction_dir/__MACOSX" ]]; then
    rm -rf "$extraction_dir/__MACOSX"
  fi

  local extracted_app="$extraction_dir/AvityOS.app"
  if [[ ! -d "$extracted_app" || -L "$extracted_app" ]]; then
    echo "Update archive does not contain AvityOS.app" >&2
    return 65
  fi
  if find "$extraction_dir" -mindepth 1 -maxdepth 1 \
    ! -name 'AvityOS.app' -print -quit | grep -q .; then
    echo "Update archive contains an unexpected top-level entry" >&2
    return 65
  fi
  if find "$extracted_app" -type l -print -quit | grep -q .; then
    echo "Update application must not contain symbolic links" >&2
    return 65
  fi
  if find "$extracted_app" ! -type d ! -type f -print -quit | grep -q .; then
    echo "Update application contains an unsupported filesystem entry" >&2
    return 65
  fi
}
