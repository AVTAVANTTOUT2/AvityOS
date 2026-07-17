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

struct ItemsResponse<T: Codable>: Codable {
    let items: [T]
}

struct HealthResponse: Codable {
    let status: String
    let version: String
}

/// Minimal control-plane client. Local-first: talks to 127.0.0.1 by default.
/// API tokens, when configured, belong in the Keychain — see SECURITY.md;
/// the development build connects tokenless to the local loopback plane.
@MainActor
final class ApiClient: ObservableObject {
    @Published var baseURL: URL
    @Published var connected = false
    @Published var version: String = "—"
    @Published var projects: [Project] = []
    @Published var missions: [Mission] = []
    @Published var approvals: [Approval] = []
    @Published var runs: [RunInfo] = []
    @Published var lastError: String?

    private var timer: Timer?

    init(baseURL: URL = URL(string: "http://127.0.0.1:7717")!) {
        self.baseURL = baseURL
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        Task { await refresh() }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
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

    private func get<T: Codable>(_ path: String) async throws -> T {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appending(path: path))
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Codable>(_ path: String, body: some Codable) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
