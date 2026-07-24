@preconcurrency import Foundation

enum ApiClientError: LocalizedError, Equatable {
    case invalidEndpoint
    case insecureRemoteEndpoint
    case invalidToken
    case invalidResponse
    case server(status: Int, code: String?, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "The control-plane URL must be an HTTP(S) endpoint without embedded credentials."
        case .insecureRemoteEndpoint:
            return "Remote control-plane connections require HTTPS."
        case .invalidToken:
            return "The API token must be a non-empty value without whitespace."
        case .invalidResponse:
            return "The control plane returned an invalid response."
        case .server(let status, let code, let message):
            if let code {
                return "\(message) (\(code), HTTP \(status))"
            }
            return "\(message) (HTTP \(status))"
        }
    }
}

struct SSEEventCursor {
    private(set) var lastSequence: Int
    private var pendingSequence: Int?

    init(lastSequence: Int = 0) {
        self.lastSequence = max(0, lastSequence)
    }

    mutating func consume(line: String) -> Bool {
        if line.hasPrefix("id:") {
            let value = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
            pendingSequence = Int(value)
            return false
        }
        guard line.hasPrefix("data:") else {
            if line.isEmpty { pendingSequence = nil }
            return false
        }
        if let pendingSequence, pendingSequence > lastSequence {
            lastSequence = pendingSequence
        }
        return true
    }
}

enum ConnectionMode: String {
    case local
    case remote
}

/// Authenticated control-plane client. The bearer lives only in Keychain and
/// every protected REST/SSE request carries it in an Authorization header.
@MainActor
final class ApiClient: ObservableObject {
    @Published private(set) var baseURL: URL
    @Published private(set) var connected = false
    @Published private(set) var version: String = "—"
    @Published private(set) var projects: [Project] = []
    @Published private(set) var missions: [Mission] = []
    @Published private(set) var approvals: [Approval] = []
    @Published private(set) var runs: [RunInfo] = []
    @Published private(set) var terminals: [TerminalInfo] = []
    @Published private(set) var lastError: String?
    @Published private(set) var remoteHostStatus = RemoteHostStatus.unsupported
    @Published private(set) var remoteHostError: String?
    @Published private(set) var connectionMode: ConnectionMode
    @Published private(set) var remoteDeviceStatus: RemoteDeviceStatus
    @Published private(set) var remoteDeviceError: String?
    @Published private(set) var tokenConfigured: Bool

    private static let defaultEndpoint = URL(string: "http://127.0.0.1:7717/")!
    private static let endpointDefaultsKey = "controlPlaneURL"
    private static let eventSequenceDefaultsKey = "controlPlaneEventSequence"
    private static let connectionModeDefaultsKey = "connectionMode"

    private var pollingTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var refreshInProgress = false
    private var refreshRequested = false
    private var lastEventSequence: Int
    private let credentials: CredentialStore
    private let session: URLSession
    private let defaults: UserDefaults
    private let remoteDeviceController: RemoteDeviceController
    private let remoteDeviceTransport: RemoteDeviceTransport
    private var apiToken: String?

