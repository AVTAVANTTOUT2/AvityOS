import AppKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var client: ApiClient
    @State private var selection: SettingsDestination? = .controlPlane
    @State private var endpoint = ""
    @State private var token = ""
    @State private var relayURL = ""
    @State private var relayAdminToken = ""
    @State private var hostDeviceName =
        Host.current().localizedName ?? "Mac hôte"
    @State private var pairingSessionId = ""
    @State private var pairingBundle = ""
    @State private var pairingRequest = ""
    @State private var pairingBootstrap = ""
    @State private var remoteOperationInProgress = false
    @State private var remotePairingOffer = ""
    @State private var remoteDeviceName =
        Host.current().localizedName ?? "Mac distant"
    @State private var remoteDevicePairingRequest = ""
    @State private var remoteDeviceBootstrap = ""

    var body: some View {
        NavigationSplitView {
            List(SettingsDestination.allCases, selection: $selection) {
                destination in
                Label(destination.title, systemImage: destination.systemImage)
                    .tag(destination)
            }
            .navigationTitle("AvityOS")
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 240)
            .safeAreaInset(edge: .bottom) {
                SidebarConnectionSummary(
                    connected: client.connected,
                    mode: client.connectionMode,
                    version: client.version
                )
                .padding(12)
            }
        } detail: {
            SettingsDetailBackdrop {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        SettingsPageHeader(
                            destination: selection ?? .controlPlane
                        )

                        switch selection ?? .controlPlane {
                        case .controlPlane:
                            controlPlanePane
                        case .remoteHost:
                            remoteHostPane
                        case .remoteDevice:
                            remoteDevicePane
                        case .diagnostics:
                            diagnosticsPane
                        }
                    }
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(.horizontal, 30)
                    .padding(.vertical, 26)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .navigationTitle((selection ?? .controlPlane).title)
        }
        .accessibilityElement(children: .contain)
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

    private var controlPlanePane: some View {
        VStack(alignment: .leading, spacing: 18) {
            ConnectionHero(
                connected: client.connected,
                tokenConfigured: client.tokenConfigured,
                mode: client.connectionMode,
                endpoint: client.baseURL,
                version: client.version
            )

            SettingsCard(
                title: "Connexion",
                subtitle: "Les identifiants restent chiffrés dans le Trousseau.",
                systemImage: "key.fill"
            ) {
                VStack(alignment: .leading, spacing: 14) {
                    LabeledField("URL du control plane") {
                        TextField(
                            "http://127.0.0.1:7717",
                            text: $endpoint
                        )
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("settings.endpoint")
                    }

                    LabeledField("Token API") {
                        SecureField("Token conservé dans Keychain", text: $token)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("settings.apiToken")
                    }

                    if !endpoint.isEmpty && validatedEndpoint == nil {
                        Label(
                            "Utilisez une URL HTTP ou HTTPS complète, sans identifiants ni paramètres.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }

                    Divider()

                    HStack(spacing: 10) {
                        Button {
                            guard let validatedEndpoint, !token.isEmpty else {
                                return
                            }
                            client.configure(
                                baseURL: validatedEndpoint,
                                token: token
                            )
                            token = ""
                        } label: {
                            Label(
                                client.tokenConfigured
                                    ? "Mettre à jour"
                                    : "Enregistrer",
                                systemImage: "checkmark"
                            )
                        }
                        .buttonStyle(.glassProminent)
                        .tint(.indigo)
                        .disabled(validatedEndpoint == nil || token.isEmpty)
                        .accessibilityIdentifier("settings.save")

                        Button(role: .destructive) {
                            client.clearCredentials()
                        } label: {
                            Label(
                                "Supprimer le token",
                                systemImage: "trash"
                            )
                        }
                        .buttonStyle(.glass)
                        .disabled(!client.tokenConfigured)

                        Spacer()

                        Label(
                            client.tokenConfigured
                                ? "Protégé dans Keychain"
                                : "Authentification requise",
                            systemImage: client.tokenConfigured
                                ? "lock.fill"
                                : "lock.open"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }

            SettingsCard(
                title: "Mode actif",
                subtitle: "Choisissez le chemin réseau utilisé par Mission Control.",
                systemImage: "point.3.connected.trianglepath.dotted"
            ) {
                Picker("Mode de connexion", selection: connectionModeBinding) {
                    Label("Local", systemImage: "desktopcomputer")
                        .tag(ConnectionMode.local)
                    Label("Relais chiffré", systemImage: "lock.icloud")
                        .tag(ConnectionMode.remote)
                }
                .pickerStyle(.segmented)
                .disabled(!client.remoteDeviceStatus.configured)

                if !client.remoteDeviceStatus.configured {
                    Text(
                        "Le mode relais sera disponible après l’appairage de cet appareil."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                }
            }
        }
    }

    private var remoteHostPane: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !client.remoteHostStatus.supported {
                SettingsCard(
                    title: "Mode hôte indisponible",
                    subtitle: "Le control plane hôte doit fonctionner sur macOS avec Keychain.",
                    systemImage: "lock.slash"
                ) {
                    Text(
                        "Connectez-vous d’abord au control plane local pour activer cette fonction."
                    )
                    .foregroundStyle(.secondary)
                }
            } else {
                SettingsCard(
                    title: client.remoteHostStatus.configured
                        ? "Hôte distant actif"
                        : "Configurer ce Mac comme hôte",
                    subtitle: "Le relais ne voit que des commandes chiffrées de bout en bout.",
                    systemImage: "network.badge.shield.half.filled"
                ) {
                    VStack(alignment: .leading, spacing: 14) {
                        if client.remoteHostStatus.configured {
                            HStack {
                                StatusBadge(
                                    label: remoteConnectorLabel,
                                    color: remoteConnectorColor,
                                    systemImage: "antenna.radiowaves.left.and.right"
                                )
                                Spacer()
                                Text(client.remoteHostStatus.relayUrl ?? "—")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            Divider()
                        }

                        LabeledField("URL HTTPS du relais") {
                            TextField(
                                "https://relay.example.com",
                                text: $relayURL
                            )
                            .textFieldStyle(.roundedBorder)
                        }

                        LabeledField("Jeton administrateur du relais") {
                            SecureField(
                                "Requis pour activer ou mettre à jour",
                                text: $relayAdminToken
                            )
                            .textFieldStyle(.roundedBorder)
                        }

                        LabeledField("Nom de ce Mac") {
                            TextField("Mac hôte", text: $hostDeviceName)
                                .textFieldStyle(.roundedBorder)
                        }

                        HStack {
                            Button {
                                configureRemoteHost()
                            } label: {
                                if remoteOperationInProgress {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Label(
                                        client.remoteHostStatus.configured
                                            ? "Mettre à jour"
                                            : "Activer le mode hôte",
                                        systemImage: "checkmark.shield"
                                    )
                                }
                            }
                            .buttonStyle(.glassProminent)
                            .tint(.indigo)
                            .disabled(!canConfigureRemoteHost)

                            if client.connectionMode == .remote {
                                Text(
                                    "Revenez en mode local pour administrer l’hôte."
                                )
                                .font(.caption)
                                .foregroundStyle(.orange)
                            }
                        }
                    }
                }

                if client.remoteHostStatus.configured {
                    pairingHostCard
                    hostDevicesCard
                }
            }
        }
    }

    private var pairingHostCard: some View {
        SettingsCard(
            title: "Appairer un appareil",
            subtitle: pairingBundle.isEmpty
                ? "Créez une offre à usage unique pour commencer."
                : "Suivez les trois étapes sans quitter cet écran.",
            systemImage: "link.badge.plus"
        ) {
            VStack(alignment: .leading, spacing: 16) {
                PairingStep(
                    number: 1,
                    title: "Créer et transférer l’offre",
                    isComplete: !pairingBundle.isEmpty
                ) {
                    Button {
                        createRemotePairing()
                    } label: {
                        Label(
                            pairingBundle.isEmpty
                                ? "Créer une offre"
                                : "Créer une nouvelle offre",
                            systemImage: "sparkles"
                        )
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.indigo)
                    .disabled(
                        remoteOperationInProgress
                            || client.connectionMode == .remote
                    )

                    if !pairingBundle.isEmpty {
                        SecurePayloadEditor(
                            value: $pairingBundle,
                            accessibilityLabel: "Offre d’appairage"
                        )
                        CopyButton(label: "Copier l’offre") {
                            copyToPasteboard(pairingBundle)
                        }
                    }
                }

                PairingStep(
                    number: 2,
                    title: "Accepter la requête chiffrée",
                    isComplete: !pairingBootstrap.isEmpty
                ) {
                    if pairingBundle.isEmpty {
                        Text("Créez d’abord une offre à usage unique.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    } else {
                        SecurePayloadEditor(
                            value: $pairingRequest,
                            accessibilityLabel: "Requête chiffrée distante",
                            prompt: "Collez ici la requête créée par l’appareil"
                        )
                        Button {
                            acceptRemotePairing()
                        } label: {
                            Label(
                                "Accepter et enrôler",
                                systemImage: "person.badge.shield.checkmark"
                            )
                        }
                        .buttonStyle(.glass)
                        .disabled(
                            remoteOperationInProgress
                                || client.connectionMode == .remote
                                || pairingRequest.isEmpty
                        )
                    }
                }

                PairingStep(
                    number: 3,
                    title: "Renvoyer le bootstrap",
                    isComplete: !pairingBootstrap.isEmpty
                ) {
                    if pairingBootstrap.isEmpty {
                        Text(
                            "Le bootstrap apparaîtra après validation de la requête."
                        )
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    } else {
                        SecurePayloadEditor(
                            value: $pairingBootstrap,
                            accessibilityLabel: "Bootstrap chiffré"
                        )
                        CopyButton(label: "Copier le bootstrap") {
                            copyToPasteboard(pairingBootstrap)
                        }
                    }
                }
            }
        }
    }

    private var hostDevicesCard: some View {
        SettingsCard(
            title: "Appareils autorisés",
            subtitle: "\(client.remoteHostStatus.devices.count) appareil(s) associé(s) à cet hôte.",
            systemImage: "laptopcomputer.and.iphone"
        ) {
            if client.remoteHostStatus.devices.isEmpty {
                Text("Aucun appareil n’est encore appairé.")
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(
                        Array(client.remoteHostStatus.devices.enumerated()),
                        id: \.element.id
                    ) { index, device in
                        HStack(spacing: 12) {
                            Image(
                                systemName: device.isHost
                                    ? "desktopcomputer"
                                    : "laptopcomputer"
                            )
                            .frame(width: 24)
                            .foregroundStyle(.indigo)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.name)
                                    .font(.body.weight(.medium))
                                Text(device.deviceId)
                                    .font(
                                        .system(
                                            .caption2,
                                            design: .monospaced
                                        )
                                    )
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }

                            Spacer()

                            StatusBadge(
                                label: device.isHost
                                    ? "Hôte"
                                    : localizedDeviceStatus(device.status),
                                color: device.status == "active"
                                    ? .green
                                    : .secondary,
                                systemImage: device.status == "active"
                                    ? "checkmark.circle.fill"
                                    : "circle"
                            )

                            if !device.isHost && device.status == "active" {
                                Button(role: .destructive) {
                                    Task {
                                        await client.revokeRemoteDevice(
                                            id: device.deviceId
                                        )
                                    }
                                } label: {
                                    Label(
                                        "Révoquer",
                                        systemImage: "person.crop.circle.badge.minus"
                                    )
                                }
                                .buttonStyle(.glass)
                                .disabled(client.connectionMode == .remote)
                            }
                        }
                        .padding(.vertical, 12)

                        if index < client.remoteHostStatus.devices.count - 1 {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    private var remoteDevicePane: some View {
        VStack(alignment: .leading, spacing: 18) {
            if client.remoteDeviceStatus.configured {
                SettingsCard(
                    title: "Appareil appairé",
                    subtitle: "Cette identité et ses certificats sont protégés dans Keychain.",
                    systemImage: "checkmark.shield.fill"
                ) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            StatusBadge(
                                label: client.connectionMode == .remote
                                    ? "Relais utilisé"
                                    : "Prêt",
                                color: .green,
                                systemImage: "lock.fill"
                            )
                            Spacer()
                            Text(
                                client.remoteDeviceStatus.deviceName
                                    ?? "Appareil distant"
                            )
                            .font(.headline)
                        }

                        Divider()

                        DetailRow(
                            label: "Hôte",
                            value: client.remoteDeviceStatus.hostName ?? "—",
                            systemImage: "desktopcomputer"
                        )
                        DetailRow(
                            label: "Relais",
                            value: client.remoteDeviceStatus.relayURL ?? "—",
                            systemImage: "network"
                        )
                        DetailRow(
                            label: "Certificat appareil",
                            value: client.remoteDeviceStatus
                                .deviceCertificateValidUntil ?? "—",
                            systemImage: "checkmark.seal"
                        )
                        DetailRow(
                            label: "Certificat hôte",
                            value: client.remoteDeviceStatus
                                .hostCertificateValidUntil ?? "—",
                            systemImage: "checkmark.seal"
                        )

                        Divider()

                        GlassEffectContainer(spacing: 10) {
                            HStack(spacing: 10) {
                                Button {
                                    let nextMode: ConnectionMode =
                                        client.connectionMode == .local
                                        ? .remote
                                        : .local
                                    client.setConnectionMode(nextMode)
                                } label: {
                                    Label(
                                        client.connectionMode == .local
                                            ? "Utiliser le relais"
                                            : "Revenir en local",
                                        systemImage: client.connectionMode
                                            == .local
                                            ? "lock.icloud"
                                            : "desktopcomputer"
                                    )
                                }
                                .buttonStyle(.glassProminent)
                                .tint(.indigo)

                                Button {
                                    Task {
                                        await client
                                            .renewRemoteDeviceCertificates()
                                    }
                                } label: {
                                    Label(
                                        "Vérifier les certificats",
                                        systemImage: "arrow.triangle.2.circlepath"
                                    )
                                }
                                .buttonStyle(.glass)

                                Button(role: .destructive) {
                                    client.clearRemoteDevice()
                                    remoteDevicePairingRequest = ""
                                    remoteDeviceBootstrap = ""
                                } label: {
                                    Label(
                                        "Oublier",
                                        systemImage: "trash"
                                    )
                                }
                                .buttonStyle(.glass)
                            }
                        }
                    }
                }
            } else {
                remoteDevicePairingCard
            }
        }
    }

    private var remoteDevicePairingCard: some View {
        SettingsCard(
            title: "Appairer ce Mac",
            subtitle: "L’identité privée et le secret temporaire ne quittent jamais Keychain.",
            systemImage: "laptopcomputer.badge.plus"
        ) {
            VStack(alignment: .leading, spacing: 16) {
                PairingStep(
                    number: 1,
                    title: "Importer l’offre de l’hôte",
                    isComplete: !remoteDevicePairingRequest.isEmpty
                ) {
                    LabeledField("Nom de cet appareil") {
                        TextField(
                            "Mac distant",
                            text: $remoteDeviceName
                        )
                        .textFieldStyle(.roundedBorder)
                    }
                    SecurePayloadEditor(
                        value: $remotePairingOffer,
                        accessibilityLabel: "Offre reçue de l’hôte",
                        prompt: "Collez ici l’offre créée sur le Mac hôte"
                    )
                    Button {
                        if let request = client.beginRemoteDevicePairing(
                            bundle: remotePairingOffer,
                            deviceName: remoteDeviceName
                        ) {
                            remoteDevicePairingRequest = request
                        }
                    } label: {
                        Label(
                            "Créer la requête chiffrée",
                            systemImage: "lock.doc"
                        )
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.indigo)
                    .disabled(
                        remotePairingOffer.isEmpty
                            || remoteDeviceName.isEmpty
                    )
                }

                PairingStep(
                    number: 2,
                    title: "Renvoyer la requête à l’hôte",
                    isComplete: !remoteDevicePairingRequest.isEmpty
                ) {
                    if remoteDevicePairingRequest.isEmpty {
                        Text("Importez d’abord l’offre de l’hôte.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    } else {
                        SecurePayloadEditor(
                            value: $remoteDevicePairingRequest,
                            accessibilityLabel: "Requête à renvoyer"
                        )
                        CopyButton(label: "Copier la requête") {
                            copyToPasteboard(remoteDevicePairingRequest)
                        }
                    }
                }

                PairingStep(
                    number: 3,
                    title: "Terminer avec le bootstrap",
                    isComplete: client.remoteDeviceStatus.configured
                ) {
                    SecurePayloadEditor(
                        value: $remoteDeviceBootstrap,
                        accessibilityLabel: "Bootstrap reçu de l’hôte",
                        prompt: "Collez ici le bootstrap renvoyé par l’hôte"
                    )
                    Button {
                        client.completeRemoteDevicePairing(
                            bootstrap: remoteDeviceBootstrap
                        )
                        if client.remoteDeviceStatus.configured {
                            remotePairingOffer = ""
                            remoteDevicePairingRequest = ""
                            remoteDeviceBootstrap = ""
                        }
                    } label: {
                        Label(
                            "Ouvrir et terminer",
                            systemImage: "checkmark.shield"
                        )
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.indigo)
                    .disabled(remoteDeviceBootstrap.isEmpty)
                }
            }
        }
    }

    private var diagnosticsPane: some View {
        VStack(alignment: .leading, spacing: 18) {
            SettingsCard(
                title: "État des services",
                subtitle: "Vue synthétique des composants natifs du .app.",
                systemImage: "waveform.path.ecg"
            ) {
                VStack(spacing: 0) {
                    DiagnosticRow(
                        title: "Control plane",
                        detail: client.connected
                            ? "Connecté · v\(client.version)"
                            : "Hors ligne",
                        isHealthy: client.connected
                    )
                    Divider()
                    DiagnosticRow(
                        title: "Identifiants",
                        detail: client.tokenConfigured
                            ? "Token protégé dans Keychain"
                            : "Token manquant",
                        isHealthy: client.tokenConfigured
                    )
                    Divider()
                    DiagnosticRow(
                        title: "Pont hôte",
                        detail: client.remoteHostStatus.configured
                            ? remoteConnectorLabel
                            : "Non configuré",
                        isHealthy: !client.remoteHostStatus.configured
                            || client.remoteHostStatus.connectorState
                                == "online"
                    )
                    Divider()
                    DiagnosticRow(
                        title: "Appareil distant",
                        detail: client.remoteDeviceStatus.configured
                            ? "Identité configurée"
                            : "Non configuré",
                        isHealthy: true
                    )
                }
            }

            SettingsCard(
                title: "Messages",
                subtitle: "Les détails peuvent être sélectionnés et copiés.",
                systemImage: "text.bubble"
            ) {
                if diagnosticsErrors.isEmpty {
                    ContentUnavailableView(
                        "Aucune erreur",
                        systemImage: "checkmark.circle.fill",
                        description: Text(
                            "Les composants natifs ne signalent aucun problème."
                        )
                    )
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 150)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(
                            Array(diagnosticsErrors.enumerated()),
                            id: \.offset
                        ) { _, error in
                            Label {
                                Text(error)
                                    .textSelection(.enabled)
                            } icon: {
                                Image(
                                    systemName: "exclamationmark.triangle.fill"
                                )
                                .foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
        }
    }

    private var validatedEndpoint: URL? {
        guard let url = URL(string: endpoint) else { return nil }
        return try? ApiClient.validatedEndpoint(url)
    }

    private var connectionModeBinding: Binding<ConnectionMode> {
        Binding(
            get: { client.connectionMode },
            set: { client.setConnectionMode($0) }
        )
    }

    private var canConfigureRemoteHost: Bool {
        !remoteOperationInProgress
            && client.connectionMode != .remote
            && URL(string: relayURL)?.scheme?.lowercased() == "https"
            && !relayAdminToken.isEmpty
            && !hostDeviceName.isEmpty
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

    private var remoteConnectorColor: Color {
        switch client.remoteHostStatus.connectorState {
        case "online": .green
        case "connecting": .orange
        case "degraded": .orange
        default: .secondary
        }
    }

    private var diagnosticsErrors: [String] {
        [
            client.lastError,
            client.remoteHostError,
            client.remoteDeviceError,
        ]
        .compactMap { $0 }
    }

    private func configureRemoteHost() {
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

    private func createRemotePairing() {
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

    private func acceptRemotePairing() {
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

    private func localizedDeviceStatus(_ status: String) -> String {
        switch status {
        case "active": "Actif"
        case "revoked": "Révoqué"
        case "expired": "Expiré"
        default: status
        }
    }

    private func copyToPasteboard(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

private enum SettingsDestination: String, CaseIterable, Identifiable {
    case controlPlane
    case remoteHost
    case remoteDevice
    case diagnostics

    var id: String { rawValue }

    var title: String {
        switch self {
        case .controlPlane: "Général"
        case .remoteHost: "Hôte distant"
        case .remoteDevice: "Cet appareil"
        case .diagnostics: "Diagnostics"
        }
    }

    var subtitle: String {
        switch self {
        case .controlPlane:
            "Connexion, identité et chemin réseau de Mission Control."
        case .remoteHost:
            "Publiez un accès distant chiffré et gérez les appareils."
        case .remoteDevice:
            "Appairez ce Mac à un hôte et contrôlez ses certificats."
        case .diagnostics:
            "Vérifiez les services natifs et consultez les erreurs."
        }
    }

    var systemImage: String {
        switch self {
        case .controlPlane: "gearshape"
        case .remoteHost: "network.badge.shield.half.filled"
        case .remoteDevice: "laptopcomputer"
        case .diagnostics: "waveform.path.ecg"
        }
    }
}

private struct SettingsDetailBackdrop<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            Circle()
                .fill(Color.indigo.opacity(0.08))
                .frame(width: 420, height: 420)
                .blur(radius: 90)
                .offset(x: 260, y: -220)
                .ignoresSafeArea()

            Circle()
                .fill(Color.cyan.opacity(0.055))
                .frame(width: 330, height: 330)
                .blur(radius: 100)
                .offset(x: -280, y: 260)
                .ignoresSafeArea()

            content()
        }
    }
}

private struct SettingsPageHeader: View {
    let destination: SettingsDestination

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: destination.systemImage)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.indigo)
                .frame(width: 48, height: 48)
                .glassEffect(
                    .regular.tint(Color.indigo.opacity(0.12)),
                    in: .rect(cornerRadius: 14)
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(destination.title)
                    .font(.largeTitle.bold())
                Text(destination.subtitle)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct SidebarConnectionSummary: View {
    let connected: Bool
    let mode: ConnectionMode
    let version: String

    var body: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(connected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(connected ? "Connecté" : "Hors ligne")
                    .font(.caption.weight(.semibold))
                Text(
                    connected
                        ? "\(mode == .remote ? "Relais" : "Local") · v\(version)"
                        : "Reconnexion…"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .glassEffect(
            .regular.tint(
                (connected ? Color.green : Color.orange).opacity(0.07)
            ),
            in: .rect(cornerRadius: 13)
        )
    }
}

private struct ConnectionHero: View {
    let connected: Bool
    let tokenConfigured: Bool
    let mode: ConnectionMode
    let endpoint: URL
    let version: String

    var body: some View {
        HStack(spacing: 18) {
            ZStack {
                Circle()
                    .fill((connected ? Color.green : Color.orange).opacity(0.18))
                Image(
                    systemName: connected
                        ? "checkmark.icloud.fill"
                        : "icloud.slash.fill"
                )
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(connected ? .green : .orange)
            }
            .frame(width: 58, height: 58)

            VStack(alignment: .leading, spacing: 4) {
                Text(connected ? "Mission Control est prêt" : "Connexion requise")
                    .font(.title2.bold())
                Text(
                    connected
                        ? "\(mode == .remote ? "Relais chiffré" : "Connexion locale") · Control plane v\(version)"
                        : tokenConfigured
                            ? "AvityOS tente de joindre \(endpoint.host ?? endpoint.absoluteString)."
                            : "Ajoutez un token pour commencer."
                )
                .foregroundStyle(.secondary)
                .lineLimit(2)
            }

            Spacer()

            StatusBadge(
                label: connected ? "En ligne" : "Hors ligne",
                color: connected ? .green : .orange,
                systemImage: connected
                    ? "checkmark.circle.fill"
                    : "exclamationmark.circle.fill"
            )
        }
        .padding(20)
        .glassEffect(
            .regular.tint(
                (connected ? Color.green : Color.orange).opacity(0.06)
            ),
            in: .rect(cornerRadius: 20)
        )
    }
}

private struct SettingsCard<Content: View>: View {
    let title: String
    let subtitle: String
    let systemImage: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.indigo)
                    .frame(width: 28, height: 28)
                    .background(Color.indigo.opacity(0.1), in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            content()
        }
        .padding(20)
        .background(
            Color(nsColor: .controlBackgroundColor).opacity(0.78),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.white.opacity(0.28), lineWidth: 0.75)
        }
        .shadow(color: .black.opacity(0.045), radius: 18, y: 7)
    }
}

private struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16) {
            GridRow {
                Text(label)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 172, alignment: .trailing)
                content()
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct StatusBadge: View {
    let label: String
    let color: Color
    let systemImage: String

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.1), in: Capsule())
    }
}

private struct PairingStep<Content: View>: View {
    let number: Int
    let title: String
    let isComplete: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle()
                    .fill(
                        isComplete
                            ? Color.green.opacity(0.16)
                            : Color.indigo.opacity(0.12)
                    )
                if isComplete {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.green)
                        .font(.caption.bold())
                } else {
                    Text(String(number))
                        .foregroundStyle(.indigo)
                        .font(.caption.bold())
                }
            }
            .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.callout.weight(.semibold))
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct SecurePayloadEditor: View {
    @Binding var value: String
    let accessibilityLabel: String
    var prompt = ""

    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $value)
                .font(.system(.caption, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(8)

            if value.isEmpty && !prompt.isEmpty {
                Text(prompt)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 17)
                    .allowsHitTesting(false)
            }
        }
        .frame(minHeight: 92)
        .background(
            Color(nsColor: .textBackgroundColor).opacity(0.66),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(.separator.opacity(0.55), lineWidth: 0.75)
        }
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct CopyButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(label, systemImage: "doc.on.doc")
        }
        .buttonStyle(.glass)
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .lineLimit(1)
                .textSelection(.enabled)
        }
        .font(.callout)
    }
}

private struct DiagnosticRow: View {
    let title: String
    let detail: String
    let isHealthy: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(
                systemName: isHealthy
                    ? "checkmark.circle.fill"
                    : "exclamationmark.circle.fill"
            )
            .foregroundStyle(isHealthy ? .green : .orange)
            Text(title)
                .font(.callout.weight(.medium))
            Spacer()
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 11)
    }
}
