@preconcurrency import Foundation
import Security

enum RemoteDeviceClientError: LocalizedError, Equatable {
    case notConfigured
    case invalidResponse
    case relay(status: Int, message: String)
    case timeout

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Remote device mode is not configured."
        case .invalidResponse: "The remote relay returned an invalid response."
        case .relay(let status, let message):
            "\(message) (relay HTTP \(status))"
        case .timeout: "Timed out waiting for the encrypted host response."
        }
    }
}

private struct RemoteRelayHTTPClient {
    private let baseURL: URL
    private let accessToken: String
    private let accountId: String
    private let deviceId: String
    private let session: URLSession

    init(configuration: RemoteDeviceConfiguration, session: URLSession) throws {
        baseURL = try RemoteBridgeCrypto.validatedRelayURL(configuration.relayURL)
        accessToken = configuration.relayAccessToken
        accountId = configuration.certificate.accountId
        deviceId = configuration.certificate.deviceId
        self.session = session
    }

    func publish(
        _ envelope: RemoteEncryptedEnvelopeWire
    ) async throws -> RemoteRelayPublishResultWire {
        let data = try await request(
            path: "/v1/relay/envelopes",
            method: "POST",
            body: try JSONEncoder().encode(envelope),
            headers: [
                "x-avity-account-id": envelope.accountId,
                "x-avity-device-id": envelope.senderDeviceId,
            ]
        )
        try requireObjectKeys(
            data,
            keys: ["messageId", "acceptedAt", "duplicate"]
        )
        return try JSONDecoder().decode(
            RemoteRelayPublishResultWire.self,
            from: data
        )
    }

    func poll(
        after cursor: Int,
        waitMilliseconds: Int
    ) async throws -> RemoteRelayInboxWire {
        var components = URLComponents()
        components.queryItems = [
            .init(name: "after", value: String(cursor)),
            .init(name: "limit", value: "25"),
            .init(name: "waitMs", value: String(waitMilliseconds)),
        ]
        guard let query = components.percentEncodedQuery else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let data = try await request(
            path:
                "/v1/relay/accounts/\(accountId)/devices/\(deviceId)/inbox?\(query)",
            method: "GET",
            body: nil
        )
        guard
            let root = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
            Set(root.keys) == ["items", "nextCursor"],
            let items = root["items"] as? [[String: Any]],
            items.count <= 25,
            let nextCursor = root["nextCursor"] as? Int,
            (0...9_007_199_254_740_991).contains(nextCursor)
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let decodedItems = try items.map { item -> RemoteRelayItemWire in
            guard
                Set(item.keys) == ["cursor", "receivedAt", "envelope"],
                let itemCursor = item["cursor"] as? Int,
                (1...9_007_199_254_740_991).contains(itemCursor),
                let receivedAt = item["receivedAt"] as? String,
                let envelopeObject = item["envelope"]
            else {
                throw RemoteDeviceClientError.invalidResponse
            }
            let envelopeData = try JSONSerialization.data(
                withJSONObject: envelopeObject,
                options: [.withoutEscapingSlashes]
            )
            return RemoteRelayItemWire(
                cursor: itemCursor,
                receivedAt: receivedAt,
                envelope: try RemoteBridgeCrypto.decodeEnvelope(envelopeData)
            )
        }
        return RemoteRelayInboxWire(items: decodedItems, nextCursor: nextCursor)
    }

    func acknowledge(
        through cursor: Int
    ) async throws -> RemoteRelayAckResultWire {
        struct Body: Encodable {
            let throughCursor: Int
        }
        let data = try await request(
            path:
                "/v1/relay/accounts/\(accountId)/devices/\(deviceId)/ack",
            method: "POST",
            body: try JSONEncoder().encode(Body(throughCursor: cursor))
        )
        try requireObjectKeys(data, keys: ["throughCursor", "deleted"])
        let result = try JSONDecoder().decode(
            RemoteRelayAckResultWire.self,
            from: data
        )
        guard
            (1...9_007_199_254_740_991).contains(result.throughCursor),
            (0...9_007_199_254_740_991).contains(result.deleted)
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        return result
    }

