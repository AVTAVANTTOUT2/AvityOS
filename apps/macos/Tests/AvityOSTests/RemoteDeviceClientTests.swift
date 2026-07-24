@preconcurrency import Foundation
import XCTest
@testable import AvityOS

private final class RemoteRelayURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let body: Data

        init(status: Int = 200, body: Data) {
            self.status = status
            self.body = body
        }

        init(status: Int = 200, body: String) {
            self.init(status: status, body: Data(body.utf8))
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
            let stub = try RemoteRelayURLProtocolRegistry.shared.response(
                for: request
            )
            guard let url = request.url, let response = HTTPURLResponse(
                url: url,
                statusCode: stub.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            ) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(
                self,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            client?.urlProtocol(self, didLoad: stub.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private final class RemoteRelayURLProtocolRegistry: @unchecked Sendable {
    typealias Handler = (URLRequest) throws -> RemoteRelayURLProtocol.Stub

    static let shared = RemoteRelayURLProtocolRegistry()

    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]

    func install(id: String, handler: @escaping Handler) {
        lock.lock()
        defer { lock.unlock() }
        handlers[id] = handler
    }

    func remove(id: String) {
        lock.lock()
        defer { lock.unlock() }
        handlers.removeValue(forKey: id)
    }

    func response(for request: URLRequest) throws -> RemoteRelayURLProtocol.Stub {
        guard
            let id = request.value(
                forHTTPHeaderField: "x-avity-remote-test-session"
            )
        else {
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

private final class RemoteRelayTestContext {
    let id = UUID().uuidString
    let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RemoteRelayURLProtocol.self]
        configuration.httpAdditionalHeaders = [
            "x-avity-remote-test-session": id,
        ]
        session = URLSession(configuration: configuration)
    }

    func install(
        _ handler: @escaping RemoteRelayURLProtocolRegistry.Handler
    ) {
        RemoteRelayURLProtocolRegistry.shared.install(
            id: id,
            handler: handler
        )
    }

    func cleanUp() {
        RemoteRelayURLProtocolRegistry.shared.remove(id: id)
        session.invalidateAndCancel()
    }
}

private final class EncryptedRelayHarness: @unchecked Sendable {
    private let lock = NSLock()
    private let vector: RemoteBridgeTestVector
    private let now: Date
    private let relayToken: String
    private var remoteSequence: Int
    private var hostSequence: Int
    private var cursor: Int
    private var acknowledgedCursor: Int
    private var queuedEnvelope: RemoteEncryptedEnvelopeWire?
    private var paths: [String] = []
    private var operations: [String] = []

    init(
        vector: RemoteBridgeTestVector,
        initialSequence: Int = 0,
        initialCursor: Int = 0,
        acknowledgedCursor: Int = 0
    ) throws {
        self.vector = vector
        now = try vector.date
        relayToken = try vector.configuration().relayAccessToken
        remoteSequence = initialSequence
        hostSequence = initialSequence
        cursor = initialCursor
        self.acknowledgedCursor = acknowledgedCursor
    }

    func handle(_ request: URLRequest) throws -> RemoteRelayURLProtocol.Stub {
        lock.lock()
        defer { lock.unlock() }

        guard
            request.value(forHTTPHeaderField: "authorization") ==
                "Bearer \(relayToken)",
            request.value(forHTTPHeaderField: "cache-control") == "no-store",
            let url = request.url,
            !url.absoluteString.contains(relayToken)
        else {
            throw URLError(.userAuthenticationRequired)
        }

        switch (request.httpMethod, url.path) {
        case ("POST", "/bridge/v1/relay/envelopes"):
            return try publish(request)
        case (
            "GET",
            "/bridge/v1/relay/accounts/\(vector.remoteCertificate.accountId)" +
                "/devices/\(vector.remoteCertificate.deviceId)/inbox"
        ):
            return try poll(request)
        case (
            "POST",
            "/bridge/v1/relay/accounts/\(vector.remoteCertificate.accountId)" +
                "/devices/\(vector.remoteCertificate.deviceId)/ack"
        ):
            return try acknowledge(request)
        default:
            throw URLError(.unsupportedURL)
        }
    }

    func recordedPaths() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }

    func recordedOperations() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return operations
    }

    private func publish(
        _ urlRequest: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        let envelope = try RemoteBridgeCrypto.decodeEnvelope(
            try remoteRequestBody(urlRequest)
        )
        let opened = try RemoteBridgeCrypto.openEnvelope(
            envelope,
            recipientIdentity: vector.hostIdentity,
            recipientCertificate: vector.hostCertificate,
            senderCertificate: vector.remoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            lastAcceptedSequence: remoteSequence,
            now: now
        )
        guard opened.contentType == remoteControlRequestContentType else {
            throw URLError(.cannotDecodeContentData)
        }
        remoteSequence = opened.sequence
        let request = try JSONDecoder().decode(
            RemoteControlRequestWire.self,
            from: opened.plaintext
        )
        paths.append(request.path)
        operations.append("publish:\(opened.sequence)")

        hostSequence += 1
        cursor += 1
        let response = RemoteControlResponseWire(
            protocolVersion: remoteBridgeProtocolVersion,
            requestId: request.requestId,
            status: responseStatus(for: request.path),
            body: responseBody(for: request.path)
        )
        queuedEnvelope = try RemoteBridgeCrypto.sealEnvelope(
            plaintext: JSONEncoder().encode(response),
            contentType: remoteControlResponseContentType,
            sequence: hostSequence,
            senderIdentity: vector.hostIdentity,
            senderCertificate: vector.hostCertificate,
            recipientCertificate: vector.remoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            now: now
        )
        let result = RemoteRelayPublishResultWire(
            messageId: envelope.messageId,
            acceptedAt: vector.now,
            duplicate: false
        )
        return .init(body: try JSONEncoder().encode(result))
    }

    private func poll(
        _ request: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        guard
            let components = URLComponents(
                url: try XCTUnwrap(request.url),
                resolvingAgainstBaseURL: false
            ),
            let afterString = components.queryItems?.first(
                where: { $0.name == "after" }
            )?.value,
            let after = Int(afterString),
            components.queryItems?.first(
                where: { $0.name == "limit" }
            )?.value == "25",
            components.queryItems?.first(
                where: { $0.name == "waitMs" }
            )?.value == "25000"
        else {
            throw URLError(.badURL)
        }
        let items: [RemoteRelayItemWire]
        if let queuedEnvelope, cursor > after {
            items = [
                RemoteRelayItemWire(
                    cursor: cursor,
                    receivedAt: vector.now,
                    envelope: queuedEnvelope
                ),
            ]
        } else {
            items = []
        }
        return .init(
            body: try JSONEncoder().encode(
                RemoteRelayInboxWire(
                    items: items,
                    nextCursor: items.isEmpty ? after : cursor
                )
            )
        )
    }

    private func acknowledge(
        _ request: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        struct Ack: Decodable {
            let throughCursor: Int
        }
        let ack = try JSONDecoder().decode(
            Ack.self,
            from: try remoteRequestBody(request)
        )
        guard
            ack.throughCursor >= acknowledgedCursor,
            ack.throughCursor <= cursor
        else {
            throw URLError(.cannotParseResponse)
        }
        acknowledgedCursor = ack.throughCursor
        operations.append("ack:\(ack.throughCursor)")
        let deleted: Int
        if queuedEnvelope != nil && ack.throughCursor == cursor {
            queuedEnvelope = nil
            deleted = 1
        } else {
            deleted = 0
        }
        return .init(
            body: try JSONEncoder().encode(
                RemoteRelayAckResultWire(
                    throughCursor: ack.throughCursor,
                    deleted: deleted
                )
            )
        )
    }

    private func responseStatus(for path: String) -> Int {
        switch path {
        case "/v1/health",
             "/v1/projects",
             "/v1/approvals?status=open",
             "/v1/runs",
             "/v1/terminals":
            200
        default:
            404
        }
    }

    private func responseBody(for path: String) -> JSONValue {
        switch path {
        case "/v1/health":
            .object([
                "status": .string("ok"),
                "version": .string("remote-test"),
            ])
        case "/v1/projects",
             "/v1/approvals?status=open",
             "/v1/runs",
             "/v1/terminals":
            .object(["items": .array([])])
        default:
            .object([
                "error": .object([
                    "code": .string("not_found"),
                    "message": .string("Missing remote route"),
                ]),
            ])
        }
    }
}

private final class CertificateRenewalRelayHarness: @unchecked Sendable {
    private let lock = NSLock()
    private let vector: RemoteCertificateRenewalTestVector
    private let now: Date
    private let relayToken: String
    private let invalidRenewalIdentity: Bool
    private var remoteSequence = 0
    private var hostSequence = 0
    private var cursor = 0
    private var relayCursor = 0
    private var queuedEnvelope: RemoteEncryptedEnvelopeWire?
    private var paths: [String] = []

    init(
        vector: RemoteCertificateRenewalTestVector,
        invalidRenewalIdentity: Bool = false
    ) throws {
        self.vector = vector
        now = try vector.date
        relayToken = vector.configuration().relayAccessToken
        self.invalidRenewalIdentity = invalidRenewalIdentity
    }

    func recordedPaths() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }

    func handle(_ request: URLRequest) throws -> RemoteRelayURLProtocol.Stub {
        lock.lock()
        defer { lock.unlock() }
        guard
            request.value(forHTTPHeaderField: "authorization") ==
                "Bearer \(relayToken)",
            let url = request.url
        else {
            throw URLError(.userAuthenticationRequired)
        }
        switch (request.httpMethod, url.path) {
        case ("POST", "/bridge/v1/relay/envelopes"):
            return try publish(request)
        case (
            "GET",
            "/bridge/v1/relay/accounts/\(vector.remoteCertificate.accountId)" +
                "/devices/\(vector.remoteCertificate.deviceId)/inbox"
        ):
            return try poll(request)
        case (
            "POST",
            "/bridge/v1/relay/accounts/\(vector.remoteCertificate.accountId)" +
                "/devices/\(vector.remoteCertificate.deviceId)/ack"
        ):
            return try acknowledge(request)
        default:
            throw URLError(.unsupportedURL)
        }
    }

    private func publish(
        _ request: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        let envelope = try RemoteBridgeCrypto.decodeEnvelope(
            try remoteRequestBody(request)
        )
        let renewing = remoteSequence == 0
        let opened = try RemoteBridgeCrypto.openEnvelope(
            envelope,
            recipientIdentity: vector.hostIdentity,
            recipientCertificate:
                renewing
                    ? vector.hostCertificate
                    : vector.renewedHostCertificate,
            senderCertificate:
                renewing
                    ? vector.remoteCertificate
                    : vector.renewedRemoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            lastAcceptedSequence: remoteSequence,
            now: now
        )
        remoteSequence = opened.sequence
        let control = try JSONDecoder().decode(
            RemoteControlRequestWire.self,
            from: opened.plaintext
        )
        paths.append(control.path)
        let responseBody: JSONValue
        if control.path == remoteCertificateRenewalPath {
            responseBody = try JSONValue(
                data: JSONEncoder().encode(
                    RemoteCertificateRenewalResponseWire(
                        protocolVersion: remoteBridgeProtocolVersion,
                        deviceCertificate:
                            vector.renewedRemoteCertificate,
                        hostCertificate:
                            invalidRenewalIdentity
                                ? vector.renewedRemoteCertificate
                                : vector.renewedHostCertificate
                    )
                )
            )
        } else if control.path == "/v1/health" {
            responseBody = .object([
                "status": .string("ok"),
                "version": .string("renewed"),
            ])
        } else {
            throw URLError(.unsupportedURL)
        }
        hostSequence += 1
        cursor += 1
        let response = RemoteControlResponseWire(
            protocolVersion: remoteBridgeProtocolVersion,
            requestId: control.requestId,
            status: 200,
            body: responseBody
        )
        queuedEnvelope = try RemoteBridgeCrypto.sealEnvelope(
            plaintext: JSONEncoder().encode(response),
            contentType: remoteControlResponseContentType,
            sequence: hostSequence,
            senderIdentity: vector.hostIdentity,
            senderCertificate:
                renewing
                    ? vector.hostCertificate
                    : vector.renewedHostCertificate,
            recipientCertificate:
                renewing
                    ? vector.remoteCertificate
                    : vector.renewedRemoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            now: now
        )
        return .init(
            body: try JSONEncoder().encode(
                RemoteRelayPublishResultWire(
                    messageId: envelope.messageId,
                    acceptedAt: vector.renewalNow,
                    duplicate: false
                )
            )
        )
    }

    private func poll(
        _ request: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        guard
            let url = request.url,
            let components = URLComponents(
                url: url,
                resolvingAgainstBaseURL: false
            ),
            let afterValue = components.queryItems?.first(
                where: { $0.name == "after" }
            )?.value,
            let after = Int(afterValue)
        else {
            throw URLError(.badURL)
        }
        let items: [RemoteRelayItemWire]
        if let queuedEnvelope, cursor > after {
            items = [
                RemoteRelayItemWire(
                    cursor: cursor,
                    receivedAt: vector.renewalNow,
                    envelope: queuedEnvelope
                ),
            ]
        } else {
            items = []
        }
        return .init(
            body: try JSONEncoder().encode(
                RemoteRelayInboxWire(
                    items: items,
                    nextCursor: items.isEmpty ? after : cursor
                )
            )
        )
    }

    private func acknowledge(
        _ request: URLRequest
    ) throws -> RemoteRelayURLProtocol.Stub {
        struct Ack: Decodable {
            let throughCursor: Int
        }
        let ack = try JSONDecoder().decode(
            Ack.self,
            from: try remoteRequestBody(request)
        )
        guard ack.throughCursor == cursor else {
            throw URLError(.cannotParseResponse)
        }
        relayCursor = ack.throughCursor
        queuedEnvelope = nil
        return .init(
            body: try JSONEncoder().encode(
                RemoteRelayAckResultWire(
                    throughCursor: relayCursor,
                    deleted: 1
                )
            )
        )
    }
}

