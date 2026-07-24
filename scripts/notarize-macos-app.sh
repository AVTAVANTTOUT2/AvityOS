#!/bin/bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 /absolute/path/to/AvityOS.app [/absolute/path/to/AvityOS-macos-universal.zip]" >&2
  exit 64
fi

app_path="$1"
archive_path="${2:-$(dirname "$app_path")/AvityOS-macos-universal.zip}"
notary_profile="${AVITY_NOTARY_PROFILE:-}"

if [[ "$app_path" != /* || "$archive_path" != /* ]]; then
  echo "Application and archive paths must be absolute" >&2
  exit 64
fi
if [[ -z "$notary_profile" ]]; then
  echo "AVITY_NOTARY_PROFILE must name an existing notarytool Keychain profile" >&2
  exit 78
fi

signature_summary="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
team_identifier="$(sed -n 's/^TeamIdentifier=//p' <<<"$signature_summary")"
if [[ -z "$team_identifier" || "$team_identifier" == "not set" ]]; then
  echo "The application must be signed with a Developer ID identity before notarization" >&2
  exit 78
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-macos-app.sh" "$app_path"

submission_root="$(mktemp -d "${TMPDIR:-/tmp}/avityos-notary.XXXXXX")"
cleanup() {
  rm -rf "$submission_root"
}
trap cleanup EXIT

submission_archive="$submission_root/AvityOS.zip"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$submission_archive"
xcrun notarytool submit \
  "$submission_archive" \
  --keychain-profile "$notary_profile" \
  --wait
xcrun stapler staple "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=2 "$app_path"

archive_name="$(basename "$archive_path")"
mkdir -p "$(dirname "$archive_path")"
rm -f "$archive_path" "$archive_path.sha256"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive_path"
(
  cd "$(dirname "$archive_path")"
  shasum -a 256 "$archive_name" >"$archive_name.sha256"
)

echo "Notarized application: $app_path"
echo "Stapled archive: $archive_path"
