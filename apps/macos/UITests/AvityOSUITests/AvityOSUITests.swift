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
            element("screen.settings", in: app).waitForExistence(timeout: 10),
            "UI-test shell should embed native settings"
        )
        XCTAssertTrue(element("settings.endpoint", in: app).exists)
        XCTAssertTrue(element("settings.apiToken", in: app).exists)
        XCTAssertTrue(element("settings.save", in: app).exists)
    }

    @MainActor
    func testRegisteredDeepLinkOpensSettings() throws {
        let app = launchApp()
        defer { app.terminate() }

        XCTAssertTrue(
            element("screen.settings", in: app).waitForExistence(timeout: 10),
            "Settings should be visible in the UI-test shell"
        )

        let deepLink = try XCTUnwrap(URL(string: "avity://settings"))
        app.open(deepLink)
        app.activate()

        XCTAssertTrue(
            element("settings.endpoint", in: app).waitForExistence(timeout: 10),
            "Deep link should keep settings visible"
        )
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