private final class EmptyCredentialStore: CredentialStore {
    func loadToken() throws -> String? { nil }
    func saveToken(_ token: String) throws {}
    func deleteToken() throws {}
}

private struct FailingRemoteDeviceStore: RemoteDeviceConfigurationStore {
    private struct StoreError: LocalizedError {
        var errorDescription: String? {
            "Remote Keychain unavailable."
        }
    }

    func loadConfiguration() throws -> RemoteDeviceConfiguration? {
        throw StoreError()
    }

    func saveConfiguration(_ configuration: RemoteDeviceConfiguration) throws {
        throw StoreError()
    }

    func deleteConfiguration() throws {
        throw StoreError()
    }

    func loadPendingPairing() throws -> PendingRemotePairing? {
        throw StoreError()
    }

    func savePendingPairing(_ pairing: PendingRemotePairing) throws {
        throw StoreError()
    }

    func deletePendingPairing() throws {
        throw StoreError()
    }
}

private func remoteRequestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        return Data()
    }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 {
            throw stream.streamError ?? URLError(.cannotDecodeContentData)
        }
        if count == 0 { break }
        body.append(buffer, count: count)
    }
    return body
}

final class RemoteDeviceClientTests: XCTestCase {
    func testInvalidControlPathFailsBeforeRelayPublication() async throws {
        let vector = try RemoteBridgeTestVector.load()
        let store = MemoryRemoteDeviceStore(
            configuration: try vector.configuration()
        )
        let relay = try EncryptedRelayHarness(vector: vector)
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let transport = RemoteDeviceTransport(
            store: store,
            session: context.session,
            now: { try! vector.date }
        )

        do {
            _ = try await transport.send(
                path: "/v1/projects\n/escape",
                method: "GET",
                body: nil
            )
            XCTFail("Expected the invalid path to fail closed")
        } catch {
            XCTAssertEqual(
                error as? RemoteDeviceClientError,
                .invalidResponse
            )
        }
        XCTAssertTrue(relay.recordedOperations().isEmpty)
        XCTAssertEqual(
            try store.loadConfiguration()?.outboundSequence,
            0
        )
    }

