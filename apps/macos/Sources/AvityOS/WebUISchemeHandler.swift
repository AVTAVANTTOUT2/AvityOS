import Foundation
import UniformTypeIdentifiers
import WebKit

/// Thread-safe reads of control-plane endpoint/token for the WKURLSchemeHandler.
/// The handler runs off the main actor; credentials remain Keychain-backed.
enum WebUIProxyConfiguration {
    static let endpointDefaultsKey = "controlPlaneURL"
    static let defaultLoopbackURL = URL(string: "http://127.0.0.1:7717/")!

    static func controlPlaneBaseURL(defaults: UserDefaults = .standard) -> URL {
        guard let saved = defaults.string(forKey: endpointDefaultsKey),
              let url = URL(string: saved) else {
            return defaultLoopbackURL
        }
        return url
    }

    static func bearerToken(store: CredentialStore = KeychainCredentialStore()) -> String? {
        guard let token = try? store.loadToken(), !token.isEmpty else {
            return nil
        }
        return token
    }
}

/// Serializes callbacks to a `WKURLSchemeTask` and drops every callback that
/// arrives after WebKit stopped it. Messaging a stopped scheme task raises an
/// Objective-C exception that terminates the application, and cancelling a
/// proxied request always delivers a late completion, so the guard is required
/// rather than defensive.
final class SchemeTaskChannel: @unchecked Sendable {
    private let task: any WKURLSchemeTask
    /// Responses must be reported against the `avity-app://` URL the page asked
    /// for; reporting the control-plane or file URL breaks same-origin.
    let requestURL: URL
    private let lock = NSLock()
    private var isStopped = false

    init(task: any WKURLSchemeTask, requestURL: URL) {
        self.task = task
        self.requestURL = requestURL
    }

    /// Called from `webView(_:stop:)`. Every later callback becomes a no-op.
    func stop() {
        lock.lock()
        isStopped = true
        lock.unlock()
    }

    private func deliver(_ work: (any WKURLSchemeTask) -> Void) {
        lock.lock()
        let isActive = !isStopped
        lock.unlock()
        guard isActive else { return }
        // The callback runs outside the lock on purpose. WebKit calls
        // `webView(_:stop:)` re-entrantly from within `didFinish` and
        // `didFailWithError`, and static assets are served synchronously on the
        // main thread, so holding a non-recursive lock across the callback
        // deadlocks the main thread and the window never appears.
        work(task)
    }

    func fail(_ error: any Error) {
        deliver { $0.didFailWithError(error) }
        stop()
    }

    func send(response: URLResponse) {
        deliver { $0.didReceive(response) }
    }

    func send(data: Data) {
        guard !data.isEmpty else { return }
        deliver { $0.didReceive(data) }
    }

    func finish() {
        deliver { $0.didFinish() }
        stop()
    }

    /// Rebuilds the control-plane response against the `avity-app://` URL.
    /// CORS headers are dropped because the embedded UI is same-origin, and
    /// `transfer-encoding` because WebKit re-frames the body itself.
    func complete(http: HTTPURLResponse, data: Data?) {
        guard let schemeResponse = Self.schemeResponse(from: http, url: requestURL) else {
            fail(WebUISchemeError.invalidResponse)
            return
        }
        send(response: schemeResponse)
        if let data {
            send(data: data)
        }
        finish()
    }

    static func schemeResponse(from http: HTTPURLResponse, url: URL) -> HTTPURLResponse? {
        let filtered = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let header = entry.key as? String else { return }
            let lower = header.lowercased()
            if lower.hasPrefix("access-control-") || lower == "transfer-encoding" {
                return
            }
            result[header] = String(describing: entry.value)
        }
        return HTTPURLResponse(
            url: url,
            statusCode: http.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: filtered
        )
    }
}

/// Lock-protected bookkeeping for in-flight proxied scheme tasks.
/// Kept outside `WebUISchemeHandler`'s MainActor isolation (SDK 26) so
/// URLSession completions can release entries without hopping actors.
private final class SchemeTaskRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [ObjectIdentifier: URLSessionTask] = [:]
    private var channels: [ObjectIdentifier: SchemeTaskChannel] = [:]
    private var streamSessions: [ObjectIdentifier: URLSession] = [:]

    func store(channel: SchemeTaskChannel, for key: ObjectIdentifier) {
        lock.lock()
        channels[key] = channel
        lock.unlock()
    }

    func store(task: URLSessionTask, for key: ObjectIdentifier) {
        lock.lock()
        tasks[key] = task
        lock.unlock()
    }

    func store(streamSession: URLSession, task: URLSessionTask, for key: ObjectIdentifier) {
        lock.lock()
        tasks[key] = task
        streamSessions[key] = streamSession
        lock.unlock()
    }

    func stop(_ key: ObjectIdentifier) -> (channel: SchemeTaskChannel?, task: URLSessionTask?, streamSession: URLSession?) {
        lock.lock()
        let task = tasks.removeValue(forKey: key)
        let channel = channels.removeValue(forKey: key)
        let streamSession = streamSessions.removeValue(forKey: key)
        lock.unlock()
        return (channel, task, streamSession)
    }

    func release(_ key: ObjectIdentifier) -> URLSession? {
        lock.lock()
        tasks.removeValue(forKey: key)
        channels.removeValue(forKey: key)
        let streamSession = streamSessions.removeValue(forKey: key)
        lock.unlock()
        return streamSession
    }
}