    init(
        baseURL: URL? = nil,
        credentials: CredentialStore = KeychainCredentialStore(),
        session: URLSession = .shared,
        defaults: UserDefaults = .standard,
        remoteStore: any RemoteDeviceConfigurationStore =
            KeychainRemoteDeviceStore(),
        remoteNow: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.credentials = credentials
        self.session = session
        self.defaults = defaults
        let remoteDeviceController = RemoteDeviceController(
            store: remoteStore,
            now: remoteNow
        )
        self.remoteDeviceController = remoteDeviceController
        self.remoteDeviceTransport = RemoteDeviceTransport(
            store: remoteStore,
            session: session,
            now: remoteNow
        )
        let remoteStatusResult = Result {
            try remoteDeviceController.status()
        }
        let remoteDeviceStatus =
            (try? remoteStatusResult.get()) ?? .unconfigured
        self.remoteDeviceStatus = remoteDeviceStatus
        let savedMode = defaults.string(
            forKey: Self.connectionModeDefaultsKey
        )
        self.connectionMode =
            savedMode == ConnectionMode.remote.rawValue &&
            remoteDeviceStatus.configured
                ? .remote
                : .local

        let savedURL = defaults.string(forKey: Self.endpointDefaultsKey).flatMap(URL.init(string:))
        let candidate = baseURL ?? savedURL ?? Self.defaultEndpoint
        let endpointResult = Result { try Self.validatedEndpoint(candidate) }
        self.baseURL = (try? endpointResult.get()) ?? Self.defaultEndpoint

        let tokenResult = Result { try credentials.loadToken() }
        let loadedToken = try? tokenResult.get()
        if let loadedToken, Self.isValidToken(loadedToken) {
            self.apiToken = loadedToken
            self.tokenConfigured = true
        } else {
            self.apiToken = nil
            self.tokenConfigured = false
        }
        self.lastEventSequence = max(0, defaults.integer(forKey: Self.eventSequenceDefaultsKey))

        if case .failure(let error) = endpointResult {
            self.lastError = error.localizedDescription
        } else if case .failure(let error) = tokenResult {
            self.lastError = error.localizedDescription
        } else if loadedToken != nil && !self.tokenConfigured {
            self.lastError = ApiClientError.invalidToken.localizedDescription
        }
        if case .failure(let error) = remoteStatusResult {
            self.remoteDeviceError = error.localizedDescription
        }
    }

    deinit {
        pollingTask?.cancel()
        eventTask?.cancel()
        eventRefreshTask?.cancel()
    }

    static func validatedEndpoint(_ input: URL) throws -> URL {
        guard
            var components = URLComponents(url: input, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            let host = components.host?.lowercased(),
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil
        else {
            throw ApiClientError.invalidEndpoint
        }
        let loopbackHosts = Set(["127.0.0.1", "::1", "localhost"])
        let policyHost = host.trimmingCharacters(
            in: CharacterSet(charactersIn: "[]")
        )
        if scheme == "http" && !loopbackHosts.contains(policyHost) {
            throw ApiClientError.insecureRemoteEndpoint
        }
        components.scheme = scheme
        if components.path.isEmpty {
            components.path = "/"
        } else if !components.path.hasSuffix("/") {
            components.path += "/"
        }
        guard let normalized = components.url else {
            throw ApiClientError.invalidEndpoint
        }
        return normalized
    }

    static func isValidToken(_ token: String) -> Bool {
        !token.isEmpty && token.count <= 4_096 && token.rangeOfCharacter(
            from: .whitespacesAndNewlines
        ) == nil
    }

    func startPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
        startEventStream()
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
        eventTask?.cancel()
        eventTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
    }

