import SwiftUI
import UserNotifications

@main
struct AvityOSApp: App {
    @StateObject private var client = ApiClient()

    var body: some Scene {
        WindowGroup("AvityOS", id: "main") {
            ContentView()
                .environmentObject(client)
                .onAppear {
                    if !AppRuntime.isUITesting {
                        NotificationCoordinator.requestAuthorization()
                        client.startPolling()
                    }
                }
                .onChange(of: client.approvals.count) { previous, count in
                    NSApplication.shared.dockTile.badgeLabel = count > 0 ? String(count) : nil
                    if count > previous { NotificationCoordinator.notifyInterventions(count: count) }
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Rafraîchir") { Task { await client.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

        MenuBarExtra("AvityOS", systemImage: "brain") {
            MenuBarView().environmentObject(client)
        }

        Settings {
            SettingsView().environmentObject(client).frame(minWidth: 520, minHeight: 320)
        }
    }
}

enum AppRuntime {
    static var isUITesting: Bool {
        ProcessInfo.processInfo.environment["AVITY_UI_TEST_MODE"] == "1"
    }
}

enum NotificationCoordinator {
    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }

    static func notifyInterventions(count: Int) {
        let content = UNMutableNotificationContent()
        content.title = "AvityOS attend une décision"
        content.body = "\(count) intervention\(count == 1 ? "" : "s") en attente."
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "avity-interventions-\(count)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

enum SidebarItem: String, CaseIterable, Identifiable {
    case projects = "Projets"
    case missions = "Missions"
    case interventions = "Interventions"
    case runs = "Exécutions"
    case terminals = "Terminaux"
    case settings = "Réglages"
    var id: String { rawValue }
    var accessibilityIdentifier: String {
        switch self {
        case .projects: "sidebar.projects"
        case .missions: "sidebar.missions"
        case .interventions: "sidebar.interventions"
        case .runs: "sidebar.runs"
        case .terminals: "sidebar.terminals"
        case .settings: "sidebar.settings"
        }
    }
    var icon: String {
        switch self {
        case .projects: "folder"
        case .missions: "list.bullet.rectangle"
        case .interventions: "tray.full"
        case .runs: "terminal"
        case .terminals: "terminal.fill"
        case .settings: "gearshape"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var client: ApiClient
    @State private var selection: SidebarItem? = .projects

    var body: some View {
        NavigationSplitView {
            List(SidebarItem.allCases, selection: $selection) { item in
                Label(item.rawValue, systemImage: item.icon)
                    .badge(item == .interventions ? client.approvals.count : 0)
                    .tag(item)
                    .accessibilityIdentifier(item.accessibilityIdentifier)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210)
            .navigationTitle("AvityOS")
        } detail: {
            Group {
                switch selection ?? .projects {
                case .projects: ProjectsView()
                case .missions: MissionsView()
                case .interventions: InterventionsView()
                case .runs: RunsView()
                case .terminals: TerminalsView()
                case .settings: SettingsView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .status) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(client.connected ? .green : .orange)
                            .frame(width: 8, height: 8)
                        Text(connectionLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("connection.status")
                    }
                }
            }
        }
        // Liquid-Glass-influenced material treatment with graceful fallback
        .background(.ultraThinMaterial)
        .onOpenURL { url in
            switch url.host {
            case "missions": selection = .missions
            case "terminals": selection = .terminals
            case "interventions": selection = .interventions
            case "settings": selection = .settings
            default: selection = .projects
            }
        }
        .frame(minWidth: 900, minHeight: 600)
    }

    private var connectionLabel: String {
        guard client.connected else { return "Hors ligne — reconnexion…" }
        if client.connectionMode == .remote {
            return "Relais chiffré · Control plane v\(client.version)"
        }
        return "Control plane local v\(client.version)"
    }
}

struct ProjectsView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        List(client.projects) { project in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(project.name).font(.headline)
                    Spacer()
                    Text(project.status)
                        .font(.caption2.bold())
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(statusColor(project.status).opacity(0.15), in: Capsule())
                        .foregroundStyle(statusColor(project.status))
                }
                if !project.description.isEmpty {
                    Text(project.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .padding(.vertical, 4)
        }
        .overlay {
            if client.projects.isEmpty {
                ContentUnavailableView(
                    client.connected ? "Aucun projet" : "Control plane injoignable",
                    systemImage: client.connected ? "folder" : "wifi.slash",
                    description: Text(client.connected
                        ? "Créez un projet depuis le web ou la CLI : avity project create"
                        : "Démarrez le control plane : pnpm --filter @avityos/control-plane start")
                )
            }
        }
        .navigationTitle("Projets")
        .accessibilityIdentifier("screen.projects")
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "active": .green
        case "completed": .blue
        case "blocked": .red
        case "clarifying": .orange
        default: .secondary
        }
    }
}

struct MissionsView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        Table(client.missions) {
            TableColumn("Mission") { mission in Text(mission.title) }
            TableColumn("Rôle") { mission in Text(mission.role) }.width(110)
            TableColumn("État") { mission in Text(mission.state) }.width(130)
            TableColumn("Priorité") { mission in Text("\(mission.priority)") }.width(60)
        }
        .navigationTitle("Missions")
        .accessibilityIdentifier("screen.missions")
    }
}

