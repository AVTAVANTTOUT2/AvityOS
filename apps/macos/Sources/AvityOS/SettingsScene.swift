import AppKit
import SwiftUI

/// Native settings for credentials and the remote bridge.
///
/// The previous screen stacked every concern into one long grouped `Form`:
/// control-plane credentials, host-mode enrolment, this device's pairing and
/// three error sections all scrolled past each other, and the pairing exchanges
/// hid inside disclosure groups. Each concern is now its own destination, so a
/// pairing exchange is never interleaved with unrelated fields, and failures
/// have a dedicated place instead of trailing off the bottom.
struct SettingsView: View {
    @EnvironmentObject private var client: ApiClient
    @State private var section: SettingsSection? = .controlPlane

    var body: some View {
        NavigationSplitView {
            List(SettingsSection.allCases, selection: $section) { item in
                Label(item.title, systemImage: item.symbol)
                    .badge(badge(for: item))
                    .tag(item)
            }
            .navigationSplitViewColumnWidth(min: 196, ideal: 208, max: 240)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: GlassMetrics.stackSpacing) {
                    switch section ?? .controlPlane {
                    case .controlPlane: ControlPlaneSettings()
                    case .host: RemoteHostSettings()
                    case .device: RemoteDeviceSettings()
                    case .diagnostics: DiagnosticsSettings()
                    }
                }
                .padding(GlassMetrics.gutter)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(section?.title ?? "Réglages")
        }
        .frame(minWidth: 720, minHeight: 480)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("screen.settings")
    }

    /// Surfaces the two states an operator must not miss from the sidebar:
    /// a missing token, and anything that failed.
    private func badge(for item: SettingsSection) -> Int {
        switch item {
        case .controlPlane: client.tokenConfigured ? 0 : 1
        case .diagnostics: failureCount
        default: 0
        }
    }

    private var failureCount: Int {
        [client.lastError, client.remoteHostError, client.remoteDeviceError]
            .compactMap { $0 }
            .count
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case controlPlane
    case host
    case device
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .controlPlane: "Control plane"
        case .host: "Pont distant — hôte"
        case .device: "Cet appareil"
        case .diagnostics: "Diagnostics"
        }
    }

    var symbol: String {
        switch self {
        case .controlPlane: "server.rack"
        case .host: "antenna.radiowaves.left.and.right"
        case .device: "laptopcomputer"
        case .diagnostics: "stethoscope"
        }
    }
}

// MARK: - Control plane

private struct ControlPlaneSettings: View {
    @EnvironmentObject private var client: ApiClient
    @State private var endpoint = ""
    @State private var token = ""

    var body: some View {
        GlassCard(
            "Connexion",
            systemImage: "server.rack",
            footnote: "Le token n’est jamais écrit dans les préférences ni dans "
                + "le stockage web : il est scellé dans le Keychain et injecté "
                + "par le proxy natif."
        ) {
            LabeledContent("URL") {
                TextField("https://…", text: $endpoint)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("settings.endpoint")
            }
            LabeledContent("Token API") {
                SecureField("Jeton", text: $token)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("settings.apiToken")
            }
            HStack {
                Button("Enregistrer") {
                    guard let url = URL(string: endpoint), !token.isEmpty else { return }
                    client.configure(baseURL: url, token: token)
                    token = ""
                }
                .buttonStyle(.glassProminent)
                .disabled(endpoint.isEmpty || token.isEmpty)
                .accessibilityIdentifier("settings.save")

                Button("Supprimer le token", role: .destructive) {
                    client.clearCredentials()
                }
                .buttonStyle(.glass)
                .disabled(!client.tokenConfigured)
            }
        }

        GlassCard("État", systemImage: "checkmark.seal") {
            let tone = ConnectionTone(
                connected: client.connected,
                isRelay: client.connectionMode == .remote
            )
            HStack(spacing: GlassMetrics.stackSpacing) {
                ConnectionBadge(tone: tone, detail: tone.shortLabel)
                Spacer()
                Button("Rafraîchir") { Task { await client.refresh() } }
                    .buttonStyle(.glass)
            }
            LabeledContent(
                "Authentification",
                value: client.tokenConfigured
                    ? "Token protégé dans Keychain"
                    : "Authentification requise"
            )
            LabeledContent("Version", value: client.connected ? client.version : "—")
        }
        .onAppear { endpoint = client.baseURL.absoluteString }
    }
}

// MARK: - Remote host mode

private struct RemoteHostSettings: View {
    @EnvironmentObject private var client: ApiClient
    @State private var relayURL = ""
    @State private var relayAdminToken = ""
    @State private var deviceName = Host.current().localizedName ?? "Mac hôte"
    @State private var busy = false
    @State private var pairingSessionId = ""
    @State private var pairingBundle = ""
    @State private var pairingRequest = ""
    @State private var pairingBootstrap = ""

    private var isRelayActive: Bool { client.connectionMode == .remote }

