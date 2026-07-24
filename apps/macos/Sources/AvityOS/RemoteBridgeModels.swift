import Foundation

let remoteBridgeProtocolVersion = 1
let remoteControlRequestContentType =
    "application/vnd.avityos.remote-control-request+json"
let remoteControlResponseContentType =
    "application/vnd.avityos.remote-control-response+json"
let remoteCertificateRenewalPath = "/v1/remote/certificates/renew"

enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case integer(Int64)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            guard value.isFinite else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "JSON number must be finite"
                )
            }
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    init(data: Data) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

struct RemoteDeviceIdentity: Codable, Equatable, Sendable {
    let deviceId: String
    let signingPublicKey: String
    let signingPrivateKey: String
    let agreementPublicKey: String
    let agreementPrivateKey: String
}

struct RemoteDeviceCertificateWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let accountId: String
    let deviceId: String
    let name: String
    let signingPublicKey: String
    let agreementPublicKey: String
    let issuedAt: String
    let validUntil: String
    let signature: String
}

struct RemotePairingOfferWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let accountId: String
    let accountSigningPublicKey: String
    let hostCertificate: RemoteDeviceCertificateWire
    let expiresAt: String
}

struct RemotePairingBundleWire: Codable, Equatable, Sendable {
    let offer: RemotePairingOfferWire
    let pairingSecret: String
}

struct RemotePairingRequestWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let nonce: String
    let ciphertext: String
    let authTag: String
}

struct RemotePairingAcceptanceWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let nonce: String
    let ciphertext: String
    let authTag: String
}

struct RemotePairingBootstrapWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let sessionId: String
    let nonce: String
    let ciphertext: String
    let authTag: String
}

struct RemotePairingBootstrapPayloadWire: Codable, Equatable, Sendable {
    let acceptance: RemotePairingAcceptanceWire
    let relayUrl: String
    let relayAccessToken: String
}

struct PendingRemotePairing: Codable, Equatable, Sendable {
    let storageVersion: Int
    let offer: RemotePairingOfferWire
    let pairingSecret: String
    let identity: RemoteDeviceIdentity
    let request: RemotePairingRequestWire
}

struct RemoteDeviceConfiguration: Codable, Equatable, Sendable {
    let storageVersion: Int
    let accountSigningPublicKey: String
    let identity: RemoteDeviceIdentity
    let certificate: RemoteDeviceCertificateWire
    let hostCertificate: RemoteDeviceCertificateWire
    let relayURL: String
    let relayAccessToken: String
    var relayCursor: Int
    var outboundSequence: Int
    var inboundSequence: Int
    var pendingAckCursor: Int?
}

struct RemoteEncryptedEnvelopeWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let messageId: String
    let accountId: String
    let senderDeviceId: String
    let recipientDeviceId: String
    let sequence: Int
    let sentAt: String
    let contentType: String
    let ephemeralPublicKey: String
    let salt: String
    let nonce: String
    let ciphertext: String
    let authTag: String
    let signature: String
}

struct RemoteRelayPublishResultWire: Codable, Equatable, Sendable {
    let messageId: String
    let acceptedAt: String
    let duplicate: Bool
}

struct RemoteRelayItemWire: Codable, Equatable, Sendable {
    let cursor: Int
    let receivedAt: String
    let envelope: RemoteEncryptedEnvelopeWire
}

struct RemoteRelayInboxWire: Codable, Equatable, Sendable {
    let items: [RemoteRelayItemWire]
    let nextCursor: Int
}

struct RemoteRelayAckResultWire: Codable, Equatable, Sendable {
    let throughCursor: Int
    let deleted: Int
}

struct RemoteControlRequestWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let requestId: String
    let method: String
    let path: String
    let body: JSONValue?
}

struct RemoteControlResponseWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let requestId: String
    let status: Int
    let body: JSONValue
}

struct RemoteCertificateRenewalRequestWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
}

struct RemoteCertificateRenewalResponseWire: Codable, Equatable, Sendable {
    let protocolVersion: Int
    let deviceCertificate: RemoteDeviceCertificateWire
    let hostCertificate: RemoteDeviceCertificateWire
}

struct RemoteDeviceStatus: Equatable, Sendable {
    let configured: Bool
    let pendingPairing: Bool
    let relayURL: String?
    let deviceId: String?
    let deviceName: String?
    let hostName: String?
    let deviceCertificateValidUntil: String?
    let hostCertificateValidUntil: String?

    static let unconfigured = RemoteDeviceStatus(
        configured: false,
        pendingPairing: false,
        relayURL: nil,
        deviceId: nil,
        deviceName: nil,
        hostName: nil,
        deviceCertificateValidUntil: nil,
        hostCertificateValidUntil: nil
    )
}
