#if CELLULAR_PROBE
import Foundation

struct RemoteMP3: Decodable {
    let name, etag: String
    let bytes: Int64
    let initial, renewed: URL
}

/// One response, including failed and cancelled transactions. URLs never enter the trace.
private final class RangeFlight: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let done = DispatchSemaphore(value: 0)
    let bounds: Range<Int64>
    let media: RemoteMP3
    let tag: String
    var onFirstData: (() -> Void)?
    var firstByte: TimeInterval?
    var payload = Data()
    var received: Int64 = 0
    var measured: Int64?
    var cellular = false
    var failure: String?
    var status = 0
    init(_ bounds: Range<Int64>, _ media: RemoteMP3, tag: String) { self.bounds = bounds; self.media = media; self.tag = tag }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let h = response as? HTTPURLResponse else { failure = "non-HTTP"; completionHandler(.cancel); return }
        status = h.statusCode
        let rangeOK = status == 206 && h.value(forHTTPHeaderField: "Content-Range") ==
            "bytes \(bounds.lowerBound)-\(bounds.upperBound - 1)/\(media.bytes)"
        let wholeOK = status == 200 && bounds == 0..<media.bytes
        guard (rangeOK || wholeOK), h.expectedContentLength == bounds.count,
              h.value(forHTTPHeaderField: "ETag") == tag else {
            failure = "invalid HTTP \(status) range/length/version"; completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if firstByte == nil {
            firstByte = ProcessInfo.processInfo.systemUptime
            onFirstData?()
        }
        received += Int64(data.count)
        if received > bounds.count { failure = "response overrun"; dataTask.cancel(); return }
        payload.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let transactions = metrics.transactionMetrics
        if !transactions.isEmpty {
            measured = transactions.reduce(0) { $0 + $1.countOfResponseBodyBytesReceived }
            cellular = transactions.contains { $0.isCellular }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil, let error { failure = "transport \((error as NSError).code)" }
        done.signal()
    }
}

/// One serial decoder worker owns the block map. Cancellation can arrive from the UI
/// during a synchronous AudioFile read; callers drain that worker before starting a replacement.
final class MeteredSource: @unchecked Sendable {
    static let limit: Int64 = 4_000_000
    static let block = 65536
    let media: RemoteMP3
    let number: Int
    let trace: (String) -> Void
    private let session: URLSession
    private let state = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false
    private var speculative: Bool
    private var renewed = false
    private var charged: Int64 = 0
    private var blocks: [Int:Data] = [:]
    var onFirstBlockData: (() -> Void)?
    private(set) var firstByteTime: TimeInterval?
    var specBytes: Int64 { state.withLock { charged } }

    init(_ media: RemoteMP3, number: Int, speculative: Bool, trace: @escaping (String) -> Void) throws {
        // The command-line transport controls use an in-process loopback HTTP fixture.
        let validLocation: (URL) -> Bool = { url in
            #if RANGE_TRANSPORT_TEST && os(macOS)
            if url.scheme == "http", url.host == "127.0.0.1" { return true }
            #endif
            return url.scheme == "https" && url.host != nil
        }
        guard media.bytes > 0, !media.etag.isEmpty, !media.etag.hasPrefix("W/"),
              [media.initial,media.renewed].allSatisfy(validLocation) else { throw ProbeError("Invalid fixture manifest") }
        self.media = media; self.number = number; self.speculative = speculative; self.trace = trace
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil; config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config)
    }
    deinit { session.invalidateAndCancel() }

    func cancel() {
        state.withLock { cancelled = true; task?.cancel() }
    }

    /// The old capability is unusable from this instant. Only finishRenewal admits new reads.
    func promote() { state.withLock { speculative = false }; trace("promote item=\(number) specBytes=\(specBytes)") }
    func finishRenewal() { state.withLock { renewed = true } }

    func read(_ offset: Int64, _ count: Int) throws -> Data {
        var result = Data()
        while result.count < count {
            if state.withLock({ cancelled }) { throw CancellationError() }
            let position = Int(offset) + result.count
            let key = position / Self.block
            let lo = key * Self.block
            let hi = min(lo + Self.block, Int(media.bytes))
            guard hi > position else { throw ProbeError("Decoder read outside object") }
            if blocks[key] == nil {
                blocks[key] = try fetch(Int64(lo)..<Int64(hi))
            }
            let take = min(count-result.count, hi-position)
            result.append(blocks[key]![(position-lo)..<(position-lo+take)])
        }
        return result
    }

    private let began = ProcessInfo.processInfo.systemUptime
    private func fetch(_ bounds: Range<Int64>) throws -> Data {
        for attempt in 1...2 {
            let flight = RangeFlight(bounds, media, tag: media.etag)
            flight.onFirstData = onFirstBlockData
            onFirstBlockData = nil
            let (request, spec): (URLSessionDataTask,Bool) = try state.withLock {
                if cancelled { throw CancellationError() }
                let spec = speculative
                if spec && charged + Int64(bounds.count) > Self.limit { throw ProbeError("Speculation budget exhausted") }
                if !spec && !renewed && number != 0 { throw ProbeError("Expired URL blocked") }
                var r = URLRequest(url: renewed ? media.renewed : media.initial)
                r.setValue("bytes=\(bounds.lowerBound)-\(bounds.upperBound-1)", forHTTPHeaderField: "Range")
                r.setValue(media.etag, forHTTPHeaderField: "If-Match")
                r.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                let t = session.dataTask(with: r)
                t.delegate = flight; task = t
                // The single worker admits exactly one range at a time; its full length is reserved until metrics arrive.
                t.resume()
                return (t,spec)
            }
            flight.done.wait()
            let actual = max(flight.measured ?? 0, flight.received, request.countOfBytesReceived)
            let total: Int64 = state.withLock { task = nil; if spec { charged += actual }; return charged }
            if let firstByte = flight.firstByte, firstByteTime == nil {
                firstByteTime = firstByte
                trace("first body item=\(number) elapsed=\(firstByteTime!-began)")
            }
            trace("range item=\(number) offset=\(bounds.lowerBound) length=\(bounds.count) http=\(flight.status) delivered=\(flight.received) wire=\(flight.measured ?? -1) spec=\(spec) charged=\(total) cell=\(flight.cellular) attempt=\(attempt)")
            guard total <= Self.limit else { throw ProbeError("Speculative cap exceeded: \(total)") }
            guard let measured = flight.measured, measured >= flight.received else { throw ProbeError("Unmeasured network body") }
            if state.withLock({ cancelled }) { throw CancellationError() }
            if let failure = flight.failure {
                if attempt == 1 && (flight.status == 503 || (flight.status == 0 && measured == 0)) { continue }
                throw ProbeError(failure)
            }
            guard flight.payload.count == bounds.count else { throw ProbeError("Incomplete media range") }
            return flight.payload
        }
        throw ProbeError("Range retry exhausted")
    }
}
#endif
