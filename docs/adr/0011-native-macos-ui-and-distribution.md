# ADR-0011 — Native macOS UI automation and distribution bundle

Status: accepted for chantier 6 checkpoint 4.

## Context

The Swift package proved the native client logic but did not produce the
artifact users install. Deep links, sidebar navigation and the complete
settings surface were not exercised through macOS accessibility, and release
instructions relied on a manual `.app` wrapper. That left bundle metadata,
architectures, signing and replacement behavior outside reproducible checks.

Public distribution also requires Apple credentials that are intentionally
absent from local development and pull-request CI. The build must therefore
distinguish a fully verifiable development artifact from a Developer ID signed
and notarized public release without weakening either path.

## Decision

1. `apps/macos/project.yml` is the declarative XcodeGen source and the generated
   shared `AvityOS.xcodeproj` is committed. The project builds a real SwiftUI
   application plus an XCUITest runner. SwiftPM remains the fast unit and
   Thread Sanitizer path.
2. The bundle owns a complete `Info.plist`: stable identifier
   `com.avityos.app`, macOS 14 minimum, Developer Tools category, semantic/build
   versions, `avity` URL scheme and a native `.icns` asset. The Release binary
   is universal (`arm64` and `x86_64`).
3. XCUITest launches the actual application in an explicit fixture-free test
   mode that suppresses notification authorization and background polling.
   Stable accessibility identifiers exercise every primary sidebar destination,
   offline status, settings controls and a registered `avity://settings` deep
   link. Product network and credential behavior is still covered by the
   deterministic XCTest transport suites.
4. `scripts/build-macos-app.sh` performs a clean Xcode Release build, manually
   signs it, verifies metadata, signature, architectures and absence of test
   bundles, then emits a tested ZIP and SHA-256 checksum. With no configured
   identity it uses an explicit ad hoc signature and labels the artifact as
   development-only.
5. Setting `AVITY_CODESIGN_IDENTITY` selects timestamped hardened-runtime
   Developer ID signing. `scripts/notarize-macos-app.sh` fails closed unless an
   existing `AVITY_NOTARY_PROFILE` and a Team-ID-bearing signature are present;
   it submits, waits, staples, assesses and recreates the distributable archive.
   Credentials never enter arguments, files or repository configuration.
6. Installation is either normal Finder drag-and-drop or
   `scripts/install-macos-app.sh` with an explicit writable absolute directory.
   The script verifies the source, stages the copy atomically and moves an
   existing installation to a timestamped recoverable backup.
7. macOS CI runs SwiftPM tests, genuine XCUITest and the universal packaging
   verifier. It uploads the ad hoc ZIP, checksum and `.xcresult` as short-lived
   evidence. This artifact is not represented as notarized.

## Evidence and limits

- Local XCUITest passes two application-level scenarios on the native
  accessibility stack.
- The build verifier proves bundle ID, version, minimum OS, URL scheme,
  executable, `arm64` + `x86_64`, strict codesign validity and absence of test
  bundles; archive integrity and replacement-with-backup installation are also
  reproduced.
- A public Gatekeeper release still requires an operator-owned Apple Developer
  ID certificate and notarytool Keychain profile. No such identity is installed
  in CI, so notarization cannot be truthfully certified there.
- Certificate renewal and in-application update delivery remain later chantier
  6/7 checkpoints.
