import SwiftUI

/// Deterministic native shell used only when `AVITY_UI_TEST_MODE=1`.
/// Production builds embed the Figma Mission Control WebUI instead.
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

struct UITestShellView: View {
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
