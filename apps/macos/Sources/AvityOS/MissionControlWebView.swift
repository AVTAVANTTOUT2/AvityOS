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
        userController.addUserScript(Self.requestBodyBridgeScript)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = userController
        configuration.setURLSchemeHandler(coordinator.schemeHandler, forURLScheme: WebUISchemeHandler.scheme)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        // Public API rather than KVC on private WebKit keys: an unknown key
        // raises an Objective-C exception, and this view is the whole window.
        // The cream base matches the shell so loading shows no white flash.
        webView.underPageBackgroundColor = NSColor(
            srgbRed: 0.969,
            green: 0.957,
            blue: 0.933,
            alpha: 1
        )
        #if DEBUG
        // Web inspector stays out of distributed, hardened-runtime builds.
        webView.isInspectable = true
        #endif
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
            context.coordinator.navigate(to: pendingRoute)
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

    /// WebKit does not forward a `fetch` body to a custom `WKURLSchemeHandler`,
    /// so every POST/PATCH/DELETE would reach the control plane empty. The
    /// body is carried base64-encoded in a request header that
    /// `WebUISchemeHandler` decodes and strips. GET and EventSource are
    /// untouched, so SSE keeps streaming through the handler.
    private static var requestBodyBridgeScript: WKUserScript {
        let source = """
        (function () {
          if (window.__AVITY_BODY_BRIDGE__) return;
          window.__AVITY_BODY_BRIDGE__ = true;
          var nativeFetch = window.fetch.bind(window);
          window.fetch = function (input, init) {
            var request;
            try {
              request = new Request(input, init);
            } catch (error) {
              return nativeFetch(input, init);
            }
            if (request.method === "GET" || request.method === "HEAD") {
              return nativeFetch(request);
            }
            // A custom scheme is not a "special" URL, so `URL.origin` is the
            // literal string "null" and cannot be compared. Match the scheme
            // and host instead.
            var target;
            try {
              target = new URL(request.url, location.href);
            } catch (error) {
              return nativeFetch(request);
            }
            if (target.protocol !== location.protocol || target.host !== location.host) {
              return nativeFetch(request);
            }
            var clone;
            try {
              clone = request.clone();
            } catch (error) {
              return nativeFetch(request);
            }
            return clone.text().then(function (raw) {
              if (!raw) {
                return nativeFetch(request);
              }
              var encoded;
              try {
                var bytes = new TextEncoder().encode(raw);
                var binary = "";
                for (var i = 0; i < bytes.length; i += 1) {
                  binary += String.fromCharCode(bytes[i]);
                }
                encoded = btoa(binary);
              } catch (error) {
                return nativeFetch(request);
              }
              var headers = new Headers(request.headers);
              headers.set("\(WebUISchemeHandler.encodedBodyHeader)", encoded);
              return nativeFetch(request.url, {
                method: request.method,
                headers: headers,
                body: raw,
                credentials: request.credentials
              });
            });
          };
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    // SDK 26 annotates WKNavigationDelegate / WKScriptMessageHandler as
    // @MainActor; marking the coordinator the same way matches both that SDK
    // and Xcode 15.4, where the protocols are still callable from the main
    // thread that owns the WKWebView.
    @MainActor
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

        nonisolated static func webUIRoot() -> URL {
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

        func navigate(to route: String) {
            let escaped = route
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.avityNativeNavigate && window.avityNativeNavigate('\(escaped)');"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "avityNative",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                return
            }
            let token = (body["token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            handleNativeBridgeMessage(type: type, token: token)
        }

        private func handleNativeBridgeMessage(type: String, token: String?) {
            switch type {
            case "openNativeSettings":
                onOpenNativeSettings()
            case "saveApiToken":
                if let token {
                    client.configure(baseURL: client.baseURL, token: token)
                    webView?.reload()
                }
            default:
                break
            }
        }

        #if compiler(>=6.0)
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
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
        #else
        func webView(
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
            if url.scheme == "http" || url.scheme == "https" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.cancel)
        }
        #endif
    }
}
