# ADR-0021 — macOS app embeds the Figma Mission Control frontend

Status: accepted for chantier 6 checkpoint 6.7.

## Context

The product visual identity and primary operator UX live in the Figma-derived
React app under `apps/web`. The native SwiftUI `.app` previously exposed a
simplified list/table shell that did not match that frontend. Operators opening
the macOS application therefore saw a different product surface from Mission
Control.

Hosting that frontend natively raises two constraints that shape the decision.
The control-plane bearer must stay in Keychain and never reach web storage, and
`WKURLSchemeHandler` — the only way to serve a bundle same-origin — does not
receive the HTTP body of a `fetch` request, so a naive proxy silently sends
every write with an empty payload.

## Decision

1. The installable macOS application hosts the Figma React build inside a
   `WKWebView` shell (`MissionControlWebView`). It is the only frontend the
   application contains: no build flag, environment variable or test mode
   substitutes a second shell.
2. `scripts/build-macos-webui.sh` builds `@avityos/web` with
   `VITE_AVITY_API=same-origin` and stages the artifacts into
   `apps/macos/Resources/WebUI`. That directory is a build output; only its
   `.gitkeep` is tracked, and a missing bundle renders a built-in notice naming
   the staging script instead of a blank window.
3. A custom `avity-app://` `WKURLSchemeHandler` serves those static assets and
   proxies `/v1/*` to the control plane, injecting the Keychain bearer so
   EventSource and `fetch` stay same-origin without widening CORS. Requests to
   any host other than `ui` are refused, `Origin`/`Referer`/`Host` are dropped,
   and the Keychain bearer is applied last so a page-supplied `Authorization`
   header cannot override it.
4. Because WebKit withholds `fetch` bodies from scheme handlers, an injected
   client shim re-sends the body base64-encoded in `X-Avity-Encoded-Body`. The
   handler decodes it into the proxied request and strips the header before the
   request leaves the application. `GET` and EventSource are untouched, so SSE
   still streams through the handler.
5. The application keeps the hardened runtime and declares the entitlements
   WebKit's helper processes require (`allow-jit`,
   `allow-unsigned-executable-memory`, `network.client`). Release packaging
   re-signs with `--force`, which discards entitlements, so it supplies them
   again and `verify-macos-app.sh` fails a release whose signature lost them.
6. Native concerns remain native: Keychain credentials, remote host/device
   pairing, menu bar, Dock badge, notifications and `avity://` deep links.
7. The web shell detects `window.__AVITY_NATIVE__`, applies Liquid Glass styling
   without the faux desktop chrome, and can open the native Settings scene.

## Consequences

- Packaging and XCUITest require the WebUI stage step before `xcodebuild`.
- The simplified SwiftUI project/mission/run/terminal views are deleted, not
  hidden. `AVITY_UI_TEST_MODE` only suppresses the notification prompt and
  background polling; it cannot change which interface is presented.
- Web and macOS share one frontend source of truth (the Figma Mission Control
  UI). Visual drift between surfaces is no longer acceptable.
- Settings for the control-plane token and the remote bridge stay in the macOS
  Settings scene, reachable from the shell toolbar and `avity://settings`.

## Evidence and limits

- XCUITest asserts the shipped shell: the main window hosts the embedded
  WebView, the native connection status is present, the retired sidebar
  identifiers are unreachable, and both the toolbar entry point and
  `avity://settings` open the native Settings scene. The React screens
  themselves are covered by the web workspace (vitest and Playwright) and are
  deliberately not duplicated in XCUITest.
- Swift tests cover bundle path resolution and SPA fallback, refusal of path
  escape outside the bundle, MIME typing, and the proxy contract: body
  restoration, query preservation, unbounded stream timeouts, dropped origin
  headers and bearer precedence.
- `scripts/verify-macos-app.sh` fails the release when `WebUI/index.html` is
  absent from the bundle, so an unstaged frontend cannot ship.
- Scheme-task callbacks are guarded against delivery after WebKit stops a task,
  which would otherwise raise an Objective-C exception, and each streaming
  session is invalidated so SSE reconnection does not leak sessions.
- Limits: the proxy is not exercised against a live control plane in CI, so the
  end-to-end write path through the encoded-body header is proven by unit tests
  and manual runs rather than an automated integration test. Web inspector
  tooling is compiled in only for `DEBUG` builds.
