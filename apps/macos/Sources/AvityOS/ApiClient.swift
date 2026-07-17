import Foundation

// Wire models mirror packages/contracts (ADR-0004). The control plane's zod
// schemas are the source of truth; keep these Codable structs in sync.

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
    let command: [String]
    let state: String
    let exitCode: Int?
}

struct TerminalLog: Codable, Hashable {
    let seq: Int
    let text: String
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

/// Authenticated control-plane client. The bearer lives only in Keychain and
/// every protected REST/SSE request carries it in an Authorization header.
@MainActor
final class ApiClient: ObservableObject {
    @Published var baseURL: URL
    @Published var connected = false
    @Published var version: String = "—"
    @Published var projects: [Project] = []
    @Published var missions: [Mission] = []
    @Published var approvals: [Approval] = []
    @Published var runs: [RunInfo] = []
    @Published var terminals: [TerminalInfo] = []
    @Published var lastError: String?
    @Published private(set) var tokenConfigured: Bool

    private var timer: Timer?
    private var eventTask: Task<Void, Never>?
    private let credentials: CredentialStore
    private var apiToken: String?

    init(
        baseURL: URL? = nil,
        credentials: CredentialStore = KeychainCredentialStore()
    ) {
        self.credentials = credentials
        let savedURL = UserDefaults.standard.string(forKey: "controlPlaneURL").flatMap(URL.init(string:))
        self.baseURL = baseURL ?? savedURL ?? URL(string: "http://127.0.0.1:7717")!
        self.apiToken = try? credentials.loadToken()
        self.tokenConfigured = !(self.apiToken?.isEmpty ?? true)
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        startEventStream()
        Task { await refresh() }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
        eventTask?.cancel()
        eventTask = nil
    }

    func configure(baseURL: URL, token: String) {
        do {
            try credentials.saveToken(token)
            apiToken = token
            tokenConfigured = true
            self.baseURL = baseURL
            UserDefaults.standard.set(baseURL.absoluteString, forKey: "controlPlaneURL")
            startEventStream()
            Task { await refresh() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func clearCredentials() {
        do { try credentials.deleteToken() } catch { lastError = error.localizedDescription }
        apiToken = nil
        tokenConfigured = false
        connected = false
        eventTask?.cancel()
    }

    func refresh() async {
        do {
            let health: HealthResponse = try await get("/v1/health")
            version = health.version
            connected = health.status == "ok"

            let projectsRes: ItemsResponse<Project> = try await get("/v1/projects")
            projects = projectsRes.items

            var allMissions: [Mission] = []
            for project in projects {
                let missionsRes: ItemsResponse<Mission> = try await get("/v1/projects/\(project.id)/missions")
                allMissions.append(contentsOf: missionsRes.items)
            }
            missions = allMissions

            let approvalsRes: ItemsResponse<Approval> = try await get("/v1/approvals?status=open")
            approvals = approvalsRes.items

            let runsRes: ItemsResponse<RunInfo> = try await get("/v1/runs")
            runs = runsRes.items
            let terminalsRes: ItemsResponse<TerminalInfo> = try await get("/v1/terminals")
            terminals = terminalsRes.items
            lastError = nil
        } catch {
            connected = false
            lastError = error.localizedDescription
        }
    }

    func resolveApproval(id: String, decision: String) async {
        struct Body: Codable { let decision: String; let note: String }
        do {
            let _: Approval = try await post("/v1/approvals/\(id)/resolve", body: Body(decision: decision, note: "resolved from macOS app"))
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func terminalLogs(id: String) async -> [TerminalLog] {
        do {
            let detail: TerminalDetail = try await get("/v1/terminals/\(id)")
            return detail.logs
        } catch {
            lastError = error.localizedDescription
            return []
        }
    }

    private func get<T: Codable>(_ path: String) async throws -> T {
        try await send(path: path, method: "GET", body: Optional<Data>.none)
    }

    private func post<T: Codable>(_ path: String, body: some Codable) async throws -> T {
        try await send(path: path, method: "POST", body: JSONEncoder().encode(body))
    }

    private func send<T: Codable>(path: String, method: String, body: Data?) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let apiToken { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.userAuthenticationRequired)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func startEventStream() {
        eventTask?.cancel()
        guard tokenConfigured else { return }
        eventTask = Task { [weak self] in
            var backoff: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    guard let url = URL(string: "/v1/events/stream?afterSeq=0", relativeTo: self.baseURL)?.absoluteURL else { return }
                    var request = URLRequest(url: url)
                    if let token = self.apiToken { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw URLError(.userAuthenticationRequired)
                    }
                    backoff = 1
                    for try await line in bytes.lines where line.hasPrefix("data:") {
                        if Task.isCancelled { return }
                        await self.refresh()
                    }
                } catch {
                    if Task.isCancelled { return }
                    self.connected = false
                    self.lastError = error.localizedDescription
                    try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                    backoff = min(backoff * 2, 30)
                }
            }
        }
    }
}