struct InterventionsView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        List(client.approvals) { approval in
            VStack(alignment: .leading, spacing: 6) {
                Text(approval.title).font(.headline)
                Text(approval.description).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Approuver") {
                        Task { await client.resolveApproval(id: approval.id, decision: "approved") }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Rejeter", role: .destructive) {
                        Task { await client.resolveApproval(id: approval.id, decision: "rejected") }
                    }
                }
            }
            .padding(.vertical, 6)
        }
        .overlay {
            if client.approvals.isEmpty {
                ContentUnavailableView(
                    "Aucune intervention en attente",
                    systemImage: "checkmark.circle",
                    description: Text("Les agents poursuivent leur travail de manière autonome.")
                )
            }
        }
        .navigationTitle("Interventions")
        .accessibilityIdentifier("screen.interventions")
    }
}

struct RunsView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        Table(client.runs) {
            TableColumn("Run") { run in Text(run.id) }
            TableColumn("Modèle") { run in Text(run.model ?? "—") }.width(170)
            TableColumn("État") { run in Text(run.state) }.width(110)
            TableColumn("Coût") { run in Text(String(format: "$%.2f", run.costUsd)) }.width(70)
        }
        .navigationTitle("Exécutions")
        .accessibilityIdentifier("screen.runs")
    }
}

struct TerminalsView: View {
    @EnvironmentObject private var client: ApiClient
    @State private var selected: TerminalInfo?
    @State private var logs: [TerminalLog] = []

