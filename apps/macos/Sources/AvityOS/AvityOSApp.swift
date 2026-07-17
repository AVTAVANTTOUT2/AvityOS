import SwiftUI

@main
struct AvityOSApp: App {
    @StateObject private var client = ApiClient()

    var body: some Scene {
        WindowGroup("AvityOS") {
            ContentView()
                .environmentObject(client)
                .onAppear { client.startPolling() }
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
    }
}

enum SidebarItem: String, CaseIterable, Identifiable {
    case projects = "Projets"
    case missions = "Missions"
    case interventions = "Interventions"
    case runs = "Exécutions"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .projects: "folder"
        case .missions: "list.bullet.rectangle"
        case .interventions: "tray.full"
        case .runs: "terminal"
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

struct MenuBarView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        Text(client.connected ? "Connecté (v\(client.version))" : "Hors ligne")
        Text("\(client.projects.count) projet(s) · \(client.approvals.count) intervention(s)")
        Divider()
        Button("Rafraîchir") { Task { await client.refresh() } }
        Button("Quitter AvityOS") { NSApplication.shared.terminate(nil) }
    }
}
