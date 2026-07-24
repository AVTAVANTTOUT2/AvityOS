#!/bin/bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
macos_root="$repository_root/apps/macos"
output_dir="${AVITY_MACOS_OUTPUT_DIR:-$repository_root/dist/macos}"
signing_identity="${AVITY_CODESIGN_IDENTITY:--}"
build_archs="${AVITY_MACOS_ARCHS:-arm64 x86_64}"

for required_command in xcodebuild codesign ditto unzip shasum; do
  command -v "$required_command" >/dev/null || {
    echo "Required command is unavailable: $required_command" >&2
    exit 69
  }
done

if [[ "$output_dir" != /* || "$output_dir" == "/" ]]; then
  echo "AVITY_MACOS_OUTPUT_DIR must be an absolute non-root path" >&2
  exit 64
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/avityos-release.XXXXXX")"
cleanup() {
  rm -rf "$build_root"
}
trap cleanup EXIT

derived_data="$build_root/DerivedData"
staging_dir="$build_root/staging"
mkdir -p "$staging_dir" "$output_dir"

xcodebuild build \
  -quiet \
  -project "$macos_root/AvityOS.xcodeproj" \
  -scheme AvityOS \
  -configuration Release \
  -destination "generic/platform=macOS" \
  -derivedDataPath "$derived_data" \
  ARCHS="$build_archs" \
  ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO

built_app="$derived_data/Build/Products/Release/AvityOS.app"
if [[ ! -d "$built_app" ]]; then
  echo "Xcode did not produce the expected application bundle" >&2
  exit 65
fi

staged_app="$staging_dir/AvityOS.app"
ditto "$built_app" "$staged_app"

if [[ "$signing_identity" == "-" ]]; then
  codesign \
    --force \
    --deep \
    --options runtime \
    --timestamp=none \
    --sign - \
    "$staged_app"
else
  codesign \
    --force \
    --deep \
    --options runtime \
    --timestamp \
    --sign "$signing_identity" \
    "$staged_app"
fi

AVITY_EXPECTED_ARCHS="$build_archs" \
  "$repository_root/scripts/verify-macos-app.sh" "$staged_app"

destination_app="$output_dir/AvityOS.app"
archive_name="AvityOS-macos-universal.zip"
archive_path="$output_dir/$archive_name"

rm -rf "$destination_app"
ditto "$staged_app" "$destination_app"
rm -f "$archive_path" "$archive_path.sha256"
ditto -c -k --sequesterRsrc --keepParent "$destination_app" "$archive_path"
unzip -tq "$archive_path" >/dev/null
(
  cd "$output_dir"
  shasum -a 256 "$archive_name" >"$archive_name.sha256"
)

echo "Application: $destination_app"
echo "Archive: $archive_path"
echo "Checksum: $archive_path.sha256"
if [[ "$signing_identity" == "-" ]]; then
  echo "Distribution status: ad hoc signed; Developer ID notarization is still required outside development/CI."
else
  echo "Distribution status: Developer ID signed; run scripts/notarize-macos-app.sh before public distribution."
fi