/// Serves the bundled Figma Mission Control UI and proxies `/v1` to the
/// control plane with the Keychain bearer. SSE routes stream incrementally.
final class WebUISchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    static let scheme = "avity-app"
    static let host = "ui"

    /// `WKURLSchemeTask` never exposes the HTTP body of a `fetch` request
    /// (WebKit does not forward it to custom scheme handlers), so every write
    /// would reach the control plane with an empty payload. The injected client
    /// shim re-sends the body base64-encoded in this header; it is decoded here
    /// and stripped before the request leaves the application.
    static let encodedBodyHeader = "X-Avity-Encoded-Body"

    private let resourceRoot: URL
    private let controlPlaneBaseURL: () -> URL
    private let bearerToken: () -> String?
    private let session: URLSession
    private let registry = SchemeTaskRegistry()

    init(
        resourceRoot: URL,
        controlPlaneBaseURL: @escaping () -> URL,
        bearerToken: @escaping () -> String?,
        session: URLSession = .shared
    ) {
        self.resourceRoot = resourceRoot.standardizedFileURL
        self.controlPlaneBaseURL = controlPlaneBaseURL
        self.bearerToken = bearerToken
        self.session = session
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(WebUISchemeError.invalidRequest)
            return
        }

        let channel = SchemeTaskChannel(task: urlSchemeTask, requestURL: requestURL)

        // Only the bundle host may be served or proxied: nothing else can reach
        // the control plane with the Keychain bearer attached.
        guard requestURL.host == Self.host else {
            channel.fail(WebUISchemeError.unknownHost)
            return
        }

        let path = requestURL.path.isEmpty ? "/" : requestURL.path
        guard path == "/v1" || path.hasPrefix("/v1/") else {
            // Static assets are served synchronously inside this call, so the
            // task cannot be stopped mid-flight and needs no bookkeeping.
            serveStatic(channel, path: path)
            return
        }

        // A proxied request outlives `start`; it is tracked so `stop` can cancel
        // it and so its entry is released once it completes.
        let key = ObjectIdentifier(urlSchemeTask)
        registry.store(channel: channel, for: key)
        proxyAPI(urlSchemeTask, channel: channel, key: key, requestURL: requestURL)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        let stopped = registry.stop(key)
        stopped.channel?.stop()
        stopped.task?.cancel()
        // A delegate-backed URLSession retains its delegate until it is
        // invalidated; without this every SSE reconnection leaked one session.
        stopped.streamSession?.invalidateAndCancel()
    }

    nonisolated private func release(_ key: ObjectIdentifier) {
        registry.release(key)?.finishTasksAndInvalidate()
    }

    func resolvedFileURL(for path: String) throws -> URL {
        let relative: String
        if path == "/" || path.isEmpty {
            relative = "index.html"
        } else if path.hasPrefix("/") {
            relative = String(path.dropFirst())
        } else {
            relative = path
        }

        let joined = (resourceRoot.path as NSString).appendingPathComponent(relative)
        let candidatePath = (joined as NSString).standardizingPath
        let rootPath = (resourceRoot.path as NSString).standardizingPath
        guard candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/") else {
            throw WebUISchemeError.pathEscape
        }
        let candidate = URL(fileURLWithPath: candidatePath)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return candidate
        }

        let index = resourceRoot.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else {
            throw WebUISchemeError.missingBundle
        }
        return index
    }

    // MARK: - Static UI

    private func serveStatic(_ channel: SchemeTaskChannel, path: String) {
        do {
            let fileURL = try resolvedFileURL(for: path)
            let data = try Data(contentsOf: fileURL)
            let mime = Self.mimeType(for: fileURL)
            let response = URLResponse(
                url: channel.requestURL,
                mimeType: mime,
                expectedContentLength: data.count,
                textEncodingName: mime.hasPrefix("text/") || mime.contains("javascript") || mime.contains("json")
                    ? "utf-8"
                    : nil
            )
            channel.send(response: response)
            channel.send(data: data)
            channel.finish()
        } catch WebUISchemeError.missingBundle {
            // Developer builds run before `scripts/build-macos-webui.sh`. Render
            // the instruction instead of a blank window, so the staged bundle
            // never needs a placeholder committed to the repository.
            serveMissingBundleNotice(channel)
        } catch {
            channel.fail(error)
        }
    }

    private func serveMissingBundleNotice(_ channel: SchemeTaskChannel) {
        let data = Data(Self.missingBundleHTML.utf8)
        let response = URLResponse(
            url: channel.requestURL,
            mimeType: "text/html",
            expectedContentLength: data.count,
            textEncodingName: "utf-8"
        )
        channel.send(response: response)
        channel.send(data: data)
        channel.finish()
    }

    static let missingBundleHTML = """
    <!doctype html>
    <html lang="fr"><head><meta charset="utf-8"><title>AvityOS</title>
    <style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
    background:#F7F4EE;color:#202124}
    main{min-height:100%;display:grid;place-items:center;padding:2rem}
    .card{max-width:28rem;background:rgba(255,255,255,.8);border:1px solid #fff;
    border-radius:1.25rem;padding:1.5rem;box-shadow:0 20px 80px rgba(32,33,36,.08)}
    code{font-size:.85em}
    </style></head>
    <body><main><div class="card">
    <h1>Front Figma non empaqueté</h1>
    <p>Générez l’interface Mission Control avant de lancer l’app&nbsp;:</p>
    <p><code>./scripts/build-macos-webui.sh</code></p>
    </div></main></body></html>
    """

    static func mimeType(for fileURL: URL) -> String {
        if let type = UTType(filenameExtension: fileURL.pathExtension),
           let mime = type.preferredMIMEType {
            return mime
        }
        switch fileURL.pathExtension.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "map": return "application/json"
        default: return "application/octet-stream"
        }
    }

    // MARK: - API proxy

    /// Builds the control-plane request for a proxied `/v1` scheme task.
    /// Hop-by-hop and origin headers are dropped, the encoded-body header is
    /// decoded back into a real payload, and the Keychain bearer is attached
    /// last so a page-supplied Authorization header cannot override it.
    static func proxiedRequest(
        from request: URLRequest,
        requestURL: URL,
        baseURL: URL,
        bearerToken: String?
    ) -> URLRequest? {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = requestURL.path
        components?.query = requestURL.query
        guard let target = components?.url else { return nil }

        var proxied = URLRequest(url: target)
        proxied.httpMethod = request.httpMethod ?? "GET"
        proxied.httpBody = request.httpBody
        proxied.timeoutInterval = requestURL.path.contains("/stream") ? 0 : 120

        for (key, value) in request.allHTTPHeaderFields ?? [:] {
            let lower = key.lowercased()
            if lower == "host" || lower == "origin" || lower == "referer" {
                continue
            }
            if lower == encodedBodyHeader.lowercased() {
                if let decoded = Data(base64Encoded: value) {
                    proxied.httpBody = decoded
                }
                continue
            }
            proxied.setValue(value, forHTTPHeaderField: key)
        }

        if let bearerToken, !bearerToken.isEmpty {
            proxied.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        return proxied
    }

    private func proxyAPI(
        _ urlSchemeTask: any WKURLSchemeTask,
        channel: SchemeTaskChannel,
        key: ObjectIdentifier,
        requestURL: URL
    ) {
        guard let proxied = Self.proxiedRequest(
            from: urlSchemeTask.request,
            requestURL: requestURL,
            baseURL: controlPlaneBaseURL(),
            bearerToken: bearerToken()
        ) else {
            channel.fail(WebUISchemeError.invalidRequest)
            release(key)
            return
        }

        if requestURL.path.contains("/stream") {
            let proxy = StreamProxy(channel: channel) { [weak self] in
                self?.release(key)
            }
            let streamSession = URLSession(
                configuration: .default,
                delegate: proxy,
                delegateQueue: nil
            )
            let task = streamSession.dataTask(with: proxied)
            registry.store(streamSession: streamSession, task: task, for: key)
            task.resume()
            return
        }

        let task = session.dataTask(with: proxied) { [weak self] data, response, error in
            defer { self?.release(key) }

            if let error {
                channel.fail(error)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                channel.fail(WebUISchemeError.invalidResponse)
                return
            }
            channel.complete(http: http, data: data)
        }

        registry.store(task: task, for: key)
        task.resume()
    }
}

