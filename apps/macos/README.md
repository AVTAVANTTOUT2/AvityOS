# AvityOS — native macOS app

A SwiftUI application (Swift Package Manager executable) that connects to the
local AvityOS control plane: sidebar navigation, project/mission/run views,
approve/reject interventions, connection status, and a menu-bar companion
showing live counts.

## Development build (no certificate required)

```sh
cd apps/macos
swift build            # compile
swift run AvityOS      # launch against http://127.0.0.1:7717
```

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

- The app talks to the loopback control plane by default; remote planes
  require the API token, which must be stored in the macOS Keychain
  (see docs/SECURITY.md — never in UserDefaults or plists).
- The wire models in `ApiClient.swift` mirror `packages/contracts`; update
  them together.
