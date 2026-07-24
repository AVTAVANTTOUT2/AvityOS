import Foundation
@testable import AvityOS

struct RemoteBridgeTestVector: Decodable {
    let now: String
    let accountSigningPublicKey: String
    let hostIdentity: RemoteDeviceIdentity
    let remoteIdentity: RemoteDeviceIdentity
    let hostCertificate: RemoteDeviceCertificateWire
    let remoteCertificate: RemoteDeviceCertificateWire
    let pairingBundle: RemotePairingBundleWire
    let bootstrap: RemotePairingBootstrapWire
    let envelope: RemoteEncryptedEnvelopeWire

    static func load() throws -> RemoteBridgeTestVector {
        guard
            let url = Bundle.module.url(
                forResource: "remote-bridge-vector",
                withExtension: "json"
            )
        else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(
            RemoteBridgeTestVector.self,
            from: Data(contentsOf: url)
        )
    }

    var date: Date {
        get throws {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [
                .withInternetDateTime,
                .withFractionalSeconds,
            ]
            guard let value = formatter.date(from: now) else {
                throw CocoaError(.coderInvalidValue)
            }
            return value
        }
    }

    func pendingPairing() -> PendingRemotePairing {
        PendingRemotePairing(
            storageVersion: 1,
            offer: pairingBundle.offer,
            pairingSecret: pairingBundle.pairingSecret,
            identity: remoteIdentity,
            request: RemotePairingRequestWire(
                protocolVersion: remoteBridgeProtocolVersion,
                sessionId: pairingBundle.offer.sessionId,
                nonce: "AAAAAAAAAAAAAAAA",
                ciphertext: "AA",
                authTag: "AAAAAAAAAAAAAAAAAAAAAA"
            )
        )
    }

    func configuration() throws -> RemoteDeviceConfiguration {
        try RemoteBridgeCrypto.completePairing(
            pending: pendingPairing(),
            bootstrapJSON: try jsonString(bootstrap),
            now: date
        )
    }
}

func jsonString(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    guard let string = String(data: data, encoding: .utf8) else {
        throw CocoaError(.coderInvalidValue)
    }
    return string
}

final class MemoryRemoteDeviceStore:
    @unchecked Sendable,
    RemoteDeviceConfigurationStore
{
    private let lock = NSLock()
    private var configuration: RemoteDeviceConfiguration?
    private var pendingPairing: PendingRemotePairing?

    init(
        configuration: RemoteDeviceConfiguration? = nil,
        pendingPairing: PendingRemotePairing? = nil
    ) {
        self.configuration = configuration
        self.pendingPairing = pendingPairing
    }

    func loadConfiguration() throws -> RemoteDeviceConfiguration? {
        lock.lock()
        defer { lock.unlock() }
        return configuration
    }

    func saveConfiguration(_ configuration: RemoteDeviceConfiguration) throws {
        lock.lock()
        defer { lock.unlock() }
        self.configuration = configuration
    }

    func deleteConfiguration() throws {
        lock.lock()
        defer { lock.unlock() }
        configuration = nil
    }

    func loadPendingPairing() throws -> PendingRemotePairing? {
        lock.lock()
        defer { lock.unlock() }
        return pendingPairing
    }

    func savePendingPairing(_ pairing: PendingRemotePairing) throws {
        lock.lock()
        defer { lock.unlock() }
        pendingPairing = pairing
    }

    func deletePendingPairing() throws {
        lock.lock()
        defer { lock.unlock() }
        pendingPairing = nil
    }
}
