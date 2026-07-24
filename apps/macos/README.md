# AvityOS — native macOS app

A SwiftUI application (Swift Package Manager executable) that connects to the
local AvityOS control plane: Keychain authentication, SSE plus polling
reconnection, project/mission/run/terminal views, approve/reject interventions,
deep links, native notifications, Dock badge, settings, and a menu-bar
companion showing live counts. The native API client enforces HTTPS away from
loopback, preserves structured API errors and resumes SSE from its last durable
event cursor instead of replaying the full history after every reconnect. Its
host-mode settings initialize the end-to-end encrypted remote bridge, create
one-time pairing offers, accept encrypted requests, return encrypted device
bootstraps and revoke paired devices.
As a paired remote device it implements the same protocol with CryptoKit,
stores its identity/bearer/replay state in Keychain and routes the existing
native screens through the ciphertext relay. Local and remote credentials stay
independent and the active transport is explicit in the toolbar and menu bar.

## Development and UI tests

```sh
cd apps/macos
swift build            # compile
swift test             # deterministic transport, contract and Keychain tests
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
checking, treats every Swift warning as an error, runs XCUITest against the
actual `.app`, and packages a verified universal development artifact.

SwiftPM development requires the Command Line Tools with the macOS SDK;
XCUITest and bundle packaging require Xcode 15+. The application supports
macOS 14+. Start the control plane first:
`pnpm --filter @avityos/control-plane start`.

## Installable application bundle

From the repository root:

```sh
./scripts/build-macos-app.sh
```

This emits `dist/macos/AvityOS.app`, a tested
`AvityOS-macos-universal.zip`, and its SHA-256 checksum. The binary contains
both `arm64` and `x86_64`, registers `avity://`, includes the native icon and is
ad hoc signed for development/CI. Install by dragging the verified app to
Applications, or use an explicit writable destination:

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

- The app talks to the loopback control plane by default. The API token is
  always stored in macOS Keychain, never UserDefaults or a plist. Remote
  endpoints are rejected unless they use HTTPS. Bearers are sent only in
  Authorization headers and never appear in URLs.
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
  interoperability.
- The wire models in `ApiClient.swift` mirror `packages/contracts`; update
  them together.
