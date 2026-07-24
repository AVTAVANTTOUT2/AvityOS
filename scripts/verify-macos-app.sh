#!/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /absolute/path/to/AvityOS.app" >&2
  exit 64
fi

app_path="$1"
if [[ "$app_path" != /* ]]; then
  echo "The application path must be absolute: $app_path" >&2
  exit 64
fi
if [[ ! -d "$app_path" ]]; then
  echo "Application bundle not found: $app_path" >&2
  exit 66
fi

info_plist="$app_path/Contents/Info.plist"
if [[ ! -f "$info_plist" ]]; then
  echo "Info.plist not found in application bundle" >&2
  exit 65
fi

plutil -lint "$info_plist" >/dev/null

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$info_plist"
}

bundle_id="$(plist_value CFBundleIdentifier)"
package_type="$(plist_value CFBundlePackageType)"
executable_name="$(plist_value CFBundleExecutable)"
version="$(plist_value CFBundleShortVersionString)"
build_number="$(plist_value CFBundleVersion)"
minimum_system="$(plist_value LSMinimumSystemVersion)"
url_scheme="$(plist_value CFBundleURLTypes:0:CFBundleURLSchemes:0)"
category="$(plist_value LSApplicationCategoryType)"
icon_name="$(plist_value CFBundleIconFile)"

[[ "$bundle_id" == "com.avityos.app" ]] || {
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 65
}
[[ "$package_type" == "APPL" ]] || {
  echo "Unexpected package type: $package_type" >&2
  exit 65
}
[[ -n "$version" && -n "$build_number" ]] || {
  echo "The application version and build number must be set" >&2
  exit 65
}
[[ "$minimum_system" == "14.0" ]] || {
  echo "Unexpected minimum macOS version: $minimum_system" >&2
  exit 65
}
[[ "$url_scheme" == "avity" ]] || {
  echo "The avity URL scheme is not registered" >&2
  exit 65
}
[[ "$category" == "public.app-category.developer-tools" ]] || {
  echo "Unexpected application category: $category" >&2
  exit 65
}

icon_file="$icon_name"
if [[ "$icon_file" != *.icns ]]; then
  icon_file="$icon_file.icns"
fi
if [[ ! -f "$app_path/Contents/Resources/$icon_file" ]]; then
  echo "Application icon is missing: $icon_file" >&2
  exit 65
fi

executable="$app_path/Contents/MacOS/$executable_name"
if [[ ! -x "$executable" ]]; then
  echo "Application executable is missing or not executable: $executable" >&2
  exit 65
fi

codesign --verify --deep --strict --verbose=2 "$app_path"

expected_archs="${AVITY_EXPECTED_ARCHS:-arm64 x86_64}"
actual_archs="$(lipo -archs "$executable")"
for architecture in $expected_archs; do
  if [[ " $actual_archs " != *" $architecture "* ]]; then
    echo "Missing architecture $architecture; found: $actual_archs" >&2
    exit 65
  fi
done

if find "$app_path" -type d -name '*.xctest' -print -quit | grep -q .; then
  echo "A test bundle was included in the release application" >&2
  exit 65
fi

signature_summary="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
if ! grep -q 'flags=.*runtime' <<<"$signature_summary"; then
  echo "The hardened runtime flag is missing from the application signature" >&2
  exit 65
fi
signature_kind="$(sed -n 's/^Signature=//p' <<<"$signature_summary")"
team_identifier="$(sed -n 's/^TeamIdentifier=//p' <<<"$signature_summary")"

echo "Verified AvityOS ${version} (${build_number})"
echo "Bundle: $bundle_id · macOS ${minimum_system}+ · architectures: $actual_archs"
echo "Signature: ${signature_kind:-identity} · team: ${team_identifier:-not set}"