/// Streams SSE (and other long-lived responses) into a WKURLSchemeTask.
final class StreamProxy: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let channel: SchemeTaskChannel
    private let onComplete: () -> Void

    init(channel: SchemeTaskChannel, onComplete: @escaping () -> Void) {
        self.channel = channel
        self.onComplete = onComplete
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse,
              let schemeResponse = SchemeTaskChannel.schemeResponse(
                  from: http,
                  url: channel.requestURL
              ) else {
            completionHandler(.cancel)
            channel.fail(WebUISchemeError.invalidResponse)
            onComplete()
            return
        }
        channel.send(response: schemeResponse)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        channel.send(data: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        defer { onComplete() }
        if let error {
            channel.fail(error)
            return
        }
        channel.finish()
    }
}

enum WebUISchemeError: LocalizedError, Equatable {
    case invalidRequest
    case invalidResponse
    case pathEscape
    case missingBundle
    case unknownHost

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Invalid embedded UI request"
        case .invalidResponse: return "Invalid control-plane proxy response"
        case .pathEscape: return "Refused path escape outside the WebUI bundle"
        case .unknownHost: return "Refused request outside the embedded UI host"
        case .missingBundle:
            return "Figma WebUI bundle is missing. Run scripts/build-macos-webui.sh before packaging."
        }
    }
}
