import AppKit
import SwiftUI
import UserNotifications

@main
struct AvityOSApp: App {
    @StateObject private var client = AppRuntime.makeClient()

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
                    NSApplication.shared.dockTile.badgeLabel =
                        count > 0 ? String(count) : nil
                    if count > previous {
                        NotificationCoordinator.notifyInterventions(
                            count: count
                        )
                    }
                }
        }
        .defaultSize(width: 1280, height: 820)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Rafraîchir") {
                    Task { await client.refresh() }
                }
                .keyboardShortcut("r", modifiers: .command)
            }
            // Leave .appSettings alone: the Settings scene owns « Réglages… »
            // and ⌘,. Programmatic callers use the identified Window below.
        }

        MenuBarExtra("AvityOS", systemImage: "brain") {
            MenuBarView().environmentObject(client)
        }

        // Programmatic opens (toolbar, deep link, web bridge) go through this
        // window: its stable identifier works from toolbar, deep-link and
        // WebKit bridge entry points.
        Window("Réglages", id: NativeAppSettings.windowID) {
            SettingsView()
                .environmentObject(client)
                .frame(minWidth: 760, minHeight: 560)
        }
        .defaultSize(width: 860, height: 660)
        .windowResizability(.contentMinSize)
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: false))

        Settings {
            SettingsView()
                .environmentObject(client)
                .frame(minWidth: 760, minHeight: 560)
        }
        .defaultSize(width: 860, height: 660)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))
    }
}

enum AppRuntime {
    /// Suppresses the notification-authorization prompt and background polling
    /// so XCUITest is not blocked by a system dialog. It must never select a
    /// different user interface: the tested shell is the shipped shell.
    static var isUITesting: Bool {
        ProcessInfo.processInfo.environment["AVITY_UI_TEST_MODE"] == "1"
            || ProcessInfo.processInfo.arguments.contains("--avity-ui-testing")
    }

    /// UI automation validates the shipped shell, not the user's Keychain.
    /// Isolating credentials also prevents a locked or access-controlled
    /// Keychain from blocking scene creation before XCUITest can attach.
    @MainActor
    static func makeClient() -> ApiClient {
        guard isUITesting else { return ApiClient() }
        return ApiClient(
            credentials: UITestCredentialStore(),
            remoteStore: UITestRemoteDeviceStore()
        )
    }
}

private struct UITestCredentialStore: CredentialStore {
    func loadToken() throws -> String? { nil }
    func saveToken(_ token: String) throws {}
    func deleteToken() throws {}
}

private struct UITestRemoteDeviceStore: RemoteDeviceConfigurationStore {
    func loadConfiguration() throws -> RemoteDeviceConfiguration? { nil }
    func saveConfiguration(_ configuration: RemoteDeviceConfiguration) throws {}
    func deleteConfiguration() throws {}
    func loadPendingPairing() throws -> PendingRemotePairing? { nil }
    func savePendingPairing(_ pairing: PendingRemotePairing) throws {}
    func deletePendingPairing() throws {}
}

enum NotificationCoordinator {
    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) {
            _, _ in
        }
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
    static let windowID = "native-settings"
    static let openNotification = Notification.Name("avity.openNativeSettings")

    /// Asks the main shell to present the native settings window via
    /// `openWindow`. Posted as a notification so AppKit callers (deep links
    /// and the web bridge) do not need to own a SwiftUI `Environment` value.
    @MainActor
    static func open() {
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: openNotification, object: nil)
    }
}

/// ADR-0021: the main window hosts exactly one frontend — the Figma Mission
/// Control build. No build flag or environment variable substitutes a second
/// shell, so XCUITest exercises the surface operators actually receive.
struct ContentView: View {
    var body: some View {
        FigmaMissionControlShell()
    }
}

struct FigmaMissionControlShell: View {
    @EnvironmentObject private var client: ApiClient
    @Environment(\.openWindow) private var openWindow
    @State private var pendingRoute: String?

