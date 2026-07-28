# ADR-0022 — macOS 26 baseline and Liquid Glass native chrome

Status: accepted for chantier 6 checkpoint 6.8.

## Context

ADR-0021 makes the Figma Mission Control build the application's only frontend,
hosted in a `WKWebView`. What remains native is the chrome around it: the window
header, the Settings scene and the menu-bar companion. That chrome was styled
with `ultraThinMaterial` and a plain grouped `Form`, so it read as a different
product from the embedded UI it frames.

Apple's Liquid Glass APIs — `glassEffect`, `GlassEffectContainer`, the `glass`
and `glassProminent` button styles — are the system's own translucency,
refraction and accessibility behaviour. They exist only in the macOS 26 SDK, and
only run on macOS 26. Reproducing them by hand would drift from the platform at
every OS release, and gating them behind availability checks would mean shipping
and maintaining two visual systems for the same surfaces.

The previous baseline, macOS 14, is also the deprecated `macos-14` GitHub
Actions image.

## Decision

1. The minimum supported system becomes macOS 26. `Package.swift`, `project.yml`
   and the Xcode project all declare it, `verify-macos-app.sh` refuses a bundle
   whose `LSMinimumSystemVersion` is anything else, and CI runs on `macos-26`.
2. Native chrome uses Apple's Liquid Glass APIs directly, with no fallback path
   and no hand-rolled translucency, so there is exactly one visual system.
3. The reusable settings surfaces live alongside `SettingsView`: glass cards,
   connection summaries, pairing steps and diagnostic rows share spacing,
   typography, symbols and semantic status colours.
4. Transport state always combines a label and SF Symbol with its colour, so
   colour is never the only signal.
5. The main window uses the system unified toolbar. Product identity, live
   connection state, refresh and Settings actions use native glass surfaces
   while the embedded UI remains unchanged below it.
6. Settings is a `NavigationSplitView` over four destinations — control plane,
   host bridge, this device, diagnostics — instead of one scrolling `Form`.
   Out-of-band pairing is presented as numbered steps that state their rank and
   direction and carry their own action.
7. The menu-bar companion reports live transport state and counts, and exposes
   refresh, opening the main window and Settings as direct actions.

## Consequences

- The application no longer installs or runs on macOS 14 or 15. This is a user
  visible break, not only a build setting.
- Contributors need Xcode 26. Earlier toolchains cannot compile the native
  target at all, since the glass APIs are unconditional.
- The XCUITest identifiers the suite asserts (`connection.status`,
  `toolbar.native-settings`, `screen.settings`, `settings.endpoint`,
  `settings.apiToken`, `settings.save`) are preserved across the redesign, and
  containers that carry an identifier also declare
  `accessibilityElement(children: .contain)` so their children stay queryable.
- Only the `.app` and the build settings it needs are affected. The web
  workspace, control plane, CLI and services are untouched; the embedded UI
  keeps its own Liquid Glass styling from `apps/web`.

## Evidence and limits

- CI builds and runs the XCUITest suite against the macOS 26 SDK, so the glass
  APIs are compile-checked on every pull request.
- Limits: no automated test asserts the *appearance* of the glass surfaces —
  XCUITest proves the controls exist and respond, not that they render as
  intended. Visual verification remains manual. The baseline jump was taken
  deliberately in exchange for a single, system-native visual system; if support
  for macOS 14/15 is ever required again, it means reintroducing a second
  styling path, not merely relaxing a version string.
