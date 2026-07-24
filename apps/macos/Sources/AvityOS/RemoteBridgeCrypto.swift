import CryptoKit
import Foundation
import Security

enum RemoteBridgeCryptoError: LocalizedError, Equatable {
    case invalid(String)
    case expired(String)
    case authentication(String)
    case replay

    var errorDescription: String? {
        switch self {
        case .invalid(let detail): "Invalid remote bridge \(detail)."
        case .expired(let detail): "Expired remote bridge \(detail)."
        case .authentication(let detail): "Remote bridge authentication failed: \(detail)."
        case .replay: "Remote bridge replay or reordering detected."
        }
    }
}

struct OpenedRemoteEnvelope: Sendable {
    let plaintext: Data
    let contentType: String
    let messageId: String
    let sequence: Int
    let sentAt: String
}

enum RemoteBridgeCrypto {
    private static let pairingRequestContext =
        "avityos-remote-pairing-request-v1"
    private static let pairingAcceptanceContext =
        "avityos-remote-pairing-acceptance-v1"
    private static let pairingBootstrapContext =
        "avityos-remote-pairing-bootstrap-v1"
    private static let envelopeContext = "avityos-remote-envelope-v1"
    private static let maximumSafeInteger = 9_007_199_254_740_991
    private static let maximumClockSkew: TimeInterval = 5 * 60
    private static let maximumWireBytes = 5 * 1024 * 1024

