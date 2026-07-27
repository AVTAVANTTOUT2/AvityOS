# ADR-0021 — macOS app embeds the Figma Mission Control frontend

Status: accepted.

## Context

The product visual identity and primary operator UX live in the Figma-derived
React app under `apps/web`. The native SwiftUI `.app` previously exposed a
simplified list/table shell that did not match that frontend. Operators opening
the macOS application therefore saw a different product surface from Mission
Control.

## Decision

1. The installable macOS application hosts the Figma React build inside a
   `WKWebView` shell (`MissionControlWebView`).
2. `scripts/build-macos-webui.sh` builds `@avityos/web` with
   `VITE_AVITY_API=same-origin` and stages the artifacts into
   `apps/macos/Resources/WebUI`.
3. A custom `avity-app://` `WKURLSchemeHandler` serves those static assets and
   proxies `/v1/*` to the control plane, injecting the Keychain bearer so
   EventSource and `fetch` stay same-origin without widening CORS.
4. Native concerns remain native: Keychain credentials, remote host/device
   pairing, menu bar, Dock badge, notifications and `avity://` deep links.
5. The web shell detects `window.__AVITY_NATIVE__`, applies Liquid Glass styling
   without the faux desktop chrome, and can open the native Settings scene.

## Consequences

- Packaging and XCUITest require the WebUI stage step before `xcodebuild`.
- The simplified SwiftUI project/mission tables are removed from the main
  window; settings for the control-plane token and remote bridge stay in the
  macOS Settings scene.
- Web and macOS share one frontend source of truth (the Figma Mission Control
  UI). Visual drift between surfaces is no longer acceptable.