    func testEncryptedTransportPersistsSequencesCursorAndAck() async throws {
        let vector = try RemoteBridgeTestVector.load()
        let store = MemoryRemoteDeviceStore(
            configuration: try vector.configuration()
        )
        let relay = try EncryptedRelayHarness(vector: vector)
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let transport = RemoteDeviceTransport(
            store: store,
            session: context.session,
            now: { try! vector.date }
        )

        let response = try await transport.send(
            path: "/v1/health",
            method: "GET",
            body: nil
        )

        XCTAssertEqual(
            try JSONValue(data: response),
            .object([
                "status": .string("ok"),
                "version": .string("remote-test"),
            ])
        )
        let persisted = try XCTUnwrap(store.loadConfiguration())
        XCTAssertEqual(persisted.outboundSequence, 1)
        XCTAssertEqual(persisted.inboundSequence, 1)
        XCTAssertEqual(persisted.relayCursor, 1)
        XCTAssertNil(persisted.pendingAckCursor)
        XCTAssertEqual(relay.recordedOperations(), ["publish:1", "ack:1"])
    }

    func testPendingAckIsRecoveredBeforePublishingNextRequest() async throws {
        let vector = try RemoteBridgeTestVector.load()
        var configuration = try vector.configuration()
        configuration.outboundSequence = 1
        configuration.inboundSequence = 1
        configuration.pendingAckCursor = 1
        let store = MemoryRemoteDeviceStore(configuration: configuration)
        let relay = try EncryptedRelayHarness(
            vector: vector,
            initialSequence: 1,
            initialCursor: 1,
            acknowledgedCursor: 1
        )
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let transport = RemoteDeviceTransport(
            store: store,
            session: context.session,
            now: { try! vector.date }
        )

        _ = try await transport.send(
            path: "/v1/health",
            method: "GET",
            body: nil
        )

        XCTAssertEqual(
            relay.recordedOperations(),
            ["ack:1", "publish:2", "ack:2"]
        )
        let persisted = try XCTUnwrap(store.loadConfiguration())
        XCTAssertEqual(persisted.outboundSequence, 2)
        XCTAssertEqual(persisted.inboundSequence, 2)
        XCTAssertEqual(persisted.relayCursor, 2)
        XCTAssertNil(persisted.pendingAckCursor)
    }

