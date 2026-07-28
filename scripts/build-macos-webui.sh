#!/bin/bash
# Builds the Figma Mission Control frontend for embedding inside AvityOS.app.
# Same-origin API calls (`VITE_AVITY_API=same-origin`) are proxied by the
# native WKURLSchemeHandler with the Keychain bearer.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/.." && pwd)"
web_root="$repository_root/apps/web"
output_dir="${AVITY_MACOS_WEBUI_DIR:-$repository_root/apps/macos/Resources/WebUI}"

command -v pnpm >/dev/null || {
  echo "pnpm is required to build the embedded Figma WebUI" >&2
  exit 69
}

if [[ "$output_dir" != /* || "$output_dir" == "/" ]]; then
  echo "AVITY_MACOS_WEBUI_DIR must be an absolute non-root path" >&2
  exit 64
fi

mkdir -p "$output_dir"
# Clear previous artifacts but keep the tracked .gitkeep, so staging the bundle
# never leaves the working tree dirty.
find "${output_dir:?}" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +

(
  cd "$repository_root"
  VITE_AVITY_API=same-origin pnpm --filter @avityos/web build
)

dist_dir="$web_root/dist"
if [[ ! -f "$dist_dir/index.html" ]]; then
  echo "Web build did not produce dist/index.html" >&2
  exit 65
fi

cp -R "$dist_dir"/. "$output_dir"/

if [[ ! -f "$output_dir/index.html" ]]; then
  echo "Failed to stage WebUI at $output_dir" >&2
  exit 65
fi

echo "Embedded Figma WebUI: $output_dir"
