import Foundation
import XCTest
@testable import AvityOS

final class RemoteBridgeCryptoTests: XCTestCase {
    func testOpensNodePairingBootstrapAndStaticEnvelope() throws {
        let vector = try RemoteBridgeTestVector.load()
        let now = try vector.date

        try RemoteBridgeCrypto.verifyCertificate(
            vector.hostCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            now: now
        )
        try RemoteBridgeCrypto.verifyCertificate(
            vector.remoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            now: now
        )

        let configuration = try vector.configuration()
        XCTAssertEqual(configuration.identity, vector.remoteIdentity)
        XCTAssertEqual(configuration.certificate, vector.remoteCertificate)
        XCTAssertEqual(configuration.hostCertificate, vector.hostCertificate)
        XCTAssertEqual(configuration.relayURL, "https://relay.example/bridge")
        XCTAssertEqual(
            configuration.relayAccessToken,
            "vector-device-token-xxxxxxxxxxxx"
        )

        let opened = try RemoteBridgeCrypto.openEnvelope(
            vector.envelope,
            recipientIdentity: vector.remoteIdentity,
            recipientCertificate: vector.remoteCertificate,
            senderCertificate: vector.hostCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            lastAcceptedSequence: 0,
            now: now
        )
        XCTAssertEqual(opened.contentType, remoteControlResponseContentType)
        XCTAssertEqual(opened.sequence, 1)
        XCTAssertEqual(
            try JSONValue(data: opened.plaintext),
            .object([
                "protocolVersion": .integer(1),
                "requestId": .string(
                    "rreq_ffffffffffffffffffffffffffffffff"
                ),
                "status": .integer(200),
                "body": .object([
                    "status": .string("ok"),
                    "version": .string("vector"),
                ]),
            ])
        )
    }

    func testSwiftEnvelopeRoundTripRejectsReplayAndTampering() throws {
        let vector = try RemoteBridgeTestVector.load()
        let now = try vector.date
        let plaintext = Data(#"{"action":"approve","allowed":true}"#.utf8)
        let envelope = try RemoteBridgeCrypto.sealEnvelope(
            plaintext: plaintext,
            contentType: remoteControlRequestContentType,
            sequence: 7,
            senderIdentity: vector.remoteIdentity,
            senderCertificate: vector.remoteCertificate,
            recipientCertificate: vector.hostCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            now: now
        )

        let opened = try RemoteBridgeCrypto.openEnvelope(
            envelope,
            recipientIdentity: vector.hostIdentity,
            recipientCertificate: vector.hostCertificate,
            senderCertificate: vector.remoteCertificate,
            accountSigningPublicKey: vector.accountSigningPublicKey,
            lastAcceptedSequence: 6,
            now: now
        )
        XCTAssertEqual(opened.plaintext, plaintext)

        XCTAssertThrowsError(
            try RemoteBridgeCrypto.openEnvelope(
                envelope,
                recipientIdentity: vector.hostIdentity,
                recipientCertificate: vector.hostCertificate,
                senderCertificate: vector.remoteCertificate,
                accountSigningPublicKey: vector.accountSigningPublicKey,
                lastAcceptedSequence: 7,
                now: now
            )
        ) { error in
            XCTAssertEqual(error as? RemoteBridgeCryptoError, .replay)
        }

        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: JSONEncoder().encode(envelope)
            ) as? [String: Any]
        )
        object["authTag"] = "AAAAAAAAAAAAAAAAAAAAAA"
        let tampered = try RemoteBridgeCrypto.decodeEnvelope(
            JSONSerialization.data(withJSONObject: object)
        )
        XCTAssertThrowsError(
            try RemoteBridgeCrypto.openEnvelope(
                tampered,
                recipientIdentity: vector.hostIdentity,
                recipientCertificate: vector.hostCertificate,
                senderCertificate: vector.remoteCertificate,
                accountSigningPublicKey: vector.accountSigningPublicKey,
                lastAcceptedSequence: 6,
                now: now
            )
        )
    }

    func testPairingCreatesNodeCompatibleStrictRequest() throws {
        let vector = try RemoteBridgeTestVector.load()
        let bundleJSON = try jsonString(vector.pairingBundle)
        let pending = try RemoteBridgeCrypto.beginPairing(
            bundleJSON: bundleJSON,
            deviceName: "Remote Mac",
            now: vector.date
        )

        XCTAssertEqual(
            pending.request.protocolVersion,
            remoteBridgeProtocolVersion
        )
        XCTAssertEqual(
            pending.request.sessionId,
            vector.pairingBundle.offer.sessionId
        )
        XCTAssertTrue(pending.identity.deviceId.hasPrefix("rdev_"))
        XCTAssertTrue(pending.identity.signingPublicKey.hasPrefix("MCowBQYDK2Vw"))
        XCTAssertTrue(pending.identity.agreementPublicKey.hasPrefix("MCowBQYDK2Vu"))

        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(bundleJSON.utf8))
                as? [String: Any]
        )
        object["unexpected"] = true
        let invalidJSON = try XCTUnwrap(
            String(
                data: JSONSerialization.data(withJSONObject: object),
                encoding: .utf8
            )
        )
        XCTAssertThrowsError(
            try RemoteBridgeCrypto.beginPairing(
                bundleJSON: invalidJSON,
                deviceName: "Remote Mac",
                now: vector.date
            )
        )
    }

    func testRelayURLPolicyAllowsOnlyHTTPSOrLoopbackHTTP() throws {
        XCTAssertEqual(
            try RemoteBridgeCrypto.validatedRelayURL(
                "http://[::1]:8080/bridge/"
            ).absoluteString,
            "http://[::1]:8080/bridge"
        )
        XCTAssertThrowsError(
            try RemoteBridgeCrypto.validatedRelayURL(
                "http://relay.example/bridge"
            )
        )
        XCTAssertThrowsError(
            try RemoteBridgeCrypto.validatedRelayURL(
                "https://token@relay.example/bridge"
            )
        )
    }
}