    private func request(
        path: String,
        method: String,
        body: Data?,
        headers: [String: String] = [:]
    ) async throws -> Data {
        let basePath = baseURL.path == "/" ? "" : baseURL.path
        var originComponents = URLComponents()
        originComponents.scheme = baseURL.scheme
        originComponents.host = baseURL.host
        originComponents.port = baseURL.port
        originComponents.path = "/"
        guard
            let origin = originComponents.url,
            let url = URL(
                string: "\(basePath)\(path)",
                relativeTo: origin
            )?.absoluteURL
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        request.setValue(
            "Bearer \(accessToken)",
            forHTTPHeaderField: "authorization"
        )
        if let body {
            request.httpBody = body
            request.setValue(
                "application/json",
                forHTTPHeaderField: "content-type"
            )
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RemoteDeviceClientError.invalidResponse
        }
        guard data.count <= 5 * 1024 * 1024 else {
            throw RemoteDeviceClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            throw RemoteDeviceClientError.relay(
                status: http.statusCode,
                message: apiError?.error.message ?? "Remote relay request failed"
            )
        }
        return data
    }

    private func requireObjectKeys(
        _ data: Data,
        keys: Set<String>
    ) throws {
        guard
            let value = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
            Set(value.keys) == keys
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
    }
}

