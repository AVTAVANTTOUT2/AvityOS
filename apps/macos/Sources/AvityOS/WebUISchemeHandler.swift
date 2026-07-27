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

/// Forwards scheme-task callbacks from @Sendable URLSession closures.
private final class SchemeTaskForwarder: @unchecked Sendable {
    private let task: any WKURLSchemeTask
    private let requestURL: URL

    init(task: any WKURLSchemeTask, requestURL: URL) {
        self.task = task
        self.requestURL = requestURL
    }

    func fail(_ error: Error) {
        task.didFailWithError(error)
    }

    func complete(http: HTTPURLResponse, data: Data?) {
        let filtered = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let header = entry.key as? String else { return }
            let lower = header.lowercased()
            if lower.hasPrefix("access-control-") || lower == "transfer-encoding" {
                return
            }
            result[header] = String(describing: entry.value)
        }
        guard let schemeResponse = HTTPURLResponse(
            url: requestURL,
            statusCode: http.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: filtered
        ) else {
            task.didFailWithError(WebUISchemeError.invalidResponse)
            return
        }
        task.didReceive(schemeResponse)
        if let data, !data.isEmpty {
            task.didReceive(data)
        }
        task.didFinish()
    }
}

/// Serves the bundled Figma Mission Control UI and proxies `/v1` to the
/// control plane with the Keychain bearer. SSE routes stream incrementally.
final class WebUISchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    static let scheme = "avity-app"
    static let host = "ui"

    private let resourceRoot: URL
    private let controlPlaneBaseURL: () -> URL
    private let bearerToken: () -> String?
    private let session: URLSession
    private let lock = NSLock()
    private var tasks: [ObjectIdentifier: URLSessionTask] = [:]
    private var streamDelegates: [ObjectIdentifier: StreamProxy] = [:]

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

        let path = requestURL.path.isEmpty ? "/" : requestURL.path
        if path == "/v1" || path.hasPrefix("/v1/") {
            proxyAPI(urlSchemeTask, requestURL: requestURL)
            return
        }

        serveStatic(urlSchemeTask, path: path)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        lock.lock()
        let task = tasks.removeValue(forKey: key)
        streamDelegates.removeValue(forKey: key)
        lock.unlock()
        task?.cancel()
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

    private func serveStatic(_ urlSchemeTask: any WKURLSchemeTask, path: String) {
        do {
            let fileURL = try resolvedFileURL(for: path)
            let data = try Data(contentsOf: fileURL)
            let mime = Self.mimeType(for: fileURL)
            let response = URLResponse(
                url: urlSchemeTask.request.url ?? fileURL,
                mimeType: mime,
                expectedContentLength: data.count,
                textEncodingName: mime.hasPrefix("text/") || mime.contains("javascript") || mime.contains("json")
                    ? "utf-8"
                    : nil
            )
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

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

    private func proxyAPI(_ urlSchemeTask: any WKURLSchemeTask, requestURL: URL) {
        let base = controlPlaneBaseURL()
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = requestURL.path
        components?.query = requestURL.query
        guard let target = components?.url else {
            urlSchemeTask.didFailWithError(WebUISchemeError.invalidRequest)
            return
        }

        var proxied = URLRequest(url: target)
        proxied.httpMethod = urlSchemeTask.request.httpMethod ?? "GET"
        proxied.httpBody = urlSchemeTask.request.httpBody
        proxied.timeoutInterval = requestURL.path.contains("/stream") ? 0 : 120
        if let headers = urlSchemeTask.request.allHTTPHeaderFields {
            for (key, value) in headers {
                let lower = key.lowercased()
                if lower == "host" || lower == "origin" || lower == "referer" {
                    continue
                }
                proxied.setValue(value, forHTTPHeaderField: key)
            }
        }
        if let token = bearerToken(), !token.isEmpty {
            proxied.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let key = ObjectIdentifier(urlSchemeTask)
        if requestURL.path.contains("/stream") {
            let proxy = StreamProxy(schemeTask: urlSchemeTask, requestURL: requestURL) { [weak self] in
                self?.lock.lock()
                self?.tasks.removeValue(forKey: key)
                self?.streamDelegates.removeValue(forKey: key)
                self?.lock.unlock()
            }
            let streamSession = URLSession(
                configuration: .default,
                delegate: proxy,
                delegateQueue: nil
            )
            let task = streamSession.dataTask(with: proxied)
            lock.lock()
            tasks[key] = task
            streamDelegates[key] = proxy
            lock.unlock()
            task.resume()
            return
        }

        let forwarder = SchemeTaskForwarder(task: urlSchemeTask, requestURL: requestURL)
        let task = session.dataTask(with: proxied) { [weak self] data, response, error in
            guard let self else { return }
            self.lock.lock()
            self.tasks.removeValue(forKey: key)
            self.lock.unlock()

            if let error {
                forwarder.fail(error)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                forwarder.fail(WebUISchemeError.invalidResponse)
                return
            }
            forwarder.complete(http: http, data: data)
        }

        lock.lock()
        tasks[key] = task
        lock.unlock()
        task.resume()
    }
}

/// Streams SSE (and other long-lived responses) into a WKURLSchemeTask.
final class StreamProxy: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let schemeTask: any WKURLSchemeTask
    private let requestURL: URL
    private let onComplete: () -> Void
    private var didSendResponse = false

    init(
        schemeTask: any WKURLSchemeTask,
        requestURL: URL,
        onComplete: @escaping () -> Void
    ) {
        self.schemeTask = schemeTask
        self.requestURL = requestURL
        self.onComplete = onComplete
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            schemeTask.didFailWithError(WebUISchemeError.invalidResponse)
            onComplete()
            return
        }
        let filtered = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let header = entry.key as? String else { return }
            let lower = header.lowercased()
            if lower.hasPrefix("access-control-") || lower == "transfer-encoding" {
                return
            }
            result[header] = String(describing: entry.value)
        }
        if let schemeResponse = HTTPURLResponse(
            url: requestURL,
            statusCode: http.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: filtered
        ) {
            schemeTask.didReceive(schemeResponse)
            didSendResponse = true
            completionHandler(.allow)
        } else {
            completionHandler(.cancel)
            schemeTask.didFailWithError(WebUISchemeError.invalidResponse)
            onComplete()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if !data.isEmpty {
            schemeTask.didReceive(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        defer { onComplete() }
        if let error {
            if didSendResponse {
                schemeTask.didFailWithError(error)
            } else {
                schemeTask.didFailWithError(error)
            }
            return
        }
        schemeTask.didFinish()
    }
}

enum WebUISchemeError: LocalizedError, Equatable {
    case invalidRequest
    case invalidResponse
    case pathEscape
    case missingBundle

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Invalid embedded UI request"
        case .invalidResponse: return "Invalid control-plane proxy response"
        case .pathEscape: return "Refused path escape outside the WebUI bundle"
        case .missingBundle:
            return "Figma WebUI bundle is missing. Run scripts/build-macos-webui.sh before packaging."
        }
    }
}
