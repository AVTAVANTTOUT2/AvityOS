import AppKit
import SwiftUI

/// Liquid Glass design layer for the native macOS surfaces.
///
/// ADR-0021 keeps the Figma Mission Control build as the application's only
/// frontend, so the native chrome around it — window header, Settings, menu bar
/// — is what these primitives style. They wrap Apple's Liquid Glass APIs
/// (macOS 26) rather than re-implementing translucency by hand, so the shell
/// picks up the system's refraction, shadow and accessibility behaviour.
enum GlassMetrics {
    static let cardRadius: CGFloat = 20
    static let controlRadius: CGFloat = 12
    static let gutter: CGFloat = 16
    static let stackSpacing: CGFloat = 12
    static let headerHeight: CGFloat = 52
    /// Room reserved for the window controls: the main window hides its title
    /// bar so the embedded UI runs edge to edge behind the glass header.
    static let windowControlsInset: CGFloat = 78
}

/// Transport state rendered as one semantic token, so the header, the menu bar
/// and Settings cannot describe the same connection differently.
enum ConnectionTone {
    case offline
    case local
    case relay

    init(connected: Bool, isRelay: Bool) {
        guard connected else {
            self = .offline
            return
        }
        self = isRelay ? .relay : .local
    }

    var tint: Color {
        switch self {
        case .offline: .orange
        case .local: .green
        case .relay: .blue
        }
    }

    var symbol: String {
        switch self {
        case .offline: "wifi.slash"
        case .local: "bolt.horizontal.circle.fill"
        case .relay: "lock.icloud.fill"
        }
    }

    var shortLabel: String {
        switch self {
        case .offline: "Hors ligne"
        case .local: "Local"
        case .relay: "Relais chiffré"
        }
    }
}

/// A titled Liquid Glass panel. Settings is built from these instead of one
/// long grouped `Form`, so each concern reads as a separate surface.
struct GlassCard<Content: View>: View {
    private let title: String
    private let systemImage: String
    private let footnote: String?
    private let content: Content

    init(
        _ title: String,
        systemImage: String,
        footnote: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.footnote = footnote
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: GlassMetrics.stackSpacing) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .labelStyle(.titleAndIcon)
            if let footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content
        }
        .padding(GlassMetrics.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: GlassMetrics.cardRadius))
    }
}

/// Live transport indicator. The tint carries the state, the text names it, and
/// the symbol repeats it so colour is never the only signal.
struct ConnectionBadge: View {
    let tone: ConnectionTone
    let detail: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: tone.symbol)
                .font(.caption)
                .foregroundStyle(tone.tint)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("connection.status")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect(
            .regular.tint(tone.tint.opacity(0.18)),
            in: .capsule
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("État de la connexion")
        .accessibilityValue(detail)
    }
}

/// One step of an out-of-band pairing exchange.
///
/// The previous Settings screen stacked bare `TextEditor`s with numbered
/// captions, which gave no sense of progress and no affordance for the copy
/// that every step actually requires. Each step now states its rank, whether it
/// is something to send or something to paste, and carries its own action.
struct PairingStep<Action: View>: View {
    private let index: Int
    private let instruction: String
    private let payload: Binding<String>
    private let isOutbound: Bool
    private let action: Action

    init(
        index: Int,
        instruction: String,
        payload: Binding<String>,
        isOutbound: Bool,
        @ViewBuilder action: () -> Action
    ) {
        self.index = index
        self.instruction = instruction
        self.payload = payload
        self.isOutbound = isOutbound
        self.action = action()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(index)")
                    .font(.caption.monospacedDigit().bold())
                    .frame(width: 20, height: 20)
                    .glassEffect(.regular.tint(.accentColor.opacity(0.25)), in: .circle)
                Text(instruction)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Image(systemName: isOutbound ? "arrow.up.forward" : "arrow.down.backward")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .help(isOutbound ? "À transmettre hors bande" : "À coller depuis l’autre Mac")
            }
            TextEditor(text: payload)
                .font(.system(.caption, design: .monospaced))
                .scrollContentBackground(.hidden)
                .frame(minHeight: 72)
                .padding(8)
                .glassEffect(.clear, in: .rect(cornerRadius: GlassMetrics.controlRadius))
            action
        }
    }
}

/// Failures used to pile up as red text at the bottom of a long form, far from
/// the control that produced them. They are now a labelled, selectable surface.
struct DiagnosticRow: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.bold())
                .foregroundStyle(.red)
            Text(message)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(GlassMetrics.stackSpacing)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(
            .regular.tint(.red.opacity(0.14)),
            in: .rect(cornerRadius: GlassMetrics.controlRadius)
        )
    }
}

enum Pasteboard {
    /// Every pairing payload is transferred out of band, so copying is the
    /// primary action on those steps rather than an afterthought.
    static func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}