actor RemoteDeviceTransport {
    private struct RequestResult {
        let data: Data
        let configuration: RemoteDeviceConfiguration
    }

    private static let certificateRenewalWindow: TimeInterval =
        30 * 24 * 60 * 60

    private let store: any RemoteDeviceConfigurationStore
    private let session: URLSession
    private let now: @Sendable () -> Date

    init(
        store: any RemoteDeviceConfigurationStore,
        session: URLSession,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.session = session
        self.now = now
    }

    func send(
        path: String,
        method: String,
        body: Data?
    ) async throws -> Data {
        guard var configuration = try store.loadConfiguration() else {
            throw RemoteDeviceClientError.notConfigured
        }
        let currentDate = now()
        try validateConfiguration(configuration, now: currentDate)
        if
            path != remoteCertificateRenewalPath,
            try certificatesNeedRenewal(
                configuration,
                now: currentDate
            )
        {
            configuration = try await renewCertificates(
                configuration
            )
        }
        let result = try await performRequest(
            path: path,
            method: method,
            body: body,
            configuration: configuration
        )
        return result.data
    }

    func renewCertificates() async throws {
        guard let configuration = try store.loadConfiguration() else {
            throw RemoteDeviceClientError.notConfigured
        }
        try validateConfiguration(configuration, now: now())
        _ = try await renewCertificates(configuration)
    }

    private func renewCertificates(
        _ configuration: RemoteDeviceConfiguration
    ) async throws -> RemoteDeviceConfiguration {
        let request = RemoteCertificateRenewalRequestWire(
            protocolVersion: remoteBridgeProtocolVersion
        )
        let result = try await performRequest(
            path: remoteCertificateRenewalPath,
            method: "POST",
            body: try JSONEncoder().encode(request),
            configuration: configuration
        )
        let updated = try applyCertificateRenewal(
            result.data,
            to: result.configuration,
            now: now()
        )
        try store.saveConfiguration(updated)
        return updated
    }

    private func performRequest(
        path: String,
        method: String,
        body: Data?,
        configuration initialConfiguration: RemoteDeviceConfiguration
    ) async throws -> RequestResult {
        var configuration = initialConfiguration
        let relay = try RemoteRelayHTTPClient(
            configuration: configuration,
            session: session
        )
        if let pendingCursor = configuration.pendingAckCursor {
            let acknowledged = try await relay.acknowledge(through: pendingCursor)
            guard acknowledged.throughCursor == pendingCursor else {
                throw RemoteDeviceClientError.invalidResponse
            }
            configuration.relayCursor = pendingCursor
            configuration.pendingAckCursor = nil
            try store.saveConfiguration(configuration)
        }

        guard
            ["GET", "POST"].contains(method),
            path.count <= 2_048,
            path.range(
                of: #"^/v1/[^\s]*$"#,
                options: .regularExpression
            ) != nil,
            body.map({ $0.count <= 1024 * 1024 }) ?? true
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let requestId = "rreq_\(try randomHex(bytes: 16))"
        let request = RemoteControlRequestWire(
            protocolVersion: remoteBridgeProtocolVersion,
            requestId: requestId,
            method: method,
            path: path,
            body: try body.map(JSONValue.init(data:))
        )
        configuration.outboundSequence += 1
        guard configuration.outboundSequence <= 9_007_199_254_740_991 else {
            throw RemoteDeviceClientError.invalidResponse
        }
        // Persist before publication. A crash can create a harmless sequence
        // gap, but can never reuse a sequence accepted by the host.
        try store.saveConfiguration(configuration)
        let requestData = try JSONEncoder().encode(request)
        let envelope = try RemoteBridgeCrypto.sealEnvelope(
            plaintext: requestData,
            contentType: remoteControlRequestContentType,
            sequence: configuration.outboundSequence,
            senderIdentity: configuration.identity,
            senderCertificate: configuration.certificate,
            recipientCertificate: configuration.hostCertificate,
            accountSigningPublicKey: configuration.accountSigningPublicKey,
            now: now()
        )
        let published = try await relay.publish(envelope)
        guard published.messageId == envelope.messageId else {
            throw RemoteDeviceClientError.invalidResponse
        }

        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(90))
        while clock.now < deadline {
            try Task.checkCancellation()
            let inbox = try await relay.poll(
                after: configuration.relayCursor,
                waitMilliseconds: 25_000
            )
            var expectedCursor = configuration.relayCursor
            for item in inbox.items {
                expectedCursor += 1
                guard item.cursor == expectedCursor else {
                    throw RemoteDeviceClientError.invalidResponse
                }
            }
            guard inbox.nextCursor == expectedCursor else {
                throw RemoteDeviceClientError.invalidResponse
            }
            for item in inbox.items {
                let opened = try RemoteBridgeCrypto.openEnvelope(
                    item.envelope,
                    recipientIdentity: configuration.identity,
                    recipientCertificate: configuration.certificate,
                    senderCertificate: configuration.hostCertificate,
                    accountSigningPublicKey:
                        configuration.accountSigningPublicKey,
                    lastAcceptedSequence: configuration.inboundSequence,
                    now: now()
                )
                guard opened.contentType == remoteControlResponseContentType else {
                    throw RemoteDeviceClientError.invalidResponse
                }
                let response = try decodeControlResponse(opened.plaintext)
                configuration.inboundSequence = opened.sequence
                configuration.pendingAckCursor = item.cursor
                try store.saveConfiguration(configuration)

                let acknowledged = try await relay.acknowledge(
                    through: item.cursor
                )
                guard acknowledged.throughCursor == item.cursor else {
                    throw RemoteDeviceClientError.invalidResponse
                }
                configuration.relayCursor = item.cursor
                configuration.pendingAckCursor = nil
                try store.saveConfiguration(configuration)

                guard response.requestId == requestId else {
                    // A response from a request published before an app crash.
                    // It is authenticated, consumed and intentionally ignored.
                    continue
                }
                let responseData = try response.body.encoded()
                guard (200..<300).contains(response.status) else {
                    throw apiError(status: response.status, body: response.body)
                }
                return RequestResult(
                    data: responseData,
                    configuration: configuration
                )
            }
        }
        throw RemoteDeviceClientError.timeout
    }

    private func certificatesNeedRenewal(
        _ configuration: RemoteDeviceConfiguration,
        now: Date
    ) throws -> Bool {
        try certificateNeedsRenewal(
            configuration.certificate,
            now: now
        ) || certificateNeedsRenewal(
            configuration.hostCertificate,
            now: now
        )
    }

    private func certificateNeedsRenewal(
        _ certificate: RemoteDeviceCertificateWire,
        now: Date
    ) throws -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        guard let expiration = formatter.date(from: certificate.validUntil) else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let renewalDeadline = now.addingTimeInterval(
            Self.certificateRenewalWindow
        )
        return expiration <= renewalDeadline
    }

    private func applyCertificateRenewal(
        _ data: Data,
        to configuration: RemoteDeviceConfiguration,
        now: Date
    ) throws -> RemoteDeviceConfiguration {
        guard
            let value = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
            Set(value.keys) == [
                "protocolVersion",
                "deviceCertificate",
                "hostCertificate",
            ]
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let response = try JSONDecoder().decode(
            RemoteCertificateRenewalResponseWire.self,
            from: data
        )
        guard
            response.protocolVersion == remoteBridgeProtocolVersion,
            sameCertificateIdentity(
                response.deviceCertificate,
                configuration.certificate
            ),
            sameCertificateIdentity(
                response.hostCertificate,
                configuration.hostCertificate
            ),
            try certificateDoesNotRegress(
                response.deviceCertificate,
                configuration.certificate
            ),
            try certificateDoesNotRegress(
                response.hostCertificate,
                configuration.hostCertificate
            ),
            try renewalWasSatisfied(
                response.deviceCertificate,
                previous: configuration.certificate,
                now: now
            ),
            try renewalWasSatisfied(
                response.hostCertificate,
                previous: configuration.hostCertificate,
                now: now
            )
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let updated = RemoteDeviceConfiguration(
            storageVersion: configuration.storageVersion,
            accountSigningPublicKey:
                configuration.accountSigningPublicKey,
            identity: configuration.identity,
            certificate: response.deviceCertificate,
            hostCertificate: response.hostCertificate,
            relayURL: configuration.relayURL,
            relayAccessToken: configuration.relayAccessToken,
            relayCursor: configuration.relayCursor,
            outboundSequence: configuration.outboundSequence,
            inboundSequence: configuration.inboundSequence,
            pendingAckCursor: configuration.pendingAckCursor
        )
        try validateConfiguration(updated, now: now)
        return updated
    }

    private func sameCertificateIdentity(
        _ lhs: RemoteDeviceCertificateWire,
        _ rhs: RemoteDeviceCertificateWire
    ) -> Bool {
        lhs.accountId == rhs.accountId &&
            lhs.deviceId == rhs.deviceId &&
            lhs.name == rhs.name &&
            lhs.signingPublicKey == rhs.signingPublicKey &&
            lhs.agreementPublicKey == rhs.agreementPublicKey
    }

    private func certificateDoesNotRegress(
        _ renewed: RemoteDeviceCertificateWire,
        _ previous: RemoteDeviceCertificateWire
    ) throws -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        guard
            let renewedIssuedAt = formatter.date(from: renewed.issuedAt),
            let previousIssuedAt = formatter.date(from: previous.issuedAt),
            let renewedValidUntil = formatter.date(from: renewed.validUntil),
            let previousValidUntil = formatter.date(from: previous.validUntil)
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        return renewedIssuedAt >= previousIssuedAt &&
            renewedValidUntil >= previousValidUntil
    }

    private func renewalWasSatisfied(
        _ renewed: RemoteDeviceCertificateWire,
        previous: RemoteDeviceCertificateWire,
        now: Date
    ) throws -> Bool {
        guard try certificateNeedsRenewal(previous, now: now) else {
            return true
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        guard
            let renewedExpiration = formatter.date(from: renewed.validUntil),
            let previousExpiration = formatter.date(from: previous.validUntil)
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        return renewedExpiration > previousExpiration
    }

    private func validateConfiguration(
        _ configuration: RemoteDeviceConfiguration,
        now: Date
    ) throws {
        guard
            configuration.storageVersion == 1,
            configuration.relayCursor >= 0,
            configuration.relayCursor <= 9_007_199_254_740_991,
            configuration.outboundSequence >= 0,
            configuration.outboundSequence <= 9_007_199_254_740_991,
            configuration.inboundSequence >= 0,
            configuration.inboundSequence <= 9_007_199_254_740_991,
            configuration.pendingAckCursor.map({
                $0 > configuration.relayCursor &&
                $0 <= 9_007_199_254_740_991
            })
                ?? true
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        try RemoteBridgeCrypto.verifyConfiguration(
            configuration,
            now: now
        )
    }

    private func decodeControlResponse(
        _ data: Data
    ) throws -> RemoteControlResponseWire {
        guard
            let value = try JSONSerialization.jsonObject(with: data)
                as? [String: Any],
            Set(value.keys) == [
                "protocolVersion", "requestId", "status", "body",
            ]
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        let response = try JSONDecoder().decode(
            RemoteControlResponseWire.self,
            from: data
        )
        guard
            response.protocolVersion == remoteBridgeProtocolVersion,
            response.requestId.range(
                of: #"^rreq_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            (100...599).contains(response.status)
        else {
            throw RemoteDeviceClientError.invalidResponse
        }
        return response
    }

    private func apiError(status: Int, body: JSONValue) -> ApiClientError {
        if
            case .object(let root) = body,
            case .object(let error)? = root["error"],
            case .string(let message)? = error["message"]
        {
            let code: String?
            if case .string(let value)? = error["code"] {
                code = value
            } else {
                code = nil
            }
            return .server(
                status: status,
                code: code,
                message: message
            )
        }
        return .server(
            status: status,
            code: nil,
            message: "Remote control-plane request failed"
        )
    }

    private func randomHex(bytes: Int) throws -> String {
        var data = Data(count: bytes)
        let result = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, bytes, buffer.baseAddress!)
        }
        guard result == errSecSuccess else {
            throw RemoteDeviceClientError.invalidResponse
        }
        return data.map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
final class RemoteDeviceController {
    private let store: any RemoteDeviceConfigurationStore
    private let now: @Sendable () -> Date

    init(
        store: any RemoteDeviceConfigurationStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.now = now
    }

    func status() throws -> RemoteDeviceStatus {
        let configuration = try store.loadConfiguration()
        let pending = try store.loadPendingPairing()
        guard let configuration else {
            return RemoteDeviceStatus(
                configured: false,
                pendingPairing: pending != nil,
                relayURL: nil,
                deviceId: pending?.identity.deviceId,
                deviceName: nil,
                hostName: pending?.offer.hostCertificate.name,
                deviceCertificateValidUntil: nil,
                hostCertificateValidUntil:
                    pending?.offer.hostCertificate.validUntil
            )
        }
        try RemoteBridgeCrypto.verifyConfiguration(
            configuration,
            now: now()
        )
        return RemoteDeviceStatus(
            configured: true,
            pendingPairing: pending != nil,
            relayURL: configuration.relayURL,
            deviceId: configuration.identity.deviceId,
            deviceName: configuration.certificate.name,
            hostName: configuration.hostCertificate.name,
            deviceCertificateValidUntil:
                configuration.certificate.validUntil,
            hostCertificateValidUntil:
                configuration.hostCertificate.validUntil
        )
    }

    func beginPairing(
        bundleJSON: String,
        deviceName: String
    ) throws -> String {
        let pending = try RemoteBridgeCrypto.beginPairing(
            bundleJSON: bundleJSON,
            deviceName: deviceName,
            now: now()
        )
        try store.savePendingPairing(pending)
        return try RemoteBridgeCrypto.pairingRequestJSON(pending)
    }

    func completePairing(bootstrapJSON: String) throws {
        guard let pending = try store.loadPendingPairing() else {
            throw RemoteDeviceClientError.notConfigured
        }
        let configuration = try RemoteBridgeCrypto.completePairing(
            pending: pending,
            bootstrapJSON: bootstrapJSON,
            now: now()
        )
        try store.saveConfiguration(configuration)
        try store.deletePendingPairing()
    }

    func pendingRequestJSON() throws -> String? {
        guard let pending = try store.loadPendingPairing() else { return nil }
        return try RemoteBridgeCrypto.pairingRequestJSON(pending)
    }

    func clear() throws {
        try store.deleteConfiguration()
        try store.deletePendingPairing()
    }
}
