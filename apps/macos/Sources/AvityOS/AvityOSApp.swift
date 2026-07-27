import SwiftUI
import AppKit
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
            CommandGroup(replacing: .appSettings) {
                Button("Réglages…") { NativeAppSettings.open() }
                    .keyboardShortcut(",", modifiers: .command)
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

enum NativeAppSettings {
    @MainActor
    static func open() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }
}

struct ContentView: View {
    @EnvironmentObject private var client: ApiClient

    var body: some View {
        if AppRuntime.isUITesting {
            UITestShellView()
        } else {
            FigmaMissionControlShell()
        }
    }
}

struct FigmaMissionControlShell: View {
    @EnvironmentObject private var client: ApiClient
    @State private var pendingRoute: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("AvityOS")
                    .font(.headline)
                Text("Mission Control")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Circle()
                    .fill(client.connected ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(connectionLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("connection.status")
                Button("Réglages") {
                    NativeAppSettings.open()
                }
                .accessibilityIdentifier("toolbar.native-settings")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)

            MissionControlWebView(
                client: client,
                pendingRoute: pendingRoute,
                onOpenNativeSettings: { NativeAppSettings.open() },
                onRouteConsumed: { pendingRoute = nil }
            )
        }
        .accessibilityIdentifier("screen.mission-control")
        .background(Color(red: 0.969, green: 0.957, blue: 0.933))
        .onOpenURL { url in
            let host = url.host ?? "mission-control"
            if host == "settings" {
                NativeAppSettings.open()
                pendingRoute = "settings"
            } else {
                pendingRoute = host
            }
        }
        .frame(minWidth: 1100, minHeight: 720)
    }

    private var connectionLabel: String {
        guard client.connected else { return "Hors ligne — reconnexion…" }
        if client.connectionMode == .remote {
            return "Relais chiffré · Control plane v\(client.version)"
        }
        return "Control plane local v\(client.version)"
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
                    LabeledContent(
                        "Certificat appareil",
                        value:
                            client.remoteDeviceStatus
                                .deviceCertificateValidUntil ?? "—"
                    )
                    LabeledContent(
                        "Certificat hôte",
                        value:
                            client.remoteDeviceStatus
                                .hostCertificateValidUntil ?? "—"
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
                        Button("Vérifier / renouveler") {
                            Task {
                                await client.renewRemoteDeviceCertificates()
                            }
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