    private static let ed25519PublicPrefix = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x70, 0x03, 0x21, 0x00,
    ])
    private static let ed25519PrivatePrefix = Data([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ])
    private static let x25519PublicPrefix = Data([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x6e, 0x03, 0x21, 0x00,
    ])
    private static let x25519PrivatePrefix = Data([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
    ])

    private struct PairingAAD: Encodable {
        let protocolVersion: Int
        let sessionId: String
        let direction: String
    }

    private struct PairingRequestPayload: Codable {
        struct PublicDevice: Codable {
            let deviceId: String
            let signingPublicKey: String
            let agreementPublicKey: String
        }

        let device: PublicDevice
        let name: String
        let requestedAt: String
    }

    private struct UnsignedCertificate: Encodable {
        let protocolVersion: Int
        let accountId: String
        let deviceId: String
        let name: String
        let signingPublicKey: String
        let agreementPublicKey: String
        let issuedAt: String
        let validUntil: String
    }

    private struct EnvelopeHeader: Encodable {
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
    }

    private struct UnsignedEnvelope: Encodable {
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
    }

    static func generateDeviceIdentity() throws -> RemoteDeviceIdentity {
        let signing = Curve25519.Signing.PrivateKey()
        let agreement = Curve25519.KeyAgreement.PrivateKey()
        return RemoteDeviceIdentity(
            deviceId: "rdev_\(try randomData(count: 16).hexString)",
            signingPublicKey: base64URL(
                ed25519PublicPrefix + signing.publicKey.rawRepresentation
            ),
            signingPrivateKey: base64URL(
                ed25519PrivatePrefix + signing.rawRepresentation
            ),
            agreementPublicKey: base64URL(
                x25519PublicPrefix + agreement.publicKey.rawRepresentation
            ),
            agreementPrivateKey: base64URL(
                x25519PrivatePrefix + agreement.rawRepresentation
            )
        )
    }

    static func beginPairing(
        bundleJSON: String,
        deviceName: String,
        now: Date = Date()
    ) throws -> PendingRemotePairing {
        let data = Data(bundleJSON.utf8)
        try requirePairingBundleShape(data)
        let bundle = try JSONDecoder().decode(RemotePairingBundleWire.self, from: data)
        try validateOffer(bundle.offer, now: now)
        let secret = try decodeBase64URL(bundle.pairingSecret, label: "pairing secret")
        guard secret.count == 32 else {
            throw RemoteBridgeCryptoError.invalid("pairing secret")
        }
        let normalizedName = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !normalizedName.isEmpty,
            normalizedName.count <= 120,
            !normalizedName.contains("\n"),
            !normalizedName.contains("\r")
        else {
            throw RemoteBridgeCryptoError.invalid("device name")
        }
        let identity = try generateDeviceIdentity()
        let payload = PairingRequestPayload(
            device: .init(
                deviceId: identity.deviceId,
                signingPublicKey: identity.signingPublicKey,
                agreementPublicKey: identity.agreementPublicKey
            ),
            name: normalizedName,
            requestedAt: iso(now)
        )
        let encrypted = try encrypt(
            try canonicalData(payload),
            key: pairingKey(
                secret: secret,
                sessionId: bundle.offer.sessionId,
                context: pairingRequestContext
            ),
            aad: try pairingAAD(
                sessionId: bundle.offer.sessionId,
                direction: "request"
            )
        )
        let request = RemotePairingRequestWire(
            protocolVersion: remoteBridgeProtocolVersion,
            sessionId: bundle.offer.sessionId,
            nonce: encrypted.nonce,
            ciphertext: encrypted.ciphertext,
            authTag: encrypted.authTag
        )
        return PendingRemotePairing(
            storageVersion: 1,
            offer: bundle.offer,
            pairingSecret: bundle.pairingSecret,
            identity: identity,
            request: request
        )
    }

    static func pairingRequestJSON(_ pending: PendingRemotePairing) throws -> String {
        guard pending.storageVersion == 1 else {
            throw RemoteBridgeCryptoError.invalid("pending pairing version")
        }
        return try encodedJSONString(pending.request)
    }

    static func completePairing(
        pending: PendingRemotePairing,
        bootstrapJSON: String,
        now: Date = Date()
    ) throws -> RemoteDeviceConfiguration {
        guard pending.storageVersion == 1 else {
            throw RemoteBridgeCryptoError.invalid("pending pairing version")
        }
        try validateOffer(pending.offer, now: now)
        let bootstrapData = Data(bootstrapJSON.utf8)
        try requireCipherShape(bootstrapData, label: "pairing bootstrap")
        let bootstrap = try JSONDecoder().decode(
            RemotePairingBootstrapWire.self,
            from: bootstrapData
        )
        guard
            bootstrap.protocolVersion == remoteBridgeProtocolVersion,
            bootstrap.sessionId == pending.offer.sessionId
        else {
            throw RemoteBridgeCryptoError.invalid("pairing bootstrap session")
        }
        let secret = try decodeBase64URL(
            pending.pairingSecret,
            label: "pairing secret"
        )
        let bootstrapPlaintext = try decrypt(
            nonce: bootstrap.nonce,
            ciphertext: bootstrap.ciphertext,
            authTag: bootstrap.authTag,
            key: pairingKey(
                secret: secret,
                sessionId: bootstrap.sessionId,
                context: pairingBootstrapContext
            ),
            aad: try pairingAAD(
                sessionId: bootstrap.sessionId,
                direction: "bootstrap"
            )
        )
        try requireBootstrapPayloadShape(bootstrapPlaintext)
        let payload = try JSONDecoder().decode(
            RemotePairingBootstrapPayloadWire.self,
            from: bootstrapPlaintext
        )
        guard payload.acceptance.sessionId == bootstrap.sessionId else {
            throw RemoteBridgeCryptoError.invalid("pairing acceptance session")
        }
        let certificateData = try decrypt(
            nonce: payload.acceptance.nonce,
            ciphertext: payload.acceptance.ciphertext,
            authTag: payload.acceptance.authTag,
            key: pairingKey(
                secret: secret,
                sessionId: bootstrap.sessionId,
                context: pairingAcceptanceContext
            ),
            aad: try pairingAAD(
                sessionId: bootstrap.sessionId,
                direction: "acceptance"
            )
        )
        try requireCertificateShape(certificateData)
        let certificate = try JSONDecoder().decode(
            RemoteDeviceCertificateWire.self,
            from: certificateData
        )
        try verifyCertificate(
            certificate,
            accountSigningPublicKey: pending.offer.accountSigningPublicKey,
            now: now
        )
        try assertIdentity(pending.identity, matches: certificate)
        guard certificate.accountId == pending.offer.accountId else {
            throw RemoteBridgeCryptoError.authentication(
                "paired certificate account mismatch"
            )
        }
        _ = try validatedRelayURL(payload.relayUrl)
        guard
            payload.relayAccessToken.count >= 32,
            payload.relayAccessToken.count <= 4_096,
            payload.relayAccessToken.rangeOfCharacter(
                from: .whitespacesAndNewlines
            ) == nil
        else {
            throw RemoteBridgeCryptoError.invalid("relay access token")
        }
        return RemoteDeviceConfiguration(
            storageVersion: 1,
            accountSigningPublicKey: pending.offer.accountSigningPublicKey,
            identity: pending.identity,
            certificate: certificate,
            hostCertificate: pending.offer.hostCertificate,
            relayURL: payload.relayUrl,
            relayAccessToken: payload.relayAccessToken,
            relayCursor: 0,
            outboundSequence: 0,
            inboundSequence: 0,
            pendingAckCursor: nil
        )
    }

    static func verifyCertificate(
        _ certificate: RemoteDeviceCertificateWire,
        accountSigningPublicKey: String,
        now: Date = Date()
    ) throws {
        guard
            certificate.protocolVersion == remoteBridgeProtocolVersion,
            certificate.accountId.range(
                of: #"^racc_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            certificate.deviceId.range(
                of: #"^rdev_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            certificate.name ==
                certificate.name.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ),
            !certificate.name.isEmpty,
            certificate.name.count <= 120
        else {
            throw RemoteBridgeCryptoError.invalid("device certificate")
        }
        let issuedAt = try parseDate(certificate.issuedAt)
        let validUntil = try parseDate(certificate.validUntil)
        guard now >= issuedAt, now <= validUntil else {
            throw RemoteBridgeCryptoError.expired("device certificate")
        }
        let publicKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: rawKey(
                certificateKey: accountSigningPublicKey,
                prefix: ed25519PublicPrefix,
                label: "account signing public key"
            )
        )
        let signature = try decodeBase64URL(
            certificate.signature,
            label: "certificate signature"
        )
        guard signature.count == 64 else {
            throw RemoteBridgeCryptoError.invalid("certificate signature")
        }
        let unsigned = UnsignedCertificate(
            protocolVersion: certificate.protocolVersion,
            accountId: certificate.accountId,
            deviceId: certificate.deviceId,
            name: certificate.name,
            signingPublicKey: certificate.signingPublicKey,
            agreementPublicKey: certificate.agreementPublicKey,
            issuedAt: certificate.issuedAt,
            validUntil: certificate.validUntil
        )
        guard publicKey.isValidSignature(signature, for: try canonicalData(unsigned)) else {
            throw RemoteBridgeCryptoError.authentication(
                "device certificate signature"
            )
        }
        _ = try rawKey(
            certificateKey: certificate.signingPublicKey,
            prefix: ed25519PublicPrefix,
            label: "device signing public key"
        )
        _ = try rawKey(
            certificateKey: certificate.agreementPublicKey,
            prefix: x25519PublicPrefix,
            label: "device agreement public key"
        )
    }

    static func sealEnvelope(
        plaintext: Data,
        contentType: String,
        sequence: Int,
        senderIdentity: RemoteDeviceIdentity,
        senderCertificate: RemoteDeviceCertificateWire,
        recipientCertificate: RemoteDeviceCertificateWire,
        accountSigningPublicKey: String,
        now: Date = Date()
    ) throws -> RemoteEncryptedEnvelopeWire {
        guard
            sequence > 0,
            sequence <= maximumSafeInteger,
            !contentType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            contentType.count <= 120
        else {
            throw RemoteBridgeCryptoError.invalid("envelope sequence or content type")
        }
        try verifyCertificate(
            senderCertificate,
            accountSigningPublicKey: accountSigningPublicKey,
            now: now
        )
        try verifyCertificate(
            recipientCertificate,
            accountSigningPublicKey: accountSigningPublicKey,
            now: now
        )
        try assertIdentity(senderIdentity, matches: senderCertificate)
        guard senderCertificate.accountId == recipientCertificate.accountId else {
            throw RemoteBridgeCryptoError.invalid("cross-account envelope")
        }
        let recipientKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: rawKey(
                certificateKey: recipientCertificate.agreementPublicKey,
                prefix: x25519PublicPrefix,
                label: "recipient agreement public key"
            )
        )
        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let sharedSecret = try ephemeral.sharedSecretFromKeyAgreement(
            with: recipientKey
        )
        let messageId = "rmsg_\(try randomData(count: 16).hexString)"
        let salt = try randomData(count: 32)
        let nonce = try randomData(count: 12)
        let header = EnvelopeHeader(
            protocolVersion: remoteBridgeProtocolVersion,
            messageId: messageId,
            accountId: senderCertificate.accountId,
            senderDeviceId: senderCertificate.deviceId,
            recipientDeviceId: recipientCertificate.deviceId,
            sequence: sequence,
            sentAt: iso(now),
            contentType: contentType,
            ephemeralPublicKey: base64URL(
                x25519PublicPrefix + ephemeral.publicKey.rawRepresentation
            ),
            salt: base64URL(salt),
            nonce: base64URL(nonce)
        )
        let key = envelopeKey(
            sharedSecret: sharedSecret,
            salt: salt,
            accountId: header.accountId,
            senderDeviceId: header.senderDeviceId,
            recipientDeviceId: header.recipientDeviceId,
            messageId: messageId
        )
        let sealed = try AES.GCM.seal(
            plaintext,
            using: key,
            nonce: try AES.GCM.Nonce(data: nonce),
            authenticating: try canonicalData(header)
        )
        let unsigned = UnsignedEnvelope(
            protocolVersion: header.protocolVersion,
            messageId: header.messageId,
            accountId: header.accountId,
            senderDeviceId: header.senderDeviceId,
            recipientDeviceId: header.recipientDeviceId,
            sequence: header.sequence,
            sentAt: header.sentAt,
            contentType: header.contentType,
            ephemeralPublicKey: header.ephemeralPublicKey,
            salt: header.salt,
            nonce: header.nonce,
            ciphertext: base64URL(sealed.ciphertext),
            authTag: base64URL(sealed.tag)
        )
        let signingKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: rawKey(
                certificateKey: senderIdentity.signingPrivateKey,
                prefix: ed25519PrivatePrefix,
                label: "device signing private key"
            )
        )
        return RemoteEncryptedEnvelopeWire(
            protocolVersion: unsigned.protocolVersion,
            messageId: unsigned.messageId,
            accountId: unsigned.accountId,
            senderDeviceId: unsigned.senderDeviceId,
            recipientDeviceId: unsigned.recipientDeviceId,
            sequence: unsigned.sequence,
            sentAt: unsigned.sentAt,
            contentType: unsigned.contentType,
            ephemeralPublicKey: unsigned.ephemeralPublicKey,
            salt: unsigned.salt,
            nonce: unsigned.nonce,
            ciphertext: unsigned.ciphertext,
            authTag: unsigned.authTag,
            signature: base64URL(
                try signingKey.signature(for: canonicalData(unsigned))
            )
        )
    }

    static func openEnvelope(
        _ envelope: RemoteEncryptedEnvelopeWire,
        recipientIdentity: RemoteDeviceIdentity,
        recipientCertificate: RemoteDeviceCertificateWire,
        senderCertificate: RemoteDeviceCertificateWire,
        accountSigningPublicKey: String,
        lastAcceptedSequence: Int,
        now: Date = Date()
    ) throws -> OpenedRemoteEnvelope {
        try validateEnvelopeFields(envelope)
        guard
            lastAcceptedSequence >= 0,
            lastAcceptedSequence <= maximumSafeInteger
        else {
            throw RemoteBridgeCryptoError.invalid("envelope")
        }
        try verifyCertificate(
            senderCertificate,
            accountSigningPublicKey: accountSigningPublicKey,
            now: now
        )
        try verifyCertificate(
            recipientCertificate,
            accountSigningPublicKey: accountSigningPublicKey,
            now: now
        )
        try assertIdentity(recipientIdentity, matches: recipientCertificate)
        guard
            envelope.accountId == senderCertificate.accountId,
            envelope.accountId == recipientCertificate.accountId,
            envelope.senderDeviceId == senderCertificate.deviceId,
            envelope.recipientDeviceId == recipientCertificate.deviceId
        else {
            throw RemoteBridgeCryptoError.authentication("envelope routing")
        }
        let sentAt = try parseDate(envelope.sentAt)
        guard sentAt.timeIntervalSince(now) <= maximumClockSkew else {
            throw RemoteBridgeCryptoError.invalid("future envelope timestamp")
        }
        let unsigned = UnsignedEnvelope(
            protocolVersion: envelope.protocolVersion,
            messageId: envelope.messageId,
            accountId: envelope.accountId,
            senderDeviceId: envelope.senderDeviceId,
            recipientDeviceId: envelope.recipientDeviceId,
            sequence: envelope.sequence,
            sentAt: envelope.sentAt,
            contentType: envelope.contentType,
            ephemeralPublicKey: envelope.ephemeralPublicKey,
            salt: envelope.salt,
            nonce: envelope.nonce,
            ciphertext: envelope.ciphertext,
            authTag: envelope.authTag
        )
        let senderKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: rawKey(
                certificateKey: senderCertificate.signingPublicKey,
                prefix: ed25519PublicPrefix,
                label: "sender signing public key"
            )
        )
        let signature = try decodeBase64URL(
            envelope.signature,
            label: "envelope signature"
        )
        guard senderKey.isValidSignature(signature, for: try canonicalData(unsigned)) else {
            throw RemoteBridgeCryptoError.authentication("envelope signature")
        }
        guard envelope.sequence > lastAcceptedSequence else {
            throw RemoteBridgeCryptoError.replay
        }
        let recipientKey = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: rawKey(
                certificateKey: recipientIdentity.agreementPrivateKey,
                prefix: x25519PrivatePrefix,
                label: "recipient agreement private key"
            )
        )
        let ephemeralKey = try Curve25519.KeyAgreement.PublicKey(
            rawRepresentation: rawKey(
                certificateKey: envelope.ephemeralPublicKey,
                prefix: x25519PublicPrefix,
                label: "ephemeral public key"
            )
        )
        let sharedSecret = try recipientKey.sharedSecretFromKeyAgreement(
            with: ephemeralKey
        )
        let salt = try decodeBase64URL(envelope.salt, label: "envelope salt")
        let header = EnvelopeHeader(
            protocolVersion: envelope.protocolVersion,
            messageId: envelope.messageId,
            accountId: envelope.accountId,
            senderDeviceId: envelope.senderDeviceId,
            recipientDeviceId: envelope.recipientDeviceId,
            sequence: envelope.sequence,
            sentAt: envelope.sentAt,
            contentType: envelope.contentType,
            ephemeralPublicKey: envelope.ephemeralPublicKey,
            salt: envelope.salt,
            nonce: envelope.nonce
        )
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(
                data: try decodeBase64URL(envelope.nonce, label: "envelope nonce")
            ),
            ciphertext: try decodeBase64URL(
                envelope.ciphertext,
                label: "envelope ciphertext"
            ),
            tag: try decodeBase64URL(envelope.authTag, label: "envelope tag")
        )
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                box,
                using: envelopeKey(
                    sharedSecret: sharedSecret,
                    salt: salt,
                    accountId: envelope.accountId,
                    senderDeviceId: envelope.senderDeviceId,
                    recipientDeviceId: envelope.recipientDeviceId,
                    messageId: envelope.messageId
                ),
                authenticating: try canonicalData(header)
            )
        } catch {
            throw RemoteBridgeCryptoError.authentication("envelope ciphertext")
        }
        return OpenedRemoteEnvelope(
            plaintext: plaintext,
            contentType: envelope.contentType,
            messageId: envelope.messageId,
            sequence: envelope.sequence,
            sentAt: envelope.sentAt
        )
    }

    static func decodeEnvelope(_ data: Data) throws -> RemoteEncryptedEnvelopeWire {
        try requireEnvelopeShape(data)
        let envelope = try JSONDecoder().decode(
            RemoteEncryptedEnvelopeWire.self,
            from: data
        )
        try validateEnvelopeFields(envelope)
        return envelope
    }

    static func validatedRelayURL(_ value: String) throws -> URL {
        guard
            value.count <= 2_048,
            value == value.trimmingCharacters(in: .whitespacesAndNewlines),
            var components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            let host = components.host?.lowercased(),
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil
        else {
            throw RemoteBridgeCryptoError.invalid("relay URL")
        }
        let policyHost = host.trimmingCharacters(
            in: CharacterSet(charactersIn: "[]")
        )
        if
            scheme == "http",
            !["127.0.0.1", "::1", "localhost"].contains(policyHost)
        {
            throw RemoteBridgeCryptoError.invalid("insecure relay URL")
        }
        components.scheme = scheme
        components.path = components.path.replacingOccurrences(
            of: #"/+$"#,
            with: "",
            options: .regularExpression
        )
        guard let url = components.url else {
            throw RemoteBridgeCryptoError.invalid("relay URL")
        }
        return url
    }

    static func verifyConfiguration(
        _ configuration: RemoteDeviceConfiguration,
        now: Date = Date()
    ) throws {
        guard
            configuration.storageVersion == 1,
            (0...maximumSafeInteger).contains(
                configuration.relayCursor
            ),
            (0...maximumSafeInteger).contains(
                configuration.outboundSequence
            ),
            (0...maximumSafeInteger).contains(
                configuration.inboundSequence
            ),
            configuration.pendingAckCursor.map({
                $0 > configuration.relayCursor &&
                $0 <= maximumSafeInteger
            }) ?? true
        else {
            throw RemoteBridgeCryptoError.invalid("device configuration")
        }
        try verifyCertificate(
            configuration.certificate,
            accountSigningPublicKey: configuration.accountSigningPublicKey,
            now: now
        )
        try verifyCertificate(
            configuration.hostCertificate,
            accountSigningPublicKey: configuration.accountSigningPublicKey,
            now: now
        )
        try assertIdentity(
            configuration.identity,
            matches: configuration.certificate
        )
        guard
            configuration.certificate.accountId ==
                configuration.hostCertificate.accountId,
            configuration.relayAccessToken.count >= 32,
            configuration.relayAccessToken.count <= 4_096,
            configuration.relayAccessToken.rangeOfCharacter(
                from: .whitespacesAndNewlines
            ) == nil
        else {
            throw RemoteBridgeCryptoError.invalid("device configuration")
        }
        _ = try validatedRelayURL(configuration.relayURL)
    }

    private static func validateOffer(
        _ offer: RemotePairingOfferWire,
        now: Date
    ) throws {
        guard
            offer.protocolVersion == remoteBridgeProtocolVersion,
            offer.sessionId.range(
                of: #"^rpair_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            offer.accountId.range(
                of: #"^racc_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            offer.accountId == offer.hostCertificate.accountId
        else {
            throw RemoteBridgeCryptoError.invalid("pairing offer")
        }
        guard now <= (try parseDate(offer.expiresAt)) else {
            throw RemoteBridgeCryptoError.expired("pairing offer")
        }
        try verifyCertificate(
            offer.hostCertificate,
            accountSigningPublicKey: offer.accountSigningPublicKey,
            now: now
        )
    }

    private static func assertIdentity(
        _ identity: RemoteDeviceIdentity,
        matches certificate: RemoteDeviceCertificateWire
    ) throws {
        guard
            identity.deviceId == certificate.deviceId,
            identity.signingPublicKey == certificate.signingPublicKey,
            identity.agreementPublicKey == certificate.agreementPublicKey
        else {
            throw RemoteBridgeCryptoError.authentication(
                "device identity does not match certificate"
            )
        }
        let signingPrivate = try Curve25519.Signing.PrivateKey(
            rawRepresentation: rawKey(
                certificateKey: identity.signingPrivateKey,
                prefix: ed25519PrivatePrefix,
                label: "device signing private key"
            )
        )
        let agreementPrivate = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: rawKey(
                certificateKey: identity.agreementPrivateKey,
                prefix: x25519PrivatePrefix,
                label: "device agreement private key"
            )
        )
        guard
            base64URL(
                ed25519PublicPrefix + signingPrivate.publicKey.rawRepresentation
            ) == identity.signingPublicKey,
            base64URL(
                x25519PublicPrefix + agreementPrivate.publicKey.rawRepresentation
            ) == identity.agreementPublicKey
        else {
            throw RemoteBridgeCryptoError.authentication(
                "device private key mismatch"
            )
        }
    }

    private static func pairingKey(
        secret: Data,
        sessionId: String,
        context: String
    ) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret),
            salt: Data(sessionId.utf8),
            info: Data(context.utf8),
            outputByteCount: 32
        )
    }

    private static func envelopeKey(
        sharedSecret: SharedSecret,
        salt: Data,
        accountId: String,
        senderDeviceId: String,
        recipientDeviceId: String,
        messageId: String
    ) -> SymmetricKey {
        sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: Data(
                [
                    envelopeContext,
                    accountId,
                    senderDeviceId,
                    recipientDeviceId,
                    messageId,
                ].joined(separator: "|").utf8
            ),
            outputByteCount: 32
        )
    }

    private static func pairingAAD(
        sessionId: String,
        direction: String
    ) throws -> Data {
        try canonicalData(PairingAAD(
            protocolVersion: remoteBridgeProtocolVersion,
            sessionId: sessionId,
            direction: direction
        ))
    }

    private static func encrypt(
        _ plaintext: Data,
        key: SymmetricKey,
        aad: Data
    ) throws -> (nonce: String, ciphertext: String, authTag: String) {
        let nonce = try randomData(count: 12)
        let sealed = try AES.GCM.seal(
            plaintext,
            using: key,
            nonce: try AES.GCM.Nonce(data: nonce),
            authenticating: aad
        )
        return (
            base64URL(nonce),
            base64URL(sealed.ciphertext),
            base64URL(sealed.tag)
        )
    }

    private static func decrypt(
        nonce: String,
        ciphertext: String,
        authTag: String,
        key: SymmetricKey,
        aad: Data
    ) throws -> Data {
        do {
            let nonceData = try decodeBase64URL(nonce, label: "nonce")
            let ciphertextData = try decodeBase64URL(
                ciphertext,
                label: "ciphertext"
            )
            let tagData = try decodeBase64URL(
                authTag,
                label: "authentication tag"
            )
            guard
                nonceData.count == 12,
                !ciphertextData.isEmpty,
                ciphertextData.count <= maximumWireBytes,
                tagData.count == 16
            else {
                throw RemoteBridgeCryptoError.invalid("encrypted payload")
            }
            return try AES.GCM.open(
                AES.GCM.SealedBox(
                    nonce: AES.GCM.Nonce(data: nonceData),
                    ciphertext: ciphertextData,
                    tag: tagData
                ),
                using: key,
                authenticating: aad
            )
        } catch let error as RemoteBridgeCryptoError {
            throw error
        } catch {
            throw RemoteBridgeCryptoError.authentication("encrypted payload")
        }
    }

    private static func canonicalData(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let encoded = try encoder.encode(value)
        let object = try JSONSerialization.jsonObject(
            with: encoded,
            options: [.fragmentsAllowed]
        )
        return try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]
        )
    }

    private static func encodedJSONString(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw RemoteBridgeCryptoError.invalid("JSON encoding")
        }
        return string
    }

    private static func rawKey(
        certificateKey: String,
        prefix: Data,
        label: String
    ) throws -> Data {
        let der = try decodeBase64URL(certificateKey, label: label)
        guard
            der.count == prefix.count + 32,
            der.prefix(prefix.count) == prefix
        else {
            throw RemoteBridgeCryptoError.invalid(label)
        }
        return der.dropFirst(prefix.count)
    }

    private static func decodeBase64URL(
        _ value: String,
        label: String
    ) throws -> Data {
        guard
            !value.isEmpty,
            value.range(
                of: #"^[A-Za-z0-9_-]+$"#,
                options: .regularExpression
            ) != nil
        else {
            throw RemoteBridgeCryptoError.invalid(label)
        }
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard
            let data = Data(base64Encoded: base64),
            !data.isEmpty,
            base64URL(data) == value
        else {
            throw RemoteBridgeCryptoError.invalid(label)
        }
        return data
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func randomData(count: Int) throws -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw RemoteBridgeCryptoError.invalid("secure randomness")
        }
        return data
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        return formatter.string(from: date)
    }

    private static func parseDate(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds,
        ]
        guard let date = formatter.date(from: value) else {
            throw RemoteBridgeCryptoError.invalid("timestamp")
        }
        return date
    }

    private static func requirePairingBundleShape(_ data: Data) throws {
        let root = try jsonObject(data, label: "pairing bundle")
        try requireKeys(root, ["offer", "pairingSecret"], label: "pairing bundle")
        guard let offer = root["offer"] as? [String: Any] else {
            throw RemoteBridgeCryptoError.invalid("pairing offer")
        }
        try requireKeys(
            offer,
            [
                "protocolVersion", "sessionId", "accountId",
                "accountSigningPublicKey", "hostCertificate", "expiresAt",
            ],
            label: "pairing offer"
        )
        guard let certificate = offer["hostCertificate"] as? [String: Any] else {
            throw RemoteBridgeCryptoError.invalid("host certificate")
        }
        try requireCertificateKeys(certificate)
    }

    private static func requireCipherShape(_ data: Data, label: String) throws {
        try requireKeys(
            jsonObject(data, label: label),
            ["protocolVersion", "sessionId", "nonce", "ciphertext", "authTag"],
            label: label
        )
    }

    private static func requireBootstrapPayloadShape(_ data: Data) throws {
        let root = try jsonObject(data, label: "bootstrap payload")
        try requireKeys(
            root,
            ["acceptance", "relayUrl", "relayAccessToken"],
            label: "bootstrap payload"
        )
        guard let acceptance = root["acceptance"] as? [String: Any] else {
            throw RemoteBridgeCryptoError.invalid("pairing acceptance")
        }
        try requireKeys(
            acceptance,
            ["protocolVersion", "sessionId", "nonce", "ciphertext", "authTag"],
            label: "pairing acceptance"
        )
    }

    private static func requireCertificateShape(_ data: Data) throws {
        try requireCertificateKeys(
            jsonObject(data, label: "device certificate")
        )
    }

    private static func requireCertificateKeys(
        _ object: [String: Any]
    ) throws {
        try requireKeys(
            object,
            [
                "protocolVersion", "accountId", "deviceId", "name",
                "signingPublicKey", "agreementPublicKey", "issuedAt",
                "validUntil", "signature",
            ],
            label: "device certificate"
        )
    }

    private static func requireEnvelopeShape(_ data: Data) throws {
        try requireKeys(
            jsonObject(data, label: "encrypted envelope"),
            [
                "protocolVersion", "messageId", "accountId",
                "senderDeviceId", "recipientDeviceId", "sequence", "sentAt",
                "contentType", "ephemeralPublicKey", "salt", "nonce",
                "ciphertext", "authTag", "signature",
            ],
            label: "encrypted envelope"
        )
    }

    private static func jsonObject(
        _ data: Data,
        label: String
    ) throws -> [String: Any] {
        guard
            data.count <= maximumWireBytes,
            let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw RemoteBridgeCryptoError.invalid(label)
        }
        return value
    }

    private static func requireKeys(
        _ object: [String: Any],
        _ keys: Set<String>,
        label: String
    ) throws {
        guard Set(object.keys) == keys else {
            throw RemoteBridgeCryptoError.invalid("\(label) fields")
        }
    }

    private static func validateEnvelopeFields(
        _ envelope: RemoteEncryptedEnvelopeWire
    ) throws {
        let trimmedContentType = envelope.contentType.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard
            envelope.protocolVersion == remoteBridgeProtocolVersion,
            envelope.messageId.range(
                of: #"^rmsg_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            envelope.accountId.range(
                of: #"^racc_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            envelope.senderDeviceId.range(
                of: #"^rdev_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            envelope.recipientDeviceId.range(
                of: #"^rdev_[a-f0-9]{32}$"#,
                options: .regularExpression
            ) != nil,
            envelope.sequence > 0,
            envelope.sequence <= maximumSafeInteger,
            !trimmedContentType.isEmpty,
            trimmedContentType == envelope.contentType,
            envelope.contentType.count <= 120
        else {
            throw RemoteBridgeCryptoError.invalid("encrypted envelope")
        }
        _ = try parseDate(envelope.sentAt)
        _ = try rawKey(
            certificateKey: envelope.ephemeralPublicKey,
            prefix: x25519PublicPrefix,
            label: "ephemeral public key"
        )
        let salt = try decodeBase64URL(envelope.salt, label: "envelope salt")
        let nonce = try decodeBase64URL(envelope.nonce, label: "envelope nonce")
        let ciphertext = try decodeBase64URL(
            envelope.ciphertext,
            label: "envelope ciphertext"
        )
        let tag = try decodeBase64URL(envelope.authTag, label: "envelope tag")
        let signature = try decodeBase64URL(
            envelope.signature,
            label: "envelope signature"
        )
        guard
            salt.count == 32,
            nonce.count == 12,
            !ciphertext.isEmpty,
            ciphertext.count <= maximumWireBytes,
            tag.count == 16,
            signature.count == 64
        else {
            throw RemoteBridgeCryptoError.invalid("encrypted envelope material")
        }
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
