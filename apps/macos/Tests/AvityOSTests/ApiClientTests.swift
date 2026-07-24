import Foundation
import XCTest
@testable import AvityOS

private final class MemoryCredentialStore: CredentialStore {
    var token: String?
    private(set) var savedTokens: [String] = []

    init(token: String? = nil) {
        self.token = token
    }

    func loadToken() throws -> String? {
        token
    }

    func saveToken(_ token: String) throws {
        self.token = token
        savedTokens.append(token)
    }

    func deleteToken() throws {
        token = nil
    }
}

private final class URLProtocolStub: URLProtocol {
    struct Stub {
        let status: Int
        let headers: [String: String]
        let body: Data

        init(
            status: Int = 200,
            headers: [String: String] = ["content-type": "application/json"],
            body: String
        ) {
            self.status = status
            self.headers = headers
            self.body = Data(body.utf8)
        }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            let stub = try URLProtocolRegistry.shared.response(for: request)
            guard let url = request.url, let response = HTTPURLResponse(
                url: url,
                statusCode: stub.status,
                httpVersion: "HTTP/1.1",
                headerFields: stub.headers
            ) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: stub.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class URLProtocolRegistry: @unchecked Sendable {
    typealias Handler = (URLRequest) throws -> URLProtocolStub.Stub

    static let shared = URLProtocolRegistry()

    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]

    func install(id: String, handler: @escaping Handler) {
        lock.lock()
        handlers[id] = handler
        lock.unlock()
    }

    func remove(id: String) {
        lock.lock()
        handlers.removeValue(forKey: id)
        lock.unlock()
    }

    func response(for request: URLRequest) throws -> URLProtocolStub.Stub {
        guard let id = request.value(forHTTPHeaderField: "x-avity-test-session") else {
            throw URLError(.resourceUnavailable)
        }
        lock.lock()
        let handler = handlers[id]
        lock.unlock()
        guard let handler else {
            throw URLError(.resourceUnavailable)
        }
        return try handler(request)
    }
}

private struct URLProtocolTestContext {
    let id = UUID().uuidString
    let session: URLSession
    let defaults: UserDefaults
    let defaultsSuite: String

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        configuration.httpAdditionalHeaders = ["x-avity-test-session": id]
        session = URLSession(configuration: configuration)
        defaultsSuite = "ApiClientTests-\(id)"
        defaults = UserDefaults(suiteName: defaultsSuite)!
    }

    func install(_ handler: @escaping URLProtocolRegistry.Handler) {
        URLProtocolRegistry.shared.install(id: id, handler: handler)
    }

    func cleanUp() {
        URLProtocolRegistry.shared.remove(id: id)
        session.invalidateAndCancel()
        defaults.removePersistentDomain(forName: defaultsSuite)
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        return Data()
    }
    stream.open()
    defer { stream.close() }
    var body = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 4_096)
        if count < 0 {
            throw stream.streamError ?? URLError(.cannotDecodeContentData)
        }
        if count == 0 { break }
        body.append(buffer, count: count)
    }
    return body
}

final class ApiClientTests: XCTestCase {
    @MainActor
    func testEndpointPolicyRequiresHTTPSOutsideLoopback() throws {
        XCTAssertThrowsError(
            try ApiClient.validatedEndpoint(URL(string: "http://control.example")!)
        ) { error in
            XCTAssertEqual(error as? ApiClientError, .insecureRemoteEndpoint)
        }
        XCTAssertThrowsError(
            try ApiClient.validatedEndpoint(URL(string: "https://user:pass@control.example")!)
        ) { error in
            XCTAssertEqual(error as? ApiClientError, .invalidEndpoint)
        }
        XCTAssertEqual(
            try ApiClient.validatedEndpoint(URL(string: "http://localhost:7717/api")!)
                .absoluteString,
            "http://localhost:7717/api/"
        )
        XCTAssertEqual(
            try ApiClient.validatedEndpoint(URL(string: "https://control.example")!)
                .absoluteString,
            "https://control.example/"
        )
    }

    @MainActor
    func testSSECursorResumesFromLatestEventID() {
        var cursor = SSEEventCursor(lastSequence: 41)
        XCTAssertFalse(cursor.consume(line: "id: 42"))
        XCTAssertTrue(cursor.consume(line: "data: {\"type\":\"mission.updated\"}"))
        XCTAssertEqual(cursor.lastSequence, 42)
        XCTAssertFalse(cursor.consume(line: ""))
        XCTAssertFalse(cursor.consume(line: "id: 40"))
        XCTAssertTrue(cursor.consume(line: "data: {}"))
        XCTAssertEqual(cursor.lastSequence, 42)
    }