    var body: some View {
        MissionControlWebView(
            client: client,
            pendingRoute: pendingRoute,
            onOpenNativeSettings: { NativeAppSettings.open() },
            onRouteConsumed: { pendingRoute = nil }
        )
        // Keep children queryable by their own identifiers. A bare
        // accessibilityIdentifier on the container replaces them on macOS, so
        // XCUITest would only see `screen.mission-control` for the status and
        // settings controls that the suite asserts.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("screen.mission-control")
        .background(Color(red: 0.969, green: 0.957, blue: 0.933))
        .toolbar {
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 9) {
                    Image(systemName: "sparkles.rectangle.stack.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.indigo)
                        .symbolRenderingMode(.hierarchical)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("AvityOS")
                            .font(.headline)
                        Text("Mission Control")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("AvityOS Mission Control")
            }

            ToolbarItem(placement: .principal) {
                ConnectionStatusPill(
                    connected: client.connected,
                    label: connectionLabel
                )
                .accessibilityIdentifier("connection.status")
            }

            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await client.refresh() }
                } label: {
                    Label("Rafraîchir", systemImage: "arrow.clockwise")
                }
                .labelStyle(.iconOnly)
                .help("Rafraîchir Mission Control (⌘R)")
                .accessibilityIdentifier("toolbar.refresh")
            }

            ToolbarSpacer(.fixed, placement: .primaryAction)

            // Toolbar items adopt Liquid Glass from the unified toolbar itself.
            // Applying `.buttonStyle(.glass)` here nested a second glass
            // container inside the item, and the resulting element reported
            // itself visible but not hittable, so the toolbar entry point could
            // not be clicked.
            ToolbarItem(placement: .primaryAction) {
                Button {
                    openNativeSettingsWindow()
                } label: {
                    Label("Réglages", systemImage: "slider.horizontal.3")
                }
                .help("Ouvrir les réglages natifs")
                .accessibilityIdentifier("toolbar.native-settings")
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: NativeAppSettings.openNotification
            )
        ) { _ in
            openNativeSettingsWindow()
        }
        .onOpenURL { url in
            let host = url.host ?? "mission-control"
            if host == "settings" {
                openNativeSettingsWindow()
                pendingRoute = "settings"
            } else {
                pendingRoute = host
            }
        }
        // Keep the default desktop layout spacious while still fitting the
        // narrower macOS CI display and smaller laptop work areas. A 1100 pt
        // minimum placed the trailing Settings toolbar item exactly outside
        // the 1096 pt automation viewport, making an otherwise visible control
        // non-hittable.
        .frame(minWidth: 960, minHeight: 720)
    }

    private func openNativeSettingsWindow() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: NativeAppSettings.windowID)
    }

    private var connectionLabel: String {
        guard client.connected else { return "Hors ligne — reconnexion…" }
        if client.connectionMode == .remote {
            return "Relais chiffré · Control plane v\(client.version)"
        }
        return "Control plane local v\(client.version)"
    }
}

private struct ConnectionStatusPill: View {
    let connected: Bool
    let label: String

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(connected ? Color.green : Color.orange)
                .frame(width: 8, height: 8)
                .shadow(
                    color: (connected ? Color.green : Color.orange)
                        .opacity(0.55),
                    radius: 4
                )
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .glassEffect(
            .regular.tint(
                (connected ? Color.green : Color.orange).opacity(0.08)
            ),
            in: .capsule
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct MenuBarView: View {
    @EnvironmentObject private var client: ApiClient
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Label(
            client.connected
                ? "\(client.connectionMode == .remote ? "Relais chiffré" : "Local") · v\(client.version)"
                : "Hors ligne",
            systemImage: client.connected
                ? "checkmark.circle.fill"
                : "exclamationmark.circle.fill"
        )
        Label("\(client.projects.count) projet(s)", systemImage: "folder")
        Label("\(client.approvals.count) intervention(s)", systemImage: "hand.raised")
        Divider()
        Button {
            NSApplication.shared.activate(ignoringOtherApps: true)
            openWindow(id: "main")
        } label: {
            Label("Ouvrir Mission Control", systemImage: "macwindow")
        }
        Button {
            openWindow(id: NativeAppSettings.windowID)
            NSApplication.shared.activate(ignoringOtherApps: true)
        } label: {
            Label("Réglages…", systemImage: "slider.horizontal.3")
        }
        Button {
            Task { await client.refresh() }
        } label: {
            Label("Rafraîchir", systemImage: "arrow.clockwise")
        }
        Divider()
        Button {
            NSApplication.shared.terminate(nil)
        } label: {
            Label("Quitter AvityOS", systemImage: "power")
        }
    }
}
