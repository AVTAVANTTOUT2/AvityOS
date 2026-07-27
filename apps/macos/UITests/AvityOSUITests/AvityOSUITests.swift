import AppKit
import XCTest

final class AvityOSUITests: XCTestCase {
    @MainActor
    func testFigmaShellLaunchesWithConnectionStatus() {
        let app = launchApp()
        defer { app.terminate() }

        let statusExists = element("connection.status", in: app).waitForExistence(timeout: 10)
        let shellExists = element("webview.figma-shell", in: app).waitForExistence(timeout: 10)
        let missionControlExists = element("screen.mission-control", in: app).exists
        XCTAssertTrue(statusExists, "Missing connection status in the native chrome")
        XCTAssertTrue(shellExists, "Missing embedded Figma WKWebView shell")
        XCTAssertTrue(missionControlExists, "Missing Mission Control container")

        let settingsButton = element("toolbar.native-settings", in: app)
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 5))
        settingsButton.click()

        let endpointExists = element("settings.endpoint", in: app).waitForExistence(timeout: 5)
        let tokenExists = element("settings.apiToken", in: app).exists
        let saveExists = element("settings.save", in: app).exists
        XCTAssertTrue(endpointExists)
        XCTAssertTrue(tokenExists)
        XCTAssertTrue(saveExists)
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
        let settingsAppeared = element(
            "screen.settings",
            in: app
        ).waitForExistence(timeout: 5)
        let endpointAppeared = element(
            "settings.endpoint",
            in: app
        ).waitForExistence(timeout: 5)
        XCTAssertTrue(settingsAppeared)
        XCTAssertTrue(endpointAppeared)
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
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
}
