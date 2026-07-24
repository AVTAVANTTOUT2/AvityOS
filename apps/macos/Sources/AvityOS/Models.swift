import Foundation

// Wire models mirror packages/contracts (ADR-0004). The control plane's Zod
// schemas remain the source of truth; Codable deliberately ignores fields a
// particular native screen does not render.

struct Project: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let status: String
    let autonomyProfile: String
    let description: String
}

struct Mission: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let title: String
    let role: String
    let state: String
    let priority: Int
}

struct Approval: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let title: String
    let description: String
    let status: String
}

struct RunInfo: Codable, Identifiable, Hashable {
    let id: String
    let missionId: String
    let state: String
    let model: String?
    let costUsd: Double
}

struct TerminalInfo: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    /// Canonical TerminalSession.command is a display-safe string.
    let command: String
    let state: String
    let exitCode: Int?
}

struct TerminalLog: Codable, Hashable {
    let seq: Int
    let text: String
    let createdAt: String?
}

struct TerminalDetail: Codable {
    let logs: [TerminalLog]
}

struct ItemsResponse<T: Codable>: Codable {
    let items: [T]
}

struct HealthResponse: Codable {
    let status: String
    let version: String
}

struct RemoteHostDevice: Codable, Identifiable, Hashable {
    let deviceId: String
    let name: String
    let status: String
    let validUntil: String
    let isHost: Bool

    var id: String { deviceId }
}

struct RemoteHostStatus: Codable, Hashable {
    let supported: Bool
    let configured: Bool
    let connectorState: String
    let relayUrl: String?
    let accountId: String?
    let hostDeviceId: String?
    let devices: [RemoteHostDevice]
    let lastError: String?

    static let unsupported = RemoteHostStatus(
        supported: false,
        configured: false,
        connectorState: "unsupported",
        relayUrl: nil,
        accountId: nil,
        hostDeviceId: nil,
        devices: [],
        lastError: nil
    )
}

struct RemotePairingBundleResponse: Codable {
    let sessionId: String
    let expiresAt: String
    let pairingBundle: String
}

struct RemotePairingBootstrapResponse: Codable {
    let sessionId: String
    let bootstrap: String
}

struct APIErrorResponse: Codable {
    struct Detail: Codable {
        let code: String
        let message: String
    }

    let error: Detail
}