    func testNearExpiryCertificatesRenewBeforeNormalRequest() async throws {
        let vector = try RemoteCertificateRenewalTestVector.load()
        let store = MemoryRemoteDeviceStore(
            configuration: vector.configuration()
        )
        let relay = try CertificateRenewalRelayHarness(vector: vector)
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let transport = RemoteDeviceTransport(
            store: store,
            session: context.session,
            now: { try! vector.date }
        )

        let response = try await transport.send(
            path: "/v1/health",
            method: "GET",
            body: nil
        )

        XCTAssertEqual(
            try JSONValue(data: response),
            .object([
                "status": .string("ok"),
                "version": .string("renewed"),
            ])
        )
        XCTAssertEqual(
            relay.recordedPaths(),
            [remoteCertificateRenewalPath, "/v1/health"]
        )
        let persisted = try XCTUnwrap(store.loadConfiguration())
        XCTAssertEqual(
            persisted.certificate,
            vector.renewedRemoteCertificate
        )
        XCTAssertEqual(
            persisted.hostCertificate,
            vector.renewedHostCertificate
        )
        XCTAssertEqual(persisted.relayAccessToken, "renewal-device-token-xxxxxxxxxxx")
        XCTAssertEqual(persisted.outboundSequence, 2)
        XCTAssertEqual(persisted.inboundSequence, 2)
        XCTAssertEqual(persisted.relayCursor, 2)
    }

