import Foundation
import Security

protocol RemoteDeviceConfigurationStore: Sendable {
    func loadConfiguration() throws -> RemoteDeviceConfiguration?
    func saveConfiguration(_ configuration: RemoteDeviceConfiguration) throws
    func deleteConfiguration() throws
    func loadPendingPairing() throws -> PendingRemotePairing?
    func savePendingPairing(_ pairing: PendingRemotePairing) throws
    func deletePendingPairing() throws
}

struct KeychainRemoteDeviceStore: RemoteDeviceConfigurationStore {
    private let service: String

    init(service: String = "com.avityos.remote-device") {
        self.service = service
    }

    func loadConfiguration() throws -> RemoteDeviceConfiguration? {
        try load(RemoteDeviceConfiguration.self, account: "configuration")
    }

    func saveConfiguration(_ configuration: RemoteDeviceConfiguration) throws {
        try save(configuration, account: "configuration")
    }

    func deleteConfiguration() throws {
        try delete(account: "configuration")
    }

    func loadPendingPairing() throws -> PendingRemotePairing? {
        try load(PendingRemotePairing.self, account: "pending-pairing")
    }

    func savePendingPairing(_ pairing: PendingRemotePairing) throws {
        try save(pairing, account: "pending-pairing")
    }

    func deletePendingPairing() throws {
        try delete(account: "pending-pairing")
    }

    private func load<Value: Decodable>(
        _ type: Value.Type,
        account: String
    ) throws -> Value? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private func save<Value: Encodable>(
        _ value: Value,
        account: String
    ) throws {
        let data = try JSONEncoder().encode(value)
        let query = baseQuery(account: account)
        let status = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] =
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainStoreError.unexpectedStatus(addStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    private func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