    @MainActor
    func testRefreshDecodesCanonicalTerminalAndSendsBearer() async {
        let context = URLProtocolTestContext()
        defer { context.cleanUp() }
        let token = "native-client-token"
        var protectedRequests = 0
        context.install { request in
            let path = request.url!.path
            let query = request.url!.query.map { "?\($0)" } ?? ""
            XCTAssertFalse(request.url!.absoluteString.contains(token))
            if path != "/v1/health" {
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "authorization"),
                    "Bearer \(token)"
                )
                protectedRequests += 1
            }
            switch path + query {
            case "/v1/health":
                return .init(body: #"{"status":"ok","version":"test"}"#)
            case "/v1/projects":
                return .init(body: #"{"items":[{"id":"prj_1","name":"Native","status":"active","autonomyProfile":"autonomous","description":"Ready"}]}"#)
            case "/v1/projects/prj_1/missions":
                return .init(body: #"{"items":[]}"#)
            case "/v1/approvals?status=open", "/v1/runs":
                return .init(body: #"{"items":[]}"#)
            case "/v1/terminals":
                return .init(body: #"{"items":[{"id":"term_1","projectId":"prj_1","command":"pnpm test","state":"succeeded","exitCode":0}]}"#)
            default:
                XCTFail("Unexpected request: \(path + query)")
                return .init(status: 404, body: #"{"error":{"code":"not_found","message":"missing"}}"#)
            }
        }
        let client = ApiClient(
            baseURL: URL(string: "http://127.0.0.1:7717")!,
            credentials: MemoryCredentialStore(token: token),
            session: context.session,
            defaults: context.defaults
        )

        await client.refresh()

        XCTAssertTrue(client.connected)
        XCTAssertEqual(client.version, "test")
        XCTAssertEqual(client.projects.map(\.id), ["prj_1"])
        XCTAssertEqual(client.terminals.first?.command, "pnpm test")
        XCTAssertEqual(protectedRequests, 5)
        XCTAssertNil(client.lastError)
    }

    @MainActor
    func testStructuredServerErrorIsNotMisreportedAsAuthentication() async {
        let context = URLProtocolTestContext()
        defer { context.cleanUp() }
        context.install { request in
            if request.url!.path == "/v1/health" {
                return .init(body: #"{"status":"ok","version":"test"}"#)
            }
            return .init(
                status: 409,
                body: #"{"error":{"code":"project_paused","message":"Project is paused"}}"#
            )
        }
        let client = ApiClient(
            baseURL: URL(string: "http://127.0.0.1:7717")!,
            credentials: MemoryCredentialStore(token: "native-client-token"),
            session: context.session,
            defaults: context.defaults
        )

        await client.refresh()

        XCTAssertFalse(client.connected)
        XCTAssertEqual(
            client.lastError,
            "Project is paused (project_paused, HTTP 409)"
        )
    }

    @MainActor
    func testApprovalResolutionUsesCanonicalBodyAndRefreshes() async throws {
        let context = URLProtocolTestContext()
        defer { context.cleanUp() }
        var resolutionBody: [String: String]?
        context.install { request in
            let path = request.url!.path
            if path == "/v1/approvals/apr_1/resolve" {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "content-type"),
                    "application/json"
                )
                resolutionBody = try JSONSerialization.jsonObject(
                    with: requestBody(request)
                ) as? [String: String]
                return .init(
                    body: #"{"id":"apr_1","projectId":"prj_1","title":"Decision","description":"Review","status":"resolved"}"#
                )
            }
            switch path {
            case "/v1/health":
                return .init(body: #"{"status":"ok","version":"test"}"#)
            case "/v1/projects", "/v1/approvals", "/v1/runs", "/v1/terminals":
                return .init(body: #"{"items":[]}"#)
            default:
                XCTFail("Unexpected request: \(path)")
                return .init(status: 404, body: #"{"error":{"code":"not_found","message":"missing"}}"#)
            }
        }
        let client = ApiClient(
            baseURL: URL(string: "http://127.0.0.1:7717")!,
            credentials: MemoryCredentialStore(token: "native-client-token"),
            session: context.session,
            defaults: context.defaults
        )

        await client.resolveApproval(id: "apr_1", decision: "approved")

        XCTAssertEqual(resolutionBody?["decision"], "approved")
        XCTAssertEqual(resolutionBody?["note"], "resolved from macOS app")
        XCTAssertTrue(client.connected)
        XCTAssertNil(client.lastError)
    }

    @MainActor
    func testConfigureRejectsInsecureRemoteURLBeforeSavingToken() {
        let context = URLProtocolTestContext()
        defer { context.cleanUp() }
        let credentials = MemoryCredentialStore()
        let client = ApiClient(
            credentials: credentials,
            session: context.session,
            defaults: context.defaults
        )

        client.configure(
            baseURL: URL(string: "http://control.example")!,
            token: "must-not-be-saved"
        )

        XCTAssertFalse(client.tokenConfigured)
        XCTAssertTrue(credentials.savedTokens.isEmpty)
        XCTAssertEqual(
            client.lastError,
            ApiClientError.insecureRemoteEndpoint.localizedDescription
        )
    }
}