    func testRenewalRejectsAValidCertificateForAnotherIdentity() async throws {
        let vector = try RemoteCertificateRenewalTestVector.load()
        let original = vector.configuration()
        let store = MemoryRemoteDeviceStore(configuration: original)
        let relay = try CertificateRenewalRelayHarness(
            vector: vector,
            invalidRenewalIdentity: true
        )
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let transport = RemoteDeviceTransport(
            store: store,
            session: context.session,
            now: { try! vector.date }
        )

        do {
            try await transport.renewCertificates()
            XCTFail("Expected the identity substitution to fail closed")
        } catch {
            XCTAssertEqual(
                error as? RemoteDeviceClientError,
                .invalidResponse
            )
        }
        let persisted = try XCTUnwrap(store.loadConfiguration())
        XCTAssertEqual(persisted.certificate, original.certificate)
        XCTAssertEqual(
            persisted.hostCertificate,
            original.hostCertificate
        )
        XCTAssertEqual(persisted.outboundSequence, 1)
        XCTAssertEqual(persisted.inboundSequence, 1)
        XCTAssertEqual(persisted.relayCursor, 1)
    }

    @MainActor
    func testApiClientRefreshesExistingScreensThroughEncryptedRelay() async throws {
        let vector = try RemoteBridgeTestVector.load()
        let store = MemoryRemoteDeviceStore(
            configuration: try vector.configuration()
        )
        let relay = try EncryptedRelayHarness(vector: vector)
        let context = RemoteRelayTestContext()
        defer { context.cleanUp() }
        context.install(relay.handle)
        let suite = "RemoteDeviceClientTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("remote", forKey: "connectionMode")
        let client = ApiClient(
            credentials: EmptyCredentialStore(),
            session: context.session,
            defaults: defaults,
            remoteStore: store,
            remoteNow: { try! vector.date }
        )

        await client.refresh()

        XCTAssertEqual(client.connectionMode, .remote)
        XCTAssertTrue(client.connected)
        XCTAssertEqual(client.version, "remote-test")
        XCTAssertTrue(client.projects.isEmpty)
        XCTAssertTrue(client.approvals.isEmpty)
        XCTAssertTrue(client.runs.isEmpty)
        XCTAssertTrue(client.terminals.isEmpty)
        XCTAssertNil(client.lastError)
        XCTAssertEqual(
            relay.recordedPaths(),
            [
                "/v1/health",
                "/v1/projects",
                "/v1/approvals?status=open",
                "/v1/runs",
                "/v1/terminals",
            ]
        )
    }