    var body: some View {
        if !client.remoteHostStatus.supported {
            GlassCard("Mode hôte indisponible", systemImage: "lock.slash") {
                Text("Le control plane hôte doit fonctionner sur macOS avec Keychain.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        } else {
            GlassCard(
                "Relais",
                systemImage: "antenna.radiowaves.left.and.right",
                footnote: "Le jeton administrateur n’est utilisé que pour "
                    + "l’enrôlement et n’est pas conservé dans ce formulaire."
            ) {
                LabeledContent("URL HTTPS") {
                    TextField("https://…", text: $relayURL)
                        .textFieldStyle(.roundedBorder)
                }
                LabeledContent("Jeton administrateur") {
                    SecureField("Jeton", text: $relayAdminToken)
                        .textFieldStyle(.roundedBorder)
                }
                LabeledContent("Nom de cet appareil") {
                    TextField("Mac hôte", text: $deviceName)
                        .textFieldStyle(.roundedBorder)
                }
                HStack {
                    Button(
                        client.remoteHostStatus.configured
                            ? "Mettre à jour"
                            : "Activer le mode hôte"
                    ) {
                        busy = true
                        Task {
                            await client.configureRemoteHost(
                                relayURL: relayURL,
                                relayAdminToken: relayAdminToken,
                                deviceName: deviceName
                            )
                            relayAdminToken = ""
                            busy = false
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(
                        busy || isRelayActive || relayURL.isEmpty
                            || relayAdminToken.isEmpty || deviceName.isEmpty
                    )
                    if client.remoteHostStatus.configured {
                        Spacer()
                        LabeledContent("Connecteur", value: connectorLabel)
                    }
                }
                if isRelayActive {
                    Text("Indisponible tant que cet appareil passe par le relais chiffré.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            // The relay URL is owned by the host status; the field mirrors it so
            // an operator never retypes an address the client already knows.
            .onAppear { relayURL = client.remoteHostStatus.relayUrl ?? relayURL }
            .onChange(of: client.remoteHostStatus.relayUrl) { _, value in
                if let value { relayURL = value }
            }

            if client.remoteHostStatus.configured {
                pairingCard
                devicesCard
            }
        }
    }

    private var pairingCard: some View {
        GlassCard(
            "Appairer un appareil",
            systemImage: "person.badge.key",
            footnote: "Trois échanges hors bande. Rien de secret ne transite "
                + "par le relais en clair."
        ) {
            Button("Créer une offre à usage unique") {
                busy = true
                Task {
                    if let response = await client.createRemotePairing() {
                        pairingSessionId = response.sessionId
                        pairingBundle = response.pairingBundle
                        pairingRequest = ""
                        pairingBootstrap = ""
                    }
                    busy = false
                }
            }
            .buttonStyle(.glass)
            .disabled(busy || isRelayActive)

            if !pairingBundle.isEmpty {
                PairingStep(
                    index: 1,
                    instruction: "Transmettez cette offre par un canal hors bande.",
                    payload: $pairingBundle,
                    isOutbound: true
                ) {
                    Button("Copier l’offre") { Pasteboard.copy(pairingBundle) }
                        .buttonStyle(.glass)
                }

                PairingStep(
                    index: 2,
                    instruction: "Collez la requête chiffrée produite par l’appareil.",
                    payload: $pairingRequest,
                    isOutbound: false
                ) {
                    Button("Accepter et enrôler") {
                        busy = true
                        Task {
                            if let response = await client.acceptRemotePairing(
                                sessionId: pairingSessionId,
                                request: pairingRequest
                            ) {
                                pairingBootstrap = response.bootstrap
                            }
                            busy = false
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(busy || isRelayActive || pairingRequest.isEmpty)
                }
            }

            if !pairingBootstrap.isEmpty {
                PairingStep(
                    index: 3,
                    instruction: "Retournez ce bootstrap chiffré au nouvel appareil.",
                    payload: $pairingBootstrap,
                    isOutbound: true
                ) {
                    Button("Copier le bootstrap") { Pasteboard.copy(pairingBootstrap) }
                        .buttonStyle(.glass)
                }
            }
        }
    }

    private var devicesCard: some View {
        GlassCard(
            "Appareils (\(client.remoteHostStatus.devices.count))",
            systemImage: "laptopcomputer.and.iphone"
        ) {
            if client.remoteHostStatus.devices.isEmpty {
                Text("Aucun appareil enrôlé.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(client.remoteHostStatus.devices) { device in
                HStack(spacing: GlassMetrics.stackSpacing) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                        Text(device.deviceId)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Text(device.isHost ? "Hôte" : device.status)
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .glassEffect(.clear, in: .capsule)
                    if !device.isHost && device.status == "active" {
                        Button("Révoquer", role: .destructive) {
                            Task { await client.revokeRemoteDevice(id: device.deviceId) }
                        }
                        .buttonStyle(.glass)
                        .disabled(isRelayActive)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private var connectorLabel: String {
        switch client.remoteHostStatus.connectorState {
        case "online": "En ligne"
        case "connecting": "Connexion…"
        case "degraded": "Dégradé"
        case "stopped": "Arrêté"
        default: client.remoteHostStatus.connectorState
        }
    }
}

// MARK: - This device

private struct RemoteDeviceSettings: View {
    @EnvironmentObject private var client: ApiClient
    @State private var pairingOffer = ""
    @State private var deviceName = Host.current().localizedName ?? "Mac distant"
    @State private var pairingRequest = ""
    @State private var bootstrap = ""

    var body: some View {
        if client.remoteDeviceStatus.configured {
            enrolledCards
        } else {
            enrolmentCard
        }
    }

    @ViewBuilder
    private var enrolledCards: some View {
        GlassCard("Identité", systemImage: "laptopcomputer") {
            LabeledContent("Appareil", value: client.remoteDeviceStatus.deviceName ?? "—")
            LabeledContent("Hôte", value: client.remoteDeviceStatus.hostName ?? "—")
            LabeledContent("Relais", value: client.remoteDeviceStatus.relayURL ?? "—")
        }

        GlassCard(
            "Certificats",
            systemImage: "checkmark.shield",
            footnote: "Renouvelés automatiquement 30 jours avant expiration, "
                + "sans rotation d’identité ni du bearer."
        ) {
            LabeledContent(
                "Appareil",
                value: client.remoteDeviceStatus.deviceCertificateValidUntil ?? "—"
            )
            LabeledContent(
                "Hôte",
                value: client.remoteDeviceStatus.hostCertificateValidUntil ?? "—"
            )
            Button("Vérifier / renouveler") {
                Task { await client.renewRemoteDeviceCertificates() }
            }
            .buttonStyle(.glass)
        }

        GlassCard("Transport", systemImage: "arrow.left.arrow.right") {
            HStack {
                if client.connectionMode == .local {
                    Button("Utiliser le relais chiffré") {
                        client.setConnectionMode(.remote)
                    }
                    .buttonStyle(.glassProminent)
                } else {
                    Button("Revenir au control plane local") {
                        client.setConnectionMode(.local)
                    }
                    .buttonStyle(.glassProminent)
                }
                Spacer()
                Button("Oublier cet appareil", role: .destructive) {
                    client.clearRemoteDevice()
                    pairingRequest = ""
                    bootstrap = ""
                }
                .buttonStyle(.glass)
            }
        }
    }

    private var enrolmentCard: some View {
        GlassCard(
            "Appairage",
            systemImage: "person.badge.key",
            footnote: "L’identité privée et le secret temporaire sont scellés "
                + "dans le Keychain de cet appareil."
        ) {
            LabeledContent("Nom de cet appareil") {
                TextField("Mac distant", text: $deviceName)
                    .textFieldStyle(.roundedBorder)
            }

            PairingStep(
                index: 1,
                instruction: "Collez l’offre créée sur le Mac hôte.",
                payload: $pairingOffer,
                isOutbound: false
            ) {
                Button("Créer la requête chiffrée") {
                    if let request = client.beginRemoteDevicePairing(
                        bundle: pairingOffer,
                        deviceName: deviceName
                    ) {
                        pairingRequest = request
                    }
                }
                .buttonStyle(.glassProminent)
                .disabled(pairingOffer.isEmpty || deviceName.isEmpty)
            }

            if !pairingRequest.isEmpty {
                PairingStep(
                    index: 2,
                    instruction: "Retournez cette requête au Mac hôte.",
                    payload: $pairingRequest,
                    isOutbound: true
                ) {
                    Button("Copier la requête") { Pasteboard.copy(pairingRequest) }
                        .buttonStyle(.glass)
                }

                PairingStep(
                    index: 3,
                    instruction: "Collez le bootstrap chiffré renvoyé par l’hôte.",
                    payload: $bootstrap,
                    isOutbound: false
                ) {
                    Button("Ouvrir le bootstrap et terminer") {
                        client.completeRemoteDevicePairing(bootstrap: bootstrap)
                        if client.remoteDeviceStatus.configured {
                            pairingOffer = ""
                            pairingRequest = ""
                            bootstrap = ""
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(bootstrap.isEmpty)
                }
            }
        }
        .onAppear {
            pairingRequest = client.pendingRemoteDevicePairingRequest() ?? pairingRequest
        }
    }
}

// MARK: - Diagnostics

private struct Diagnostic: Identifiable {
    let id: String
    let message: String
}

private struct DiagnosticsSettings: View {
    @EnvironmentObject private var client: ApiClient

    private var failures: [Diagnostic] {
        var collected: [Diagnostic] = []
        if let message = client.lastError {
            collected.append(Diagnostic(id: "Dernière erreur", message: message))
        }
        if let message = client.remoteHostError {
            collected.append(Diagnostic(id: "Pont distant", message: message))
        }
        if let message = client.remoteDeviceError {
            collected.append(Diagnostic(id: "Mode distant", message: message))
        }
        return collected
    }

    var body: some View {
        if failures.isEmpty {
            GlassCard("Aucune erreur", systemImage: "checkmark.circle") {
                Text("Le client n’a signalé aucune défaillance depuis son démarrage.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(failures) { failure in
                DiagnosticRow(title: failure.id, message: failure.message)
            }
        }
    }
}
