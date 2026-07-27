import Foundation
import XCTest
@testable import AvityOS

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
            controlPlaneBaseURL: { WebUIProxyConfiguration.defaultLoopbackURL },
            bearerToken: { nil as String? }
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

    /// WebKit drops the HTTP body of a `fetch` before it reaches a custom
    /// scheme handler, so the client shim re-sends it as a header. Without this
    /// path every control-plane write would arrive with an empty payload.
    func testProxiedRequestRestoresTheEncodedBodyAndAttachesTheKeychainBearer() throws {
        let requestURL = try XCTUnwrap(URL(string: "avity-app://ui/v1/projects"))
        let payload = Data(#"{"name":"Atlas"}"#.utf8)
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue(
            payload.base64EncodedString(),
            forHTTPHeaderField: WebUISchemeHandler.encodedBodyHeader
        )
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("http://evil.example", forHTTPHeaderField: "Origin")
        request.setValue("Bearer page-supplied", forHTTPHeaderField: "Authorization")

        let proxied = try XCTUnwrap(
            WebUISchemeHandler.proxiedRequest(
                from: request,
                requestURL: requestURL,
                baseURL: WebUIProxyConfiguration.defaultLoopbackURL,
                bearerToken: "keychain-token"
            )
        )

        XCTAssertEqual(proxied.url?.absoluteString, "http://127.0.0.1:7717/v1/projects")
        XCTAssertEqual(proxied.httpMethod, "POST")
        XCTAssertEqual(proxied.httpBody, payload)
        XCTAssertEqual(proxied.value(forHTTPHeaderField: "content-type"), "application/json")
        // The Keychain bearer wins over anything the page supplied, and the
        // transport headers never leave the application.
        XCTAssertEqual(proxied.value(forHTTPHeaderField: "Authorization"), "Bearer keychain-token")
        XCTAssertNil(proxied.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(
            proxied.value(forHTTPHeaderField: WebUISchemeHandler.encodedBodyHeader)
        )
    }

    func testProxiedRequestPreservesQueryAndKeepsStreamsOpen() throws {
        let requestURL = try XCTUnwrap(
            URL(string: "avity-app://ui/v1/events/stream?since=42")
        )
        var request = URLRequest(url: requestURL)
        request.httpMethod = "GET"

        let proxied = try XCTUnwrap(
            WebUISchemeHandler.proxiedRequest(
                from: request,
                requestURL: requestURL,
                baseURL: WebUIProxyConfiguration.defaultLoopbackURL,
                bearerToken: nil
            )
        )

        XCTAssertEqual(
            proxied.url?.absoluteString,
            "http://127.0.0.1:7717/v1/events/stream?since=42"
        )
        XCTAssertEqual(proxied.timeoutInterval, 0)
        XCTAssertNil(proxied.value(forHTTPHeaderField: "Authorization"))
    }

    func testMissingBundleNoticeNamesTheStagingScript() {
        XCTAssertTrue(
            WebUISchemeHandler.missingBundleHTML.contains("build-macos-webui.sh")
        )
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