    var body: some View {
        HSplitView {
            List(client.terminals, selection: $selected) { terminal in
                VStack(alignment: .leading, spacing: 3) {
                    Text(terminal.command).font(.system(.caption, design: .monospaced)).lineLimit(1)
                    Text(terminal.state).font(.caption2).foregroundStyle(.secondary)
                }
                .tag(terminal)
            }
            .accessibilityIdentifier("screen.terminals")
            .frame(minWidth: 260)
            ScrollView {
                Text(logs.map(\.text).joined())
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding()
            }
            .background(Color.black.opacity(0.88))
            .foregroundStyle(Color.white.opacity(0.9))
        }
        .navigationTitle("Terminaux")
        .accessibilityIdentifier("screen.terminals")
        .task(id: selected?.id) {
            if let selected {
                logs = await client.terminalLogs(id: selected.id)
            } else {
                logs = []
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var client: ApiClient
    @State private var endpoint = ""
    @State private var token = ""
    @State private var relayURL = ""
    @State private var relayAdminToken = ""
    @State private var hostDeviceName = Host.current().localizedName ?? "Mac hôte"
    @State private var pairingSessionId = ""
    @State private var pairingBundle = ""
    @State private var pairingRequest = ""
    @State private var pairingBootstrap = ""
    @State private var remoteOperationInProgress = false
    @State private var remotePairingOffer = ""
    @State private var remoteDeviceName = Host.current().localizedName ?? "Mac distant"
    @State private var remoteDevicePairingRequest = ""
    @State private var remoteDeviceBootstrap = ""

    var body: some View {
        Form {
            Section("Control plane") {
                TextField("URL", text: $endpoint)
                    .accessibilityIdentifier("settings.endpoint")
                SecureField("Token API", text: $token)
                    .accessibilityIdentifier("settings.apiToken")
                HStack {
                    Button("Enregistrer") {
                        guard let url = URL(string: endpoint), !token.isEmpty else { return }
                        client.configure(baseURL: url, token: token)
                        token = ""
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("settings.save")
                    Button("Supprimer le token", role: .destructive) { client.clearCredentials() }
                }
                LabeledContent("État", value: client.tokenConfigured ? "Token protégé dans Keychain" : "Authentification requise")
            }
            Section("Pont distant — mode hôte") {
                if !client.remoteHostStatus.supported {
                    ContentUnavailableView(
                        "Mode hôte indisponible",
                        systemImage: "lock.slash",
                        description: Text(
                            "Le control-plane hôte doit fonctionner sur macOS avec Keychain."
                        )
                    )
                } else {
                    TextField("URL HTTPS du relais", text: $relayURL)
                    SecureField("Jeton administrateur du relais", text: $relayAdminToken)
                    TextField("Nom de cet appareil", text: $hostDeviceName)
                    HStack {
                        Button(client.remoteHostStatus.configured
                            ? "Mettre à jour"
                            : "Activer le mode hôte"
                        ) {
                            remoteOperationInProgress = true
                            Task {
                                await client.configureRemoteHost(
                                    relayURL: relayURL,
                                    relayAdminToken: relayAdminToken,
                                    deviceName: hostDeviceName
                                )
                                relayAdminToken = ""
                                remoteOperationInProgress = false
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(
                            remoteOperationInProgress ||
                            client.connectionMode == .remote ||
                            relayURL.isEmpty ||
                            relayAdminToken.isEmpty ||
                            hostDeviceName.isEmpty
                        )
                        if client.remoteHostStatus.configured {
                            LabeledContent(
                                "Connecteur",
                                value: remoteConnectorLabel
                            )
                        }
                    }

                    if client.remoteHostStatus.configured {
                        DisclosureGroup("Appairer un appareil") {
                            VStack(alignment: .leading, spacing: 8) {
                                Button("Créer une offre à usage unique") {
                                    remoteOperationInProgress = true
                                    Task {
                                        if let response = await client.createRemotePairing() {
                                            pairingSessionId = response.sessionId
                                            pairingBundle = response.pairingBundle
                                            pairingRequest = ""
                                            pairingBootstrap = ""
                                        }
                                        remoteOperationInProgress = false
                                    }
                                }
                                .disabled(remoteOperationInProgress)
                                .disabled(client.connectionMode == .remote)

                                if !pairingBundle.isEmpty {
                                    Text("1. Transférez cette offre par un canal hors bande.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    TextEditor(text: $pairingBundle)
                                        .font(.system(.caption, design: .monospaced))
                                        .frame(minHeight: 76)
                                    Button("Copier l’offre") {
                                        copyToPasteboard(pairingBundle)
                                    }

                                    Text("2. Collez la requête chiffrée produite par l’appareil.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    TextEditor(text: $pairingRequest)
                                        .font(.system(.caption, design: .monospaced))
                                        .frame(minHeight: 76)
                                    Button("Accepter et enrôler") {
                                        remoteOperationInProgress = true
                                        Task {
                                            if let response = await client.acceptRemotePairing(
                                                sessionId: pairingSessionId,
                                                request: pairingRequest
                                            ) {
                                                pairingBootstrap = response.bootstrap
                                            }
                                            remoteOperationInProgress = false
                                        }
                                    }
                                    .disabled(
                                        remoteOperationInProgress ||
                                        client.connectionMode == .remote ||
                                        pairingRequest.isEmpty
                                    )
                                }

                                if !pairingBootstrap.isEmpty {
                                    Text("3. Retournez ce bootstrap chiffré au nouvel appareil.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    TextEditor(text: $pairingBootstrap)
                                        .font(.system(.caption, design: .monospaced))
                                        .frame(minHeight: 76)
                                    Button("Copier le bootstrap") {
                                        copyToPasteboard(pairingBootstrap)
                                    }
                                }
                            }
                            .padding(.top, 6)
                        }

                        DisclosureGroup(
                            "Appareils (\(client.remoteHostStatus.devices.count))"
                        ) {
                            ForEach(client.remoteHostStatus.devices) { device in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(device.name)
                                        Text(device.deviceId)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(device.isHost ? "Hôte" : device.status)
                                        .font(.caption)
                                    if !device.isHost && device.status == "active" {
                                        Button("Révoquer", role: .destructive) {
                                            Task {
                                                await client.revokeRemoteDevice(
                                                    id: device.deviceId
                                                )
                                            }
                                        }
                                        .disabled(client.connectionMode == .remote)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Section("Cet appareil — mode distant") {
                if client.remoteDeviceStatus.configured {
                    LabeledContent(
                        "Appareil",
                        value: client.remoteDeviceStatus.deviceName ?? "—"
                    )
                    LabeledContent(
                        "Hôte",
                        value: client.remoteDeviceStatus.hostName ?? "—"
                    )
                    LabeledContent(
                        "Relais",
                        value: client.remoteDeviceStatus.relayURL ?? "—"
                    )
                    HStack {
                        if client.connectionMode == .local {
                            Button("Utiliser le relais chiffré") {
                                client.setConnectionMode(.remote)
                            }
                            .buttonStyle(.borderedProminent)
                        } else {
                            Button("Revenir au control plane local") {
                                client.setConnectionMode(.local)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        Button("Oublier cet appareil", role: .destructive) {
                            client.clearRemoteDevice()
                            remoteDevicePairingRequest = ""
                            remoteDeviceBootstrap = ""
                        }
                    }
                } else {
                    Text(
                        "Collez l’offre créée sur le Mac hôte. L’identité privée "
                        + "et le secret temporaire seront protégés dans Keychain."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    TextField("Nom de cet appareil", text: $remoteDeviceName)
                    TextEditor(text: $remotePairingOffer)
                        .font(.system(.caption, design: .monospaced))
                        .frame(minHeight: 76)
                    Button("Créer la requête chiffrée") {
                        if let request = client.beginRemoteDevicePairing(
                            bundle: remotePairingOffer,
                            deviceName: remoteDeviceName
                        ) {
                            remoteDevicePairingRequest = request
                        }
                    }
                    .disabled(
                        remotePairingOffer.isEmpty || remoteDeviceName.isEmpty
                    )

                    if !remoteDevicePairingRequest.isEmpty {
                        Text(
                            "Retournez cette requête au Mac hôte, puis collez "
                            + "son bootstrap chiffré ci-dessous."
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        TextEditor(text: $remoteDevicePairingRequest)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 76)
                        Button("Copier la requête") {
                            copyToPasteboard(remoteDevicePairingRequest)
                        }
                        TextEditor(text: $remoteDeviceBootstrap)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 76)
                        Button("Ouvrir le bootstrap et terminer") {
                            client.completeRemoteDevicePairing(
                                bootstrap: remoteDeviceBootstrap
                            )
                            if client.remoteDeviceStatus.configured {
                                remotePairingOffer = ""
                                remoteDevicePairingRequest = ""
                                remoteDeviceBootstrap = ""
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(remoteDeviceBootstrap.isEmpty)
                    }
                }
            }
            if let error = client.lastError {
                Section("Dernière erreur") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            if let error = client.remoteHostError {
                Section("Erreur du pont distant") {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
            if let error = client.remoteDeviceError {
                Section("Erreur du mode distant") {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Réglages")
        .accessibilityIdentifier("screen.settings")
        .onAppear {
            endpoint = client.baseURL.absoluteString
            relayURL = client.remoteHostStatus.relayUrl ?? relayURL
            remoteDevicePairingRequest =
                client.pendingRemoteDevicePairingRequest() ?? ""
        }
        .onChange(of: client.remoteHostStatus.relayUrl) { _, value in
            if let value { relayURL = value }
        }
    }

    private var remoteConnectorLabel: String {
        switch client.remoteHostStatus.connectorState {
        case "online": "En ligne"
        case "connecting": "Connexion…"
        case "degraded": "Dégradé"
        case "stopped": "Arrêté"
        default: client.remoteHostStatus.connectorState
        }
    }

    private func copyToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

struct MenuBarView: View {
    @EnvironmentObject private var client: ApiClient
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(client.connected
            ? "\(client.connectionMode == .remote ? "Relais chiffré" : "Local") (v\(client.version))"
            : "Hors ligne"
        )
        Text("\(client.projects.count) projet(s) · \(client.approvals.count) intervention(s)")
        Divider()
        Button("Ouvrir AvityOS") {
            NSApplication.shared.activate(ignoringOtherApps: true)
            openWindow(id: "main")
        }
        Button("Rafraîchir") { Task { await client.refresh() } }
        Button("Quitter AvityOS") { NSApplication.shared.terminate(nil) }
    }
}
