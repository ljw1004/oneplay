import Foundation

/// Graph's version and size identify the recording independently of the CDN capability.
struct MediaLocation: Sendable {
    let url: URL
    let etag: String
    let size: Int64
}

struct PlaybackError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Delegate calls are serial. Completion publishes the final body and transaction metrics to the decoder worker.
private final class RangeResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let done = DispatchSemaphore(value: 0)
    let bounds: Range<Int64>
    let size: Int64
    let expectedCDNTag: String?
    let onFirstData: (() -> Void)?
    var body = Data()
    var received: Int64 = 0
    var wireBytes: Int64?
    var cellular = false
    var firstByte: TimeInterval?
    var responseTag: String?
    var redirect: URL?
    var networkLost = false
    var expectedBytes: Int64 = -1
    var status = 0
    var failure: String?

    init(_ bounds: Range<Int64>, size: Int64, tag: String?, onFirstData: (() -> Void)?) {
        self.bounds = bounds
        self.size = size
        self.expectedCDNTag = tag
        self.onFirstData = onFirstData
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            failure = "Non-HTTP media response"; completionHandler(.cancel); return
        }
        status = http.statusCode
        expectedBytes = http.expectedContentLength
        if [301,302,303,307,308].contains(status), let raw = http.value(forHTTPHeaderField: "Location") {
            redirect = URL(string: raw, relativeTo: http.url)?.absoluteURL
        }
        responseTag = http.value(forHTTPHeaderField: "ETag")
        let partial = status == 206 && http.value(forHTTPHeaderField: "Content-Range") ==
            "bytes \(bounds.lowerBound)-\(bounds.upperBound - 1)/\(size)"
        let whole = status == 200 && bounds == 0..<size
        guard partial || whole, http.expectedContentLength == bounds.count,
              expectedCDNTag == nil || expectedCDNTag == responseTag else {
            failure = "Invalid media range, length or version (HTTP \(status))"
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if received == 0 { firstByte = ProcessInfo.processInfo.systemUptime; onFirstData?() }
        received += Int64(data.count)
        guard received <= bounds.count else { failure = "Media range overrun"; dataTask.cancel(); return }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let transactions = metrics.transactionMetrics
        guard !transactions.isEmpty else { return }
        wireBytes = transactions.reduce(0) { $0 + $1.countOfResponseBodyBytesReceived }
        cellular = transactions.contains { $0.isCellular }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil, let error {
            let fault = error as NSError
            networkLost = fault.domain == NSURLErrorDomain && [
                NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
                NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed
            ].contains(fault.code)
            failure = "Media transport error \(fault.code)"
        }
        done.signal()
    }
}

/// Core Audio owns one serial reader per occurrence. Cancellation alone may enter from another thread.
/// Keep all speculative blocks through promotion, and a bounded working set for the playing item.
final class MediaRanges: @unchecked Sendable {
    static let limit: Int64 = 4_000_000
    static let block = 65_536
    // An ignored Range can put bytes in socket/TLS buffers before URLSession can reject the headers.
    // Keep 2 MiB of the 4 MB cap for that final cancellation. Transaction metrics settle each attempt.
    // An arbitrary peer can exceed even this reserve; verified CDN behavior is part of the cellular gate.
    static let cancellationReserve: Int64 = 2 * 1_024 * 1_024
    private let original: MediaLocation
    private var location: MediaLocation?
    private let session: URLSession
    private let lock = NSLock()
    private var cancelled = false
    private let stopBackoff = DispatchSemaphore(value: 0)
    private var task: URLSessionDataTask?
    private(set) var speculative: Bool
    private(set) var specBytes: Int64 = 0
    private var prefix = [Int64: Data]()
    private var demand = [Int64: Data]()
    private var demandOrder = [Int64]()
    private let began = ProcessInfo.processInfo.systemUptime
    private var reportedFirstByte = false
    // HTTP validators belong to a resource URL. Graph's eTag and size bind the decoder across URLs.
    private var cdnValidator: (url: URL, tag: String)?
    private let trace: (String) -> Void
    private let diagnostic: (String) -> Void
    private let renew: (() throws -> MediaLocation)?
    private let awaitDemand: (() throws -> Void)?
    var onFirstBlockData: (() -> Void)?

