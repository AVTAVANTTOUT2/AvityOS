import AppKit
import XCTest

final class AvityOSUITests: XCTestCase {
    @MainActor
    func testPrimaryNavigationAndOfflineStatus() {
        let app = launchApp()
        defer { app.terminate() }
        let statusExists = element("connection.status", in: app).exists
        let projectsExists = element("screen.projects", in: app).exists
        XCTAssertTrue(statusExists)
        XCTAssertTrue(projectsExists)

        select("sidebar.missions", row: 1, screen: "screen.missions", in: app)
        select(
            "sidebar.interventions",
            row: 2,
            screen: "screen.interventions",
            in: app
        )
        let emptyInterventionsExists =
            app.staticTexts["Aucune intervention en attente"].exists
        XCTAssertTrue(emptyInterventionsExists)
        select("sidebar.runs", row: 3, screen: "screen.runs", in: app)
        select("sidebar.terminals", row: 4, screen: "screen.terminals", in: app)
        select("sidebar.settings", row: 5, screen: "screen.settings", in: app)

        let endpointExists = element("settings.endpoint", in: app).exists
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
        XCTAssertTrue(settingsAppeared)
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
    private func select(
        _ identifier: String,
        row: Int,
        screen: String,
        in app: XCUIApplication
    ) {
        let item = element(identifier, in: app)
        let itemAppeared = item.waitForExistence(timeout: 5)
        XCTAssertTrue(
            itemAppeared,
            "Missing sidebar item \(identifier)"
        )
        let sidebar = app.outlines["Sidebar"]
        let destination = sidebar.cells.element(boundBy: row)
        XCTAssertTrue(
            destination.exists,
            "Missing sidebar row \(row) for \(identifier)"
        )
        destination.click()
        let screenAppeared = element(
            screen,
            in: app
        ).waitForExistence(timeout: 5)
        XCTAssertTrue(
            screenAppeared,
            "Missing destination \(screen)"
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
