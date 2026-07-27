import AppKit
import XCTest

final class AvityOSUITests: XCTestCase {
    @MainActor
    func testFigmaShellLaunchesWithConnectionStatus() {
        let app = launchApp()
        defer { app.terminate() }

        XCTAssertTrue(
            element("connection.status", in: app).waitForExistence(timeout: 10),
            "Missing connection status in the native chrome"
        )
        XCTAssertTrue(
            element("screen.mission-control", in: app).waitForExistence(timeout: 10),
            "Missing Mission Control container"
        )
        XCTAssertTrue(
            element("toolbar.native-settings", in: app).waitForExistence(timeout: 5),
            "Missing native settings toolbar button"
        )

        openSettings(in: app)

        XCTAssertTrue(
            element("settings.endpoint", in: app).waitForExistence(timeout: 10),
            "Settings endpoint field did not appear"
        )
        XCTAssertTrue(element("settings.apiToken", in: app).exists)
        XCTAssertTrue(element("settings.save", in: app).exists)
    }

    @MainActor
    func testRegisteredDeepLinkOpensSettings() throws {
        let app = launchApp()
        defer { app.terminate() }

        let deepLink = try XCTUnwrap(URL(string: "avity://settings"))
        app.open(deepLink)
        app.activate()

        XCTAssertTrue(
            element("settings.endpoint", in: app).waitForExistence(timeout: 10),
            "Deep link did not open native settings"
        )
        XCTAssertTrue(element("screen.settings", in: app).exists)
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
    private func openSettings(in app: XCUIApplication) {
        element("toolbar.native-settings", in: app).click()
        if element("settings.endpoint", in: app).waitForExistence(timeout: 3) {
            return
        }
        app.typeKey(",", modifierFlags: [.command])
        XCTAssertTrue(
            element("settings.endpoint", in: app).waitForExistence(timeout: 10),
            "Settings window did not open"
        )
    }

    @MainActor
    private func element(
        _ identifier: String,
        in app: XCUIApplication
    ) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }
}