    init(_ location: MediaLocation, speculative: Bool, trace: @escaping (String) -> Void,
         diagnostic: @escaping (String) -> Void = { _ in }, awaitDemand: (() throws -> Void)? = nil, renew: (() throws -> MediaLocation)? = nil) throws {
        guard location.size > 0, !location.etag.isEmpty, Self.allowed(location.url) else {
            throw PlaybackError("Invalid media metadata")
        }
        self.original = location
        self.location = location
        self.speculative = speculative
        self.trace = trace
        self.diagnostic = diagnostic
        self.renew = renew
        self.awaitDemand = awaitDemand
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.httpCookieStorage = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config)
    }

    private static func allowed(_ url: URL) -> Bool {
        #if RANGE_TRANSPORT_TEST && (os(macOS) || targetEnvironment(simulator))
        if url.scheme == "http", url.host == "127.0.0.1" { return true }
        #endif
        return url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil
    }

    deinit { session.invalidateAndCancel() }

    func cancel() { lock.withLock { cancelled = true; task?.cancel(); stopBackoff.signal() } }

    /// Buffered compressed data remains usable. Every miss now requires a freshly validated URL.
    func promote() { speculative = false; location = nil }

    /// Mismatch is terminal for this decoder. Its cursor and previously queued PCM belong to the old version.
    func installRenewal(_ fresh: MediaLocation) throws {
        guard fresh.size == original.size, fresh.etag == original.etag, Self.allowed(fresh.url) else {
            throw PlaybackError("Recording changed during playback")
        }
        location = fresh
        diagnostic("Renewed media URL validated")
    }

    func read(_ offset: Int64, _ count: Int) throws -> Data {
        guard offset >= 0, count >= 0, offset <= original.size, Int64(count) <= original.size-offset else {
            throw PlaybackError("Decoder read outside recording")
        }
        var result = Data()
        while result.count < count {
            if lock.withLock({ cancelled }) { throw CancellationError() }
            let position = offset + Int64(result.count)
            let base = position - position % Int64(Self.block)
            let length = min(original.size-base, Int64(Self.block))
            let block: Data
            if let cached = prefix[base] ?? demand[base] {
                block = cached
            } else {
                block = try fetch(base..<(base+length))
                if speculative {
                    prefix[base] = block
                } else {
                    if demandOrder.count == 8 { demand.removeValue(forKey: demandOrder.removeFirst()) }
                    demandOrder.append(base)
                    demand[base] = block
                }
            }
            let from = Int(position-base)
            let take = min(count-result.count, block.count-from)
            result.append(block[from..<(from+take)])
        }
        return result
    }

    /// Each attempt reserves its full block before dispatch and settles all received bytes before another attempt.
    private func fetch(_ bounds: Range<Int64>) throws -> Data {
        var retriedLocation = false
        var redirects = 0
        while true {
            if speculative && Int64(bounds.count) + Self.cancellationReserve > Self.limit-specBytes {
                // A large tag can consume the speculative allowance before the first PCM. Wait for the
                // preceding recording to finish, then resume this exact callback with the cached blocks intact.
                guard let awaitDemand, let renew else { throw PlaybackError("Speculation budget exhausted") }
                try awaitDemand()
                promote()
                diagnostic("Speculation budget reached; renewing media URL for playback")
                try installRenewal(renew())
            }
            guard let location else { throw PlaybackError("Expired URL blocked") }
            let cdnTag = cdnValidator?.url == location.url ? cdnValidator?.tag : nil
            let response = RangeResponse(bounds, size: original.size, tag: cdnTag, onFirstData: onFirstBlockData)
            onFirstBlockData = nil
            var request = URLRequest(url: location.url)
            request.setValue("bytes=\(bounds.lowerBound)-\(bounds.upperBound-1)", forHTTPHeaderField: "Range")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            // Graph and the CDN can use different validators. Only send a strong tag observed on this CDN object.
            if let cdnTag, !cdnTag.hasPrefix("W/") { request.setValue(cdnTag, forHTTPHeaderField: "If-Match") }
            let active = try lock.withLock {
                if cancelled { throw CancellationError() }
                let active = session.dataTask(with: request)
                active.delegate = response
                task = active
                active.resume()
                return active
            }
            response.done.wait()
            let actual = max(response.wireBytes ?? 0, response.received, active.countOfBytesReceived)
            if speculative { specBytes += actual }
            if !reportedFirstByte, let time = response.firstByte {
                reportedFirstByte = true
                trace("first body elapsed=\(time-began)")
            }
            trace("offset=\(bounds.lowerBound) length=\(bounds.count) http=\(response.status) wire=\(actual) spec=\(speculative) charged=\(specBytes) cell=\(response.cellular)")
            if lock.withLock({ task = nil; return cancelled }) { throw CancellationError() }
            if speculative {
                guard specBytes <= Self.limit else { throw PlaybackError("Speculative cap exceeded") }
                guard let measured = response.wireBytes, measured >= response.received else { throw PlaybackError("Unmeasured speculative body") }
            }
            if speculative, response.expectedBytes > Int64(bounds.count) {
                throw PlaybackError("Oversized speculative response (HTTP \(response.status))")
            }
            // Follow each HTTPS redirect as a separate credential-free range. Charge its body before
            // reserving the next attempt, since both transactions count against the same speculative item.
            if let redirect = response.redirect, Self.allowed(redirect), redirects < 3 {
                redirects += 1
                self.location = MediaLocation(url: redirect, etag: original.etag, size: original.size)
                continue
            }
            if let failure = response.failure {
                if [401,403,404,410].contains(response.status), !retriedLocation, let renew {
                    diagnostic("HTTP \(response.status); renewing media URL at offset \(bounds.lowerBound)")
                    retriedLocation = true
                    try installRenewal(renew())
                    continue
                }
                if response.networkLost || [408,429,500,502,503,504].contains(response.status) {
                    // The decoder has received none of this range. Retry that same offset, charging every
                    // attempt. A cancelled wait exits via the admission check before issuing another request.
                    if stopBackoff.wait(timeout: .now() + 2) == .success { throw CancellationError() }
                    continue
                }
                throw PlaybackError(failure)
            }
            guard response.body.count == bounds.count else { throw PlaybackError("Incomplete media range") }
            if retriedLocation { diagnostic("Renewed media URL returned HTTP \(response.status) at offset \(bounds.lowerBound)") }
            cdnValidator = response.responseTag.map { (location.url, $0) }
            return response.body
        }
    }
}
