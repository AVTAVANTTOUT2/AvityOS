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
        // The embedded Mission Control UI runs edge to edge behind the glass
        // header, so the window contributes no title bar of its own.
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Rafraîchir") { Task { await client.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
            // Leave .appSettings alone: the Settings scene owns « Réglages… »
            // and ⌘,. Replacing it with showSettingsWindow: broke opening on
            // macOS 14+ (Apple requires SettingsLink / openSettings there).
        }

        MenuBarExtra("AvityOS", systemImage: "brain") {
            MenuBarView().environmentObject(client)
        }
        // A glass panel rather than a plain menu: the companion reports live
        // transport state and counts, which a list of menu items cannot show.
        .menuBarExtraStyle(.window)

        // Programmatic opens (toolbar, deep link, web bridge) go through this
        // window: openWindow is available on the CI SDK, unlike openSettings,
        // and showSettingsWindow: is a no-op since macOS 14.
        Window("Réglages", id: NativeAppSettings.windowID) {
            SettingsView().environmentObject(client)
        }
        .windowResizability(.contentMinSize)

        Settings {
            SettingsView().environmentObject(client)
        }
    }
}

enum AppRuntime {
    /// Suppresses the notification-authorization prompt and background polling
    /// so XCUITest is not blocked by a system dialog. It must never select a
    /// different user interface: the tested shell is the shipped shell.
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
    static let windowID = "native-settings"
    static let openNotification = Notification.Name("avity.openNativeSettings")

    /// Asks the main shell to present the native settings window via
    /// `openWindow`. Posted as a notification so AppKit callers (deep links,
    /// the web bridge) do not need a SwiftUI `Environment` value that the
    /// SwiftPM toolchain on CI cannot resolve (`openSettings`).
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

    private var tone: ConnectionTone {
        ConnectionTone(
            connected: client.connected,
            isRelay: client.connectionMode == .remote
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            // A single Liquid Glass container so the header controls refract
            // and blend as one surface instead of separate chips.
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Text("AvityOS")
                        .font(.headline)
                    Text("Mission Control")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: GlassMetrics.stackSpacing)
                    ConnectionBadge(tone: tone, detail: connectionLabel)
                    Button {
                        Task { await client.refresh() }
                    } label: {
                        Label("Rafraîchir", systemImage: "arrow.clockwise")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.glass)
                    .help("Rafraîchir les données du control plane")
                    .accessibilityIdentifier("toolbar.refresh")
                    Button {
                        openNativeSettingsWindow()
                    } label: {
                        Label("Réglages", systemImage: "gearshape")
                    }
                    .buttonStyle(.glass)
                    .help("Keychain, pont distant et diagnostics")
                    .accessibilityIdentifier("toolbar.native-settings")
                }
                // The window hides its title bar so the embedded UI runs edge
                // to edge; the header leaves room for the window controls
                // rather than drawing underneath them.
                .padding(.leading, GlassMetrics.windowControlsInset)
                .padding(.trailing, GlassMetrics.gutter)
                .frame(height: GlassMetrics.headerHeight)
            }

            MissionControlWebView(
                client: client,
                pendingRoute: pendingRoute,
                onOpenNativeSettings: { NativeAppSettings.open() },
                onRouteConsumed: { pendingRoute = nil }
            )
        }
        // Keep children queryable by their own identifiers. A bare
        // accessibilityIdentifier on the container replaces them on macOS, so
        // XCUITest would only see `screen.mission-control` for the status and
        // settings controls that the suite asserts.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("screen.mission-control")
        .background(Color(red: 0.969, green: 0.957, blue: 0.933))
        .onReceive(
            NotificationCenter.default.publisher(for: NativeAppSettings.openNotification)
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
        .frame(minWidth: 1100, minHeight: 720)
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

struct MenuBarView: View {
    @EnvironmentObject private var client: ApiClient
    @Environment(\.openWindow) private var openWindow

    private var tone: ConnectionTone {
        ConnectionTone(
            connected: client.connected,
            isRelay: client.connectionMode == .remote
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: GlassMetrics.stackSpacing) {
            HStack {
                ConnectionBadge(
                    tone: tone,
                    detail: client.connected
                        ? "\(tone.shortLabel) · v\(client.version)"
                        : tone.shortLabel
                )
                Spacer()
            }

            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    MenuBarMetric(
                        value: client.projects.count,
                        caption: "projet(s)",
                        symbol: "folder"
                    )
                    // Pending interventions are the only reason to open the app
                    // in a hurry, so they are tinted rather than counted flatly.
                    MenuBarMetric(
                        value: client.approvals.count,
                        caption: "intervention(s)",
                        symbol: "tray.full",
                        tint: client.approvals.count > 0 ? .orange : nil
                    )
                }
            }

            Divider()

            Button {
                NSApplication.shared.activate(ignoringOtherApps: true)
                openWindow(id: "main")
            } label: {
                Label("Ouvrir AvityOS", systemImage: "macwindow")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.glassProminent)

            Button {
                Task { await client.refresh() }
            } label: {
                Label("Rafraîchir", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.glass)

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quitter AvityOS", systemImage: "power")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.glass)
        }
        .padding(GlassMetrics.gutter)
        .frame(width: 280)
    }
}

private struct MenuBarMetric: View {
    let value: Int
    let caption: String
    let symbol: String
    var tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("\(value)", systemImage: symbol)
                .font(.title3.monospacedDigit().bold())
                .labelStyle(.titleAndIcon)
            Text(caption)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(
            tint.map { .regular.tint($0.opacity(0.2)) } ?? .regular,
            in: .rect(cornerRadius: GlassMetrics.controlRadius)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(caption)")
    }
}
