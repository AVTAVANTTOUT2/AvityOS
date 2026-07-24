import XCTest
@testable import AvityOS

final class KeychainStoreTests: XCTestCase {
    func testRoundTripAndDelete() throws {
        let account = "test-\(UUID().uuidString)"
        let store = KeychainCredentialStore(service: "com.avityos.tests", account: account)
        defer { try? store.deleteToken() }

        XCTAssertNil(try store.loadToken())
        try store.saveToken("secret-token")
        XCTAssertEqual(try store.loadToken(), "secret-token")
        try store.saveToken("rotated-token")
        XCTAssertEqual(try store.loadToken(), "rotated-token")
        try store.deleteToken()
        XCTAssertNil(try store.loadToken())
    }

    func testRemoteDeviceRoundTripRotationAndDelete() throws {
        let vector = try RemoteBridgeTestVector.load()
        let service = "com.avityos.tests.remote.\(UUID().uuidString)"
        let store = KeychainRemoteDeviceStore(service: service)
        defer {
            try? store.deleteConfiguration()
            try? store.deletePendingPairing()
        }

        XCTAssertNil(try store.loadConfiguration())
        XCTAssertNil(try store.loadPendingPairing())

        let pending = vector.pendingPairing()
        try store.savePendingPairing(pending)
        XCTAssertEqual(try store.loadPendingPairing(), pending)

        var configuration = try vector.configuration()
        try store.saveConfiguration(configuration)
        XCTAssertEqual(try store.loadConfiguration(), configuration)

        configuration.outboundSequence = 9
        configuration.inboundSequence = 8
        configuration.relayCursor = 7
        configuration.pendingAckCursor = 8
        try store.saveConfiguration(configuration)
        XCTAssertEqual(try store.loadConfiguration(), configuration)

        try store.deleteConfiguration()
        try store.deletePendingPairing()
        XCTAssertNil(try store.loadConfiguration())
        XCTAssertNil(try store.loadPendingPairing())
    }
}