    @MainActor
    func testKeychainReadFailureForcesLocalModeAndSurfacesError() throws {
        let suite = "RemoteDeviceKeychainFailure-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("remote", forKey: "connectionMode")

        let client = ApiClient(
            credentials: EmptyCredentialStore(),
            defaults: defaults,
            remoteStore: FailingRemoteDeviceStore()
        )

        XCTAssertEqual(client.connectionMode, .local)
        XCTAssertFalse(client.remoteDeviceStatus.configured)
        XCTAssertEqual(
            client.remoteDeviceError,
            "Remote Keychain unavailable."
        )
    }

    @MainActor
    func testCorruptRemoteConfigurationCannotActivateRemoteMode() throws {
        let vector = try RemoteBridgeTestVector.load()
        var configuration = try vector.configuration()
        configuration.outboundSequence = Int.max
        let store = MemoryRemoteDeviceStore(configuration: configuration)
        let suite = "RemoteDeviceCorruptConfiguration-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("remote", forKey: "connectionMode")

        let client = ApiClient(
            credentials: EmptyCredentialStore(),
            defaults: defaults,
            remoteStore: store,
            remoteNow: { try! vector.date }
        )

        XCTAssertEqual(client.connectionMode, .local)
        XCTAssertFalse(client.remoteDeviceStatus.configured)
        XCTAssertEqual(
            client.remoteDeviceError,
            RemoteBridgeCryptoError.invalid(
                "device configuration"
            ).localizedDescription
        )
    }
}
