import AppKit
import XCTest

/// ADR-0021: the installable application ships a single frontend — the Figma
/// Mission Control build hosted in a `WKWebView`. These tests therefore assert
/// the shipped shell and the native surfaces around it. The React UI itself is
/// covered by the web workspace (vitest + Playwright), not duplicated here.
final class AvityOSUITests: XCTestCase {
    @MainActor
    func testMainWindowHostsTheEmbeddedMissionControlShell() {
        let app = launchApp()
        defer { app.terminate() }

        let statusAppeared = element("connection.status", in: app)
            .waitForExistence(timeout: 10)
        XCTAssertTrue(statusAppeared, "Missing native connection status.\(tree(app))")

        // WebKit may expose the host view by identifier or as a web-view
        // element depending on when the remote accessibility tree attaches.
        let webViewAppeared = app.webViews.firstMatch.waitForExistence(timeout: 20)
            || element("webview.figma-shell", in: app).waitForExistence(timeout: 10)
        XCTAssertTrue(
            webViewAppeared,
            "The main window does not host the embedded Mission Control WebView.\(tree(app))"
        )

        // The simplified SwiftUI list/table shell is removed, not hidden behind
        // a flag: no build of the application may present it again.
        for retired in ["sidebar.projects", "sidebar.missions", "sidebar.runs"] {
            XCTAssertFalse(
                element(retired, in: app).exists,
                "The retired native sidebar \(retired) is still reachable"
            )
        }
    }

    @MainActor
    func testToolbarOpensTheNativeSettingsScene() {
        let app = launchApp()
        defer { app.terminate() }

        let settingsButton = element("toolbar.native-settings", in: app)
        let buttonAppeared = settingsButton.waitForExistence(timeout: 10)
        XCTAssertTrue(buttonAppeared, "Missing native settings entry point.\(tree(app))")
        settingsButton.click()

        assertNativeSettingsAreReachable(in: app)
    }

    @MainActor
    func testRegisteredDeepLinkOpensSettings() throws {
        let app = launchApp()
        defer { app.terminate() }
        let workspace = NSWorkspace.shared
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("AvityOS.app")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: appURL.path),
            "Missing built application at \(appURL.path)"
        )
        let deepLink = try XCTUnwrap(URL(string: "avity://settings"))
        workspace.open(
            [deepLink],
            withApplicationAt: appURL,
            configuration: NSWorkspace.OpenConfiguration(),
            completionHandler: nil
        )

        assertNativeSettingsAreReachable(in: app)
    }

    /// Control-plane credentials and the remote bridge stay native: the web
    /// shell never renders a token form (ADR-0021).
    @MainActor
    private func assertNativeSettingsAreReachable(in app: XCUIApplication) {
        let settingsAppeared = element("screen.settings", in: app)
            .waitForExistence(timeout: 15)
        XCTAssertTrue(
            settingsAppeared,
            "The native Settings scene did not open.\(tree(app))"
        )

        let endpointExists = element("settings.endpoint", in: app).exists
        let tokenExists = element("settings.apiToken", in: app).exists
        let saveExists = element("settings.save", in: app).exists
        XCTAssertTrue(endpointExists)
        XCTAssertTrue(tokenExists)
        XCTAssertTrue(saveExists)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Suppresses the notification prompt and polling only. The shell under
        // test is the production shell.
        app.launchEnvironment["AVITY_UI_TEST_MODE"] = "1"
        app.launchArguments += [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-NSQuitAlwaysKeepsWindows",
            "NO",
        ]
        app.launch()
        let windowAppeared = app.windows.firstMatch.waitForExistence(timeout: 10)
        XCTAssertTrue(
            windowAppeared,
            "The native application window did not appear"
        )
        return app
    }

    @MainActor
    private func element(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    /// Attaches the live accessibility hierarchy to a failure. A missing
    /// identifier is otherwise indistinguishable from a window that never
    /// rendered, and this suite only fails on CI.
    @MainActor
    private func tree(_ app: XCUIApplication) -> String {
        "\nAccessibility hierarchy:\n\(app.debugDescription)"
    }
}
