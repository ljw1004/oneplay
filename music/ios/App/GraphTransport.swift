import Foundation
import OSLog

/// Only the Graph v1 endpoint can receive the bearer. A content redirect is a new credential-free GET.
final class GraphTransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let chunkSize = 256 * 1024
    let session: URLSession

    override init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        session = URLSession(configuration: config)
        super.init()
    }

    static func isHTTPS(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil && url.user == nil &&
            url.password == nil && url.fragment == nil && (url.port == nil || url.port == 443)
    }

    static func isGraph(_ url: URL) -> Bool {
        guard isHTTPS(url), url.host?.lowercased() == "graph.microsoft.com",
              let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
        else { return false }
        // Foundation and the origin must agree on the version prefix after normalization.
        guard let decoded = path.removingPercentEncoding, decoded.hasPrefix("/v1.0/"),
              !decoded.contains("\\"), !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
        else { return false }
        return path.hasPrefix("/v1.0/")
    }

    /// Graph-to-Graph redirects preserve the request. For a foreign origin rebuild only a read:
    /// neither a caller's body nor any credential-bearing header may travel to the content host.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest proposed: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = proposed.url, Self.isHTTPS(url) else { completionHandler(nil); return }
        if Self.isGraph(url), response.url.map(Self.isGraph) == true {
            var sameOrigin = proposed
            if task.originalRequest?.allowsCellularAccess == false { sameOrigin.requireUnmeteredWiFi() }
            sameOrigin.setValue(task.currentRequest?.value(forHTTPHeaderField: "Authorization"), forHTTPHeaderField: "Authorization")
            completionHandler(sameOrigin)
            return
        }
        guard ["GET", "HEAD"].contains(proposed.httpMethod ?? "GET") else { completionHandler(nil); return }
        var read = URLRequest(url: url, cachePolicy: proposed.cachePolicy, timeoutInterval: proposed.timeoutInterval)
        if task.originalRequest?.allowsCellularAccess == false { read.requireUnmeteredWiFi() }
        read.httpMethod = proposed.httpMethod
        completionHandler(read)
    }

    /// Only operation names and transaction timings are public. Graph redirects can contain signed credentials.
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        guard let url = task.originalRequest?.url, Self.isGraph(url) else { return }
        let operation: String
        if url.path == "/v1.0/me/drive" { operation = "GET /me/drive" }
        else if url.query == "$select=@microsoft.graph.downloadUrl" { operation = "GET /drives/{drive}/items/{item}?$select=@microsoft.graph.downloadUrl" }
        else { return }
        for transaction in metrics.transactionMetrics {
            guard let start = transaction.fetchStartDate, let end = transaction.responseEndDate else { continue }
            let status = (transaction.response as? HTTPURLResponse)?.statusCode ?? 0
            let ms = Int(end.timeIntervalSince(start) * 1000)
            Logger(subsystem: "me.unto.oneplay.music", category: "Playback").info("Graph \(operation, privacy: .public) http=\(status) durationMs=\(ms)")
        }
    }

    /// Foundation owns the download file until this call returns. Unlink it after opening:
    /// the open descriptor gives bounded reads and the OS reclaims it even after a process kill.
    func download(_ request: URLRequest) async throws -> (HTTPURLResponse, FileHandle) {
        let (file, response) = try await session.download(for: request, delegate: self)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let http = response as? HTTPURLResponse else { throw NativeAccountError.unavailable }
        return (http, try FileHandle(forReadingFrom: file))
    }

    /// Graph v1 batch redirects are capabilities. Only a top-level subresponse header
    /// can grant a follow, never a location inside a user-controlled JSON document.
    static func contentLocations(in file: FileHandle) throws -> [String] {
        defer { try? file.seek(toOffset: 0) }
        struct Batch: Decodable {
            struct Response: Decodable { let status: Int; let headers: [String: String]? }
            let responses: [Response]
        }
        let data = try file.readToEnd() ?? Data()
        guard let batch = try? JSONDecoder().decode(Batch.self, from: data) else { return [] }
        return batch.responses.compactMap { part in
            guard part.status == 302, let raw = part.headers?.first(where: {
                $0.key.caseInsensitiveCompare("Location") == .orderedSame
            })?.value, let url = URL(string: raw), isHTTPS(url) else { return nil }
            return raw
        }
    }
}
