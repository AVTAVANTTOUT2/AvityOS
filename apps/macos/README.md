# AvityOS — native macOS app

A SwiftUI application (Swift Package Manager executable) that connects to the
local AvityOS control plane: Keychain authentication, SSE plus polling
reconnection, project/mission/run/terminal views, approve/reject interventions,
deep links, native notifications, Dock badge, settings, and a menu-bar
companion showing live counts. The native API client enforces HTTPS away from
loopback, preserves structured API errors and resumes SSE from its last durable
event cursor instead of replaying the full history after every reconnect.

## Development build (no certificate required)

```sh
cd apps/macos
swift build            # compile
swift test             # deterministic transport, contract and Keychain tests
swift run AvityOS      # launch against http://127.0.0.1:7717
```

CI compiles both the application and tests with complete strict-concurrency
checking and treats every Swift warning as an error.

Requires Xcode (or the Command Line Tools with the macOS SDK) and macOS 14+.
Start the control plane first: `pnpm --filter @avityos/control-plane start`.

## Signing & notarization (release builds)

Development builds run unsigned locally. For distribution:

1. Wrap the executable in an `.app` bundle (an `Info.plist` with
   `LSUIElement=false`, bundle id `com.avityos.app`).
2. Sign: `codesign --deep --options runtime -s "Developer ID Application: <team>" AvityOS.app`
3. Notarize: `xcrun notarytool submit AvityOS.zip --keychain-profile <profile> --wait`
4. Staple: `xcrun stapler staple AvityOS.app`

An Apple Developer ID certificate is required for steps 2–4; nothing in the
development workflow depends on it.

## Security notes

- The app talks to the loopback control plane by default. The API token is
  always stored in macOS Keychain, never UserDefaults or a plist. Remote
  endpoints are rejected unless they use HTTPS. Bearers are sent only in
  Authorization headers and never appear in URLs.
- The wire models in `ApiClient.swift` mirror `packages/contracts`; update
  them together.
