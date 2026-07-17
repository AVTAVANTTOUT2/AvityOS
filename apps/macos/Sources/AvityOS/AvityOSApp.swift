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
                    NotificationCoordinator.requestAuthorization()
                    client.startPolling()
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
                        Text(client.connected ? "Control plane v\(client.version)" : "Hors ligne — reconnexion…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
                    Text(terminal.command.joined(separator: " ")).font(.system(.caption, design: .monospaced)).lineLimit(1)
                    Text(terminal.state).font(.caption2).foregroundStyle(.secondary)
                }
                .tag(terminal)
            }
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

    var body: some View {
        Form {
            Section("Control plane") {
                TextField("URL", text: $endpoint)
                SecureField("Token API", text: $token)
                HStack {
                    Button("Enregistrer") {
                        guard let url = URL(string: endpoint), !token.isEmpty else { return }
                        client.configure(baseURL: url, token: token)
                        token = ""
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Supprimer le token", role: .destructive) { client.clearCredentials() }
                }
                LabeledContent("État", value: client.tokenConfigured ? "Token protégé dans Keychain" : "Authentification requise")
            }
            if let error = client.lastError {
                Section("Dernière erreur") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Réglages")
        .onAppear { endpoint = client.baseURL.absoluteString }
    }
}

struct MenuBarView: View {
    @EnvironmentObject private var client: ApiClient
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(client.connected ? "Connecté (v\(client.version))" : "Hors ligne")
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