    func configure(baseURL inputURL: URL, token: String) {
        do {
            let endpoint = try Self.validatedEndpoint(inputURL)
            guard Self.isValidToken(token) else {
                throw ApiClientError.invalidToken
            }
            try credentials.saveToken(token)
            let endpointChanged = endpoint != baseURL
            apiToken = token
            tokenConfigured = true
            baseURL = endpoint
            defaults.set(endpoint.absoluteString, forKey: Self.endpointDefaultsKey)
            if endpointChanged {
                lastEventSequence = 0
                defaults.set(0, forKey: Self.eventSequenceDefaultsKey)
            }
            lastError = nil
            startEventStream()
            Task { await refresh() }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setConnectionMode(_ mode: ConnectionMode) {
        if mode == .remote && !remoteDeviceStatus.configured {
            remoteDeviceError = RemoteDeviceClientError.notConfigured
                .localizedDescription
            return
        }
        connectionMode = mode
        defaults.set(mode.rawValue, forKey: Self.connectionModeDefaultsKey)
        eventTask?.cancel()
        eventTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        if mode == .local {
            startEventStream()
        }
        Task { await refresh() }
    }

    func clearCredentials() {
        do {
            try credentials.deleteToken()
        } catch {
            lastError = error.localizedDescription
        }
        apiToken = nil
        tokenConfigured = false
        connected = false
        eventTask?.cancel()
        eventTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
    }

    func refresh() async {
        if refreshInProgress {
            refreshRequested = true
            return
        }
        refreshInProgress = true
        repeat {
            refreshRequested = false
            await refreshOnce()
        } while refreshRequested
        refreshInProgress = false
    }

    private func refreshOnce() async {
        do {
            let health: HealthResponse = try await get("/v1/health")
            let projectResponse: ItemsResponse<Project> = try await get("/v1/projects")
            var loadedMissions: [Mission] = []
            for project in projectResponse.items {
                let response: ItemsResponse<Mission> = try await get(
                    "/v1/projects/\(project.id)/missions"
                )
                loadedMissions.append(contentsOf: response.items)
            }
            let approvalResponse: ItemsResponse<Approval> = try await get(
                "/v1/approvals?status=open"
            )
            let runResponse: ItemsResponse<RunInfo> = try await get("/v1/runs")
            let terminalResponse: ItemsResponse<TerminalInfo> = try await get("/v1/terminals")
            let loadedRemoteHostStatus: RemoteHostStatus? =
                connectionMode == .local
                    ? try? await get("/v1/remote-host")
                    : nil

            version = health.version
            projects = projectResponse.items
            missions = loadedMissions
            approvals = approvalResponse.items
            runs = runResponse.items
            terminals = terminalResponse.items
            if let loadedRemoteHostStatus {
                remoteHostStatus = loadedRemoteHostStatus
                remoteHostError = loadedRemoteHostStatus.lastError
            }
            if connectionMode == .remote {
                remoteDeviceStatus = try remoteDeviceController.status()
                remoteDeviceError = nil
            }
            connected = health.status == "ok"
            lastError = nil
        } catch {
            connected = false
            lastError = error.localizedDescription
        }
    }

    func resolveApproval(id: String, decision: String) async {
        struct Body: Codable {
            let decision: String
            let note: String
        }
        do {
            let _: Approval = try await post(
                "/v1/approvals/\(id)/resolve",
                body: Body(decision: decision, note: "resolved from macOS app")
            )
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

    func configureRemoteHost(
        relayURL: String,
        relayAdminToken: String,
        deviceName: String
    ) async {
        struct Body: Codable {
            let relayUrl: String
            let relayAdminToken: String
            let deviceName: String
        }
        do {
            remoteHostStatus = try await post(
                "/v1/remote-host/configure",
                body: Body(
                    relayUrl: relayURL,
                    relayAdminToken: relayAdminToken,
                    deviceName: deviceName
                )
            )
            remoteHostError = remoteHostStatus.lastError
        } catch {
            remoteHostError = error.localizedDescription
        }
    }

    func createRemotePairing() async -> RemotePairingBundleResponse? {
        struct EmptyBody: Codable {}
        do {
            let response: RemotePairingBundleResponse = try await post(
                "/v1/remote-host/pairing-sessions",
                body: EmptyBody()
            )
            remoteHostError = nil
            return response
        } catch {
            remoteHostError = error.localizedDescription
            return nil
        }
    }

    func acceptRemotePairing(
        sessionId: String,
        request: String
    ) async -> RemotePairingBootstrapResponse? {
        struct Body: Codable {
            let request: String
        }
        do {
            let response: RemotePairingBootstrapResponse = try await post(
                "/v1/remote-host/pairing-sessions/\(sessionId)/accept",
                body: Body(request: request)
            )
            let status: RemoteHostStatus = try await get("/v1/remote-host")
            remoteHostStatus = status
            remoteHostError = status.lastError
            return response
        } catch {
            remoteHostError = error.localizedDescription
            return nil
        }
    }

    func revokeRemoteDevice(id: String) async {
        struct EmptyBody: Codable {}
        do {
            remoteHostStatus = try await post(
                "/v1/remote-host/devices/\(id)/revoke",
                body: EmptyBody()
            )
            remoteHostError = remoteHostStatus.lastError
        } catch {
            remoteHostError = error.localizedDescription
        }
    }

    func renewRemoteDeviceCertificates() async {
        do {
            try await remoteDeviceTransport.renewCertificates()
            remoteDeviceStatus = try remoteDeviceController.status()
            remoteDeviceError = nil
        } catch {
            remoteDeviceError = error.localizedDescription
        }
    }

    func beginRemoteDevicePairing(
        bundle: String,
        deviceName: String
    ) -> String? {
        do {
            let request = try remoteDeviceController.beginPairing(
                bundleJSON: bundle,
                deviceName: deviceName
            )
            remoteDeviceStatus = try remoteDeviceController.status()
            remoteDeviceError = nil
            return request
        } catch {
            remoteDeviceError = error.localizedDescription
            return nil
        }
    }

    func completeRemoteDevicePairing(bootstrap: String) {
        do {
            try remoteDeviceController.completePairing(
                bootstrapJSON: bootstrap
            )
            remoteDeviceStatus = try remoteDeviceController.status()
            remoteDeviceError = nil
        } catch {
            remoteDeviceError = error.localizedDescription
        }
    }

    func pendingRemoteDevicePairingRequest() -> String? {
        do {
            return try remoteDeviceController.pendingRequestJSON()
        } catch {
            remoteDeviceError = error.localizedDescription
            return nil
        }
    }

    func clearRemoteDevice() {
        do {
            try remoteDeviceController.clear()
            if connectionMode == .remote {
                connectionMode = .local
                defaults.set(
                    ConnectionMode.local.rawValue,
                    forKey: Self.connectionModeDefaultsKey
                )
                startEventStream()
            }
            remoteDeviceStatus = try remoteDeviceController.status()
            remoteDeviceError = nil
        } catch {
            remoteDeviceError = error.localizedDescription
        }
    }

    private func get<T: Codable>(_ path: String) async throws -> T {
        try await send(path: path, method: "GET", body: Optional<Data>.none)
    }

    private func post<T: Codable>(_ path: String, body: some Codable) async throws -> T {
        try await send(path: path, method: "POST", body: JSONEncoder().encode(body))
    }

    private func endpointURL(for path: String) throws -> URL {
        let relativePath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard let url = URL(string: relativePath, relativeTo: baseURL)?.absoluteURL else {
            throw ApiClientError.invalidEndpoint
        }
        return url
    }

    private func send<T: Codable>(path: String, method: String, body: Data?) async throws -> T {
        if connectionMode == .remote {
            let data = try await remoteDeviceTransport.send(
                path: path,
                method: method,
                body: body
            )
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw ApiClientError.invalidResponse
            }
        }
        var request = URLRequest(url: try endpointURL(for: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        if let apiToken {
            request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            throw ApiClientError.server(
                status: http.statusCode,
                code: apiError?.error.code,
                message: apiError?.error.message ?? "Control-plane request failed"
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiClientError.invalidResponse
        }
    }

    private func startEventStream() {
        eventTask?.cancel()
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        guard tokenConfigured, connectionMode == .local else { return }
        eventTask = Task { [weak self] in
            var backoff: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let url = try self.endpointURL(
                        for: "/v1/events/stream?afterSeq=\(self.lastEventSequence)"
                    )
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    request.setValue("no-store", forHTTPHeaderField: "cache-control")
                    if let token = self.apiToken {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
                    }
                    let (bytes, response) = try await self.session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw ApiClientError.invalidResponse
                    }
                    guard http.statusCode == 200 else {
                        throw ApiClientError.server(
                            status: http.statusCode,
                            code: nil,
                            message: "Control-plane event stream failed"
                        )
                    }
                    backoff = 1
                    var cursor = SSEEventCursor(lastSequence: self.lastEventSequence)
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        if cursor.consume(line: line) {
                            self.lastEventSequence = cursor.lastSequence
                            self.defaults.set(
                                cursor.lastSequence,
                                forKey: Self.eventSequenceDefaultsKey
                            )
                            self.scheduleEventRefresh()
                        }
                    }
                    if !Task.isCancelled {
                        throw URLError(.networkConnectionLost)
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

    private func scheduleEventRefresh() {
        guard eventRefreshTask == nil else { return }
        eventRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
            self.eventRefreshTask = nil
        }
    }
}
