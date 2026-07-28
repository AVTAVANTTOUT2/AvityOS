# AvityOS — native macOS app

A SwiftUI application that embeds the Figma Mission Control frontend
(`apps/web`) inside a `WKWebView` shell. Native capabilities remain native:
Keychain authentication, SSE/polling via the control-plane proxy, remote
host/device pairing, deep links, notifications, Dock badge, settings and a
menu-bar companion.

The installable `.app` therefore shows the same cream/indigo Mission Control UI
as the web product ([Figma](https://www.figma.com/design/MnTdZbrH4OHTHD8NbZC6iz/Start-project)),
not a simplified SwiftUI list shell. That embedded frontend is the only one the
application contains — no flag or environment variable restores the previous
shell, and XCUITest therefore runs against the surface operators receive. See
[ADR-0021](../../docs/adr/0021-macos-figma-webview-shell.md).

The native shell targets macOS 26 and uses Apple Liquid Glass directly:
unified window toolbars, glass controls and status surfaces, plus a native
glass sidebar for the redesigned Settings experience. The embedded React
content remains the shared web source of truth and is not restyled by SwiftUI.

## Development and UI tests

`Resources/WebUI` is a build output. Stage it before Xcode or SwiftPM runs;
launching without it renders a notice naming the script rather than a blank
window.

```sh
# Stage the Figma frontend into Resources/WebUI (required before Xcode runs)
./scripts/build-macos-webui.sh

cd apps/macos
swift build            # compile
swift test             # deterministic transport, contract, Keychain and WebUI tests
swift run AvityOS      # launch against http://127.0.0.1:7717

# Genuine application-level macOS automation
xcodebuild test \
  -project AvityOS.xcodeproj \
  -scheme AvityOS \
  -destination "platform=macOS" \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual
```

CI compiles both the application and tests with complete strict-concurrency
checking, treats every Swift warning as an error, stages the Figma WebUI,
runs XCUITest against the actual `.app`, and packages a verified universal
development artifact.

SwiftPM development requires the macOS 26 SDK; XCUITest and bundle packaging
require Xcode 26+. The application supports macOS 26+. Start the control plane
first:
`pnpm --filter @avityos/control-plane start`.

## Installable application bundle

From the repository root:

```sh
./scripts/build-macos-app.sh
```

This builds the Figma WebUI, emits `dist/macos/AvityOS.app`, a tested
`AvityOS-macos-universal.zip`, and its SHA-256 checksum. The binary contains
both `arm64` and `x86_64`, registers `avity://`, includes the native icon and
embedded Mission Control UI, and is ad hoc signed for development/CI. Install
by dragging the verified app to Applications, or use an explicit writable
destination:

```sh
./scripts/install-macos-app.sh \
  "$PWD/dist/macos/AvityOS.app" \
  "/Applications"
```

The installer preserves an existing app as a timestamped backup. It never
removes Gatekeeper quarantine metadata.

## Developer ID signing and notarization

Build with an installed Developer ID identity, then notarize with an existing
notarytool Keychain profile:

```sh
AVITY_CODESIGN_IDENTITY="Developer ID Application: Example (TEAMID)" \
  ./scripts/build-macos-app.sh

AVITY_NOTARY_PROFILE="avityos-notary" \
  ./scripts/notarize-macos-app.sh \
  "$PWD/dist/macos/AvityOS.app"
```

The notarization script refuses ad hoc signatures and missing profiles,
waits for Apple, staples and validates the ticket, runs Gatekeeper assessment,
then recreates the ZIP/checksum from the stapled app. Apple credentials are
never required for development or pull-request CI.

## Security notes

- The embedded WebUI talks to the control plane through an `avity-app://`
  scheme handler that injects the Keychain bearer. The token never enters
  UserDefaults, the URL bar or web localStorage.
- Remote endpoints are rejected unless they use HTTPS. Bearers are sent only
  in Authorization headers and never appear in URLs.
- Remote-host private identities and relay credentials are held in macOS
  Keychain. Public certificates, replay cursors and metadata-only audit use the
  private mode-0600 bridge database. Host pairing secrets are
  process-memory-only; the per-device relay bearer is transferred only inside
  the encrypted bootstrap.
- Remote-device identity, private keys, certificates, bearer, sequences,
  cursor and pending acknowledgement are also Keychain-only. The app persists
  the outbound sequence before publish and the inbound sequence before ack, so
  a crash creates at most a gap and never nonce/sequence reuse or an
  unauthenticated replay. The committed Node vector certifies CryptoKit wire
  interoperability. Renewal responses replace Keychain certificates only
  after both account signatures, unchanged identities/keys and extended
  validity intervals pass validation; an expired certificate requires a fresh
  pairing.
- The wire models in `ApiClient.swift` mirror `packages/contracts`; update
  them together.
