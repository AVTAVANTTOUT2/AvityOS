import Foundation
import XCTest

final class WebUISchemeHandlerTests: XCTestCase {
    func testResolvedFileURLServesIndexForRootAndRejectsEscape() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("avity-webui-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let index = root.appendingPathComponent("index.html")
        try "<html>ok</html>".write(to: index, atomically: true, encoding: .utf8)
        let assetDir = root.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assetDir, withIntermediateDirectories: true)
        let asset = assetDir.appendingPathComponent("app.js")
        try "console.log(1)".write(to: asset, atomically: true, encoding: .utf8)

        let handler = WebUISchemeHandler(
            resourceRoot: root,
            controlPlaneBaseURL: { ApiClient.defaultLoopbackURL },
            bearerToken: { nil }
        )

        XCTAssertEqual(try handler.resolvedFileURL(for: "/").path, index.path)
        XCTAssertEqual(try handler.resolvedFileURL(for: "/assets/app.js").path, asset.path)
        XCTAssertEqual(
            try handler.resolvedFileURL(for: "/missing-spa-route").path,
            index.path
        )
        XCTAssertThrowsError(try handler.resolvedFileURL(for: "/../secret.txt")) { error in
            XCTAssertEqual(error as? WebUISchemeError, .pathEscape)
        }
    }

    func testMimeTypeCoversWebBundleExtensions() {
        XCTAssertEqual(
            WebUISchemeHandler.mimeType(for: URL(fileURLWithPath: "/tmp/index.html")),
            "text/html"
        )
        XCTAssertEqual(
            WebUISchemeHandler.mimeType(for: URL(fileURLWithPath: "/tmp/app.js")),
            "text/javascript"
        )
        XCTAssertEqual(
            WebUISchemeHandler.mimeType(for: URL(fileURLWithPath: "/tmp/theme.css")),
            "text/css"
        )
    }
}
