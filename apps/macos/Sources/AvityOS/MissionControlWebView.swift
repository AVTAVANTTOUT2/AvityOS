import AppKit
import SwiftUI
import WebKit

/// Hosts the Figma-derived Mission Control React UI inside the native .app.
struct MissionControlWebView: NSViewRepresentable {
    @ObservedObject var client: ApiClient
    var pendingRoute: String?
    var onOpenNativeSettings: () -> Void
    var onRouteConsumed: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            client: client,
            onOpenNativeSettings: onOpenNativeSettings,
            onRouteConsumed: onRouteConsumed
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let userController = WKUserContentController()
        userController.add(coordinator, name: "avityNative")
        userController.addUserScript(Self.bridgeBootstrapScript)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = userController
        configuration.setURLSchemeHandler(coordinator.schemeHandler, forURLScheme: WebUISchemeHandler.scheme)
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.setAccessibilityIdentifier("webview.figma-shell")
        coordinator.webView = webView

        if let url = URL(string: "\(WebUISchemeHandler.scheme)://\(WebUISchemeHandler.host)/index.html") {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.client = client
        context.coordinator.onOpenNativeSettings = onOpenNativeSettings
        context.coordinator.onRouteConsumed = onRouteConsumed
        if let pendingRoute {
            Task { @MainActor in
                context.coordinator.navigate(to: pendingRoute)
            }
            onRouteConsumed()
        }
    }

    private static var bridgeBootstrapScript: WKUserScript {
        let source = """
        (function () {
          if (window.__AVITY_NATIVE__) return;
          window.__AVITY_NATIVE__ = {
            shell: true,
            platform: "macos",
            openNativeSettings: function () {
              window.webkit.messageHandlers.avityNative.postMessage({ type: "openNativeSettings" });
            },
            saveApiToken: function (token) {
              window.webkit.messageHandlers.avityNative.postMessage({ type: "saveApiToken", token: String(token || "") });
            }
          };
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var client: ApiClient
        var onOpenNativeSettings: () -> Void
        var onRouteConsumed: () -> Void
        let schemeHandler: WebUISchemeHandler
        weak var webView: WKWebView?

        init(
            client: ApiClient,
            onOpenNativeSettings: @escaping () -> Void,
            onRouteConsumed: @escaping () -> Void
        ) {
            self.client = client
            self.onOpenNativeSettings = onOpenNativeSettings
            self.onRouteConsumed = onRouteConsumed
            self.schemeHandler = WebUISchemeHandler(
                resourceRoot: Self.webUIRoot(),
                controlPlaneBaseURL: { WebUIProxyConfiguration.controlPlaneBaseURL() },
                bearerToken: { WebUIProxyConfiguration.bearerToken() }
            )
            super.init()
        }

        static func webUIRoot() -> URL {
            if let bundled = Bundle.main.resourceURL?.appendingPathComponent("WebUI", isDirectory: true),
               FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
                return bundled
            }
            // SwiftPM `swift run` fallback: look next to the package for a built WebUI.
            let candidates = [
                URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                    .appendingPathComponent("Resources/WebUI"),
                URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                    .appendingPathComponent("apps/macos/Resources/WebUI"),
            ]
            for candidate in candidates where FileManager.default.fileExists(
                atPath: candidate.appendingPathComponent("index.html").path
            ) {
                return candidate
            }
            return Bundle.main.resourceURL?.appendingPathComponent("WebUI", isDirectory: true)
                ?? URL(fileURLWithPath: "/tmp/avity-missing-webui")
        }

        @MainActor
        func navigate(to route: String) {
            let escaped = route
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.avityNativeNavigate && window.avityNativeNavigate('\(escaped)');"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        nonisolated func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "avityNative",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }
            Task { @MainActor in
                switch type {
                case "openNativeSettings":
                    onOpenNativeSettings()
                case "saveApiToken":
                    if let token = body["token"] as? String, !token.isEmpty {
                        client.configure(baseURL: client.baseURL, token: token)
                        webView?.reload()
                    }
                default:
                    break
                }
            }
        }

        nonisolated func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if url.scheme == WebUISchemeHandler.scheme {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "avity" {
                decisionHandler(.cancel)
                return
            }
            // Keep the shell closed: open external https links in the system browser.
            if url.scheme == "http" || url.scheme == "https" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
        }
    }
}
