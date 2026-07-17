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
}
