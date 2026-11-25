import Foundation

extension URLRequest {
    mutating func requireUnmeteredWiFi() {
        allowsExpensiveNetworkAccess = false
        allowsConstrainedNetworkAccess = false
        allowsCellularAccess = false
    }
}

/// Graph's version and size identify the recording independently of the CDN capability.
final class MediaLocation: @unchecked Sendable {
    // Readers reopening the same signed resource share its HTTP validator, including across seeks.
    private let lock = NSLock()
    private var denied = false
    var accessDenied: Bool { lock.withLock { denied } }
    func markAccessDenied() { lock.withLock { denied = true } }
    private var rejected = false
    var isRejected: Bool { lock.withLock { rejected } }
    fileprivate func markRejected() { lock.withLock { rejected = true } }
    private var validators = [URL: String]()

    init(url: URL, etag: String, size: Int64) {
        self.url = url
        self.etag = etag
        self.size = size
    }

    fileprivate func validator(for resource: URL) -> String? {
        lock.withLock { validators[resource] }
    }

    fileprivate func acceptValidator(_ tag: String?, for resource: URL) -> Bool {
        lock.withLock {
            if let prior = validators[resource] { return prior == tag }
            validators[resource] = tag
            return true
        }
    }

    let url: URL
    let etag: String
    let size: Int64
}

struct PlaybackError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// One pool per signed-in player. The session owns HTTP connection reuse across requests and decoder lifetimes.
final class MediaPool: @unchecked Sendable {
    struct File: Hashable {
        let drive: String, item: String, version: String
        let size: Int64
    }
    private struct Block: Hashable { let file: File; let offset: Int64 }
    private let lock = NSLock()
    private var blocks = [Block: (data: Data, used: UInt64)]()
    private var clock: UInt64 = 0
    private var bytes = 0
    private let capacity: Int
    let session: URLSession
    let unmeteredWiFi: @Sendable () -> Bool

    init(capacity: Int = 40_000_000, configuration: URLSessionConfiguration = .ephemeral, unmeteredWiFi: @escaping @Sendable () -> Bool = { false }) {
        self.unmeteredWiFi = unmeteredWiFi
        self.capacity = capacity
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }

    deinit { session.invalidateAndCancel() }

    /// Stop an already admitted wide read if Wi-Fi becomes metered, including Low Data Mode in place.
    func cancelWiFiReadsIfMetered() {
        guard !unmeteredWiFi() else { return }
        session.getAllTasks { [unmeteredWiFi] tasks in
            guard !unmeteredWiFi() else { return }
            for task in tasks where task.originalRequest?.allowsCellularAccess == false { task.cancel() }
        }
    }

    func read(_ file: File, at offset: Int64) -> Data? {
        lock.withLock {
            let key = Block(file: file, offset: offset)
            guard let block = blocks[key] else { return nil }
            clock += 1
            blocks[key]?.used = clock
            return block.data
        }
    }

    /// A UI hint while Graph confirms the version. Decoder reads always use the full versioned key.
    func hasCachedAudio(drive: String, item: String) -> Bool {
        lock.withLock { blocks.keys.contains { $0.file.drive == drive && $0.file.item == item } }
    }

    /// Complete, aligned blocks only. An immutable Data returned to a decoder survives eviction.
    func store(_ data: Data, for file: File, at offset: Int64) {
        lock.withLock {
            let key = Block(file: file, offset: offset)
            guard blocks[key] == nil, data.count <= capacity else { return }
            while bytes + data.count > capacity || blocks.count >= max(1, capacity / MediaRanges.block), let oldest = blocks.min(by: { $0.value.used < $1.value.used }) {
                bytes -= oldest.value.data.count
                blocks.removeValue(forKey: oldest.key)
            }
            clock += 1
            blocks[key] = (data, clock)
            bytes += data.count
        }
    }

    /// Find just the first hole in an aligned window. Inspecting residency does not affect LRU order.
    func firstGap(_ file: File, in bounds: Range<Int64>) -> Range<Int64>? {
        lock.withLock {
            var start = bounds.lowerBound
            while start < bounds.upperBound && blocks[Block(file: file, offset: start)] != nil {
                start += Int64(MediaRanges.block)
            }
            guard start < bounds.upperBound else { return nil }
            var end = start + Int64(MediaRanges.block)
            while end < bounds.upperBound && blocks[Block(file: file, offset: end)] == nil {
                end += Int64(MediaRanges.block)
            }
            return start..<min(end, bounds.upperBound)
        }
    }

    #if DEBUG
    private var requests = [UUID: (File, Range<Int64>)]()

    func setDebugRequest(_ id: UUID, _ request: (File, Range<Int64>)?) {
        lock.withLock { requests[id] = request }
    }

    /// Byte offsets are half-open. Merge adjacent cached blocks but preserve individual live GETs.
    func debugRanges(drive: String, item: String, admitted: File? = nil) -> [String: Any] {
        lock.withLock {
            let matches: (File) -> Bool = { $0.drive == drive && $0.item == item }
            let active = requests.values.filter { matches($0.0) }
            let cached = blocks.keys.filter { matches($0.file) }.sorted { $0.offset < $1.offset }
            guard let file = admitted ?? active.first?.0 ?? cached.first?.file else { return [:] }
            var ranges = [[Int64]]()
            for key in cached where key.file == file {
                let end = min(file.size, key.offset + Int64(MediaRanges.block))
                if ranges.last?.last == key.offset { ranges[ranges.count-1][1] = end }
                else { ranges.append([key.offset, end]) }
            }
            return ["size": file.size, "cached": ranges,
                    "fetching": active.filter { $0.0 == file }.map { [$0.1.lowerBound, $0.1.upperBound] }]
        }
    }
    #endif

    /// A denied lookup invalidates this item. A successful lookup keeps its matching version.
    func discard(drive: String, item: String, keeping admitted: File? = nil) {
        lock.withLock {
            for key in blocks.keys where key.file.drive == drive && key.file.item == item && key.file != admitted {
                if let removed = blocks.removeValue(forKey: key) { bytes -= removed.data.count }
            }
        }
    }

    func clear() { lock.withLock { blocks.removeAll(); bytes = 0 } }
}

/// Delegate calls are serial. Completion publishes the final body and transaction metrics to the decoder worker.
private final class RangeResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let done = DispatchSemaphore(value: 0)
    let bounds: Range<Int64>
    let size: Int64
    var acceptTag: ((String?) -> Bool)?
    var publish: ((Int64, Data) -> Void)?
    var onComplete: ((RangeResponse, URLSessionTask) -> Void)?
    private let progress = NSCondition()
    private var published: Int64
    private var finished = false

    /// A failed or cancelled task wakes readers even if its next block never arrived.
    func waitForBlock(endingAt end: Int64) {
        progress.lock()
        while published < end && !finished { progress.wait() }
        progress.unlock()
    }

    var isFinished: Bool { progress.lock(); defer { progress.unlock() }; return finished }
    var availableEnd: Int64 { progress.lock(); defer { progress.unlock() }; return published }
    let onFirstData: (() -> Void)?
    var body = Data()
    var received: Int64 = 0
    var wireBytes: Int64?
    var elapsedMs: Int?
    var firstResponseMs: Int?
    var transport = "unknown"
    var reusedConnection: Bool?
    var cellular = false
    var firstByte: TimeInterval?
    // HTTP 412/416 also mean the signed resource no longer satisfies this file's range contract.
    var rejectsResource: Bool { [401,403,404,410,412,416].contains(status) || changedResource }
    private var changedResource = false
    var responseTag: String?
    var redirect: URL?
    var networkLost = false
    var transportCancelled = false
    var expectedBytes: Int64 = -1
    var status = 0
    var failure: String?

    init(_ bounds: Range<Int64>, size: Int64, onFirstData: (() -> Void)?) {
        self.bounds = bounds
        self.size = size
        self.published = bounds.lowerBound
        self.onFirstData = onFirstData
    }

    /// Metrics contain protocol and reuse evidence without the signed resource URL.
    func metricsLine(bytes: Int64, speculative: Bool, charged: Int64) -> String {
        "offset=\(bounds.lowerBound) length=\(bounds.count) http=\(status) wire=\(bytes) spec=\(speculative) charged=\(charged) cell=\(cellular) durationMs=\(elapsedMs ?? -1) firstResponseMs=\(firstResponseMs ?? -1) protocol=\(transport) reused=\(reusedConnection.map(String.init) ?? "unknown")"
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
        let interval = "bytes \(bounds.lowerBound)-\(bounds.upperBound - 1)/"
        let range = http.value(forHTTPHeaderField: "Content-Range")
        let partial = status == 206 && range == interval + String(size)
        if status == 206, let range, range.hasPrefix(interval),
           let total = Int64(range.dropFirst(interval.count)), total >= bounds.upperBound, total != size {
            changedResource = true
        }
        let whole = status == 200 && bounds == 0..<size
        if whole && expectedBytes >= 0 && expectedBytes != size { changedResource = true }
        if (partial || whole) && expectedBytes == bounds.count { changedResource = acceptTag?(responseTag) == false }
        guard partial || whole, http.expectedContentLength == bounds.count, !changedResource else {
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
        guard let publish else { body.append(data); return }
        // Delivery fragments do not have to align to either HTTP ranges or cache blocks.
        var cursor = data.startIndex
        while cursor < data.endIndex {
            let n = min(MediaRanges.block - body.count, data.endIndex - cursor)
            body.append(data[cursor..<cursor+n])
            cursor += n
            if body.count == MediaRanges.block || (cursor == data.endIndex && received == bounds.count) {
                let start = published
                publish(start, body)
                progress.lock()
                published += Int64(body.count)
                progress.broadcast()
                progress.unlock()
                body = Data()
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        elapsedMs = Int(metrics.taskInterval.duration * 1000)
        let transactions = metrics.transactionMetrics
        guard !transactions.isEmpty else { return }
        if let last = transactions.last {
            transport = last.networkProtocolName ?? "unknown"
            reusedConnection = last.isReusedConnection
            if let first = last.responseStartDate {
                firstResponseMs = Int(first.timeIntervalSince(metrics.taskInterval.start) * 1000)
            }
        }
        wireBytes = transactions.reduce(0) { $0 + $1.countOfResponseBodyBytesReceived }
        cellular = transactions.contains { $0.isCellular }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil, let error {
            let fault = error as NSError
            transportCancelled = fault.domain == NSURLErrorDomain && fault.code == NSURLErrorCancelled
            networkLost = fault.domain == NSURLErrorDomain && [
                NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
                NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed, NSURLErrorDataNotAllowed
            ].contains(fault.code)
            failure = "Media transport error \(fault.code)"
        }
        onComplete?(self, task)
        progress.lock()
        finished = true
        progress.broadcast()
        progress.unlock()
        done.signal()
    }
}

/// Core Audio owns one serial reader per occurrence. Cancellation alone may enter from another thread.
/// The account pool retains aligned compressed bytes across decoder lifetimes.
final class MediaRanges: @unchecked Sendable {
    /// Only the serially admitted preparation worker charges the queue. Reopening its decoder after
    /// a seek retains the charge for that occurrence, including bytes from cancelled requests.
    final class Budget {
        fileprivate var charged = [Int: Int64]()
    }
    /// The decoder can park beyond the early prefix for an entire audiobook. Scheduling
    /// another chunk, reaching the join, or retiring the worker wakes it without polling.
    final class SuccessorWindow {
        let prefix: () -> Int64
        let changed = DispatchSemaphore(value: 0)
        private let join = DispatchGroup()
        init(prefix: @escaping () -> Int64) { self.prefix = prefix; join.enter() }
        var early: Bool { join.wait(timeout: .now()) == .timedOut }
        func releaseAtJoin() { join.leave(); changed.signal() }
    }
    static let limit: Int64 = 4_000_000
    static let block = 65_536
    // An ignored Range can put bytes in socket/TLS buffers before URLSession can reject the headers.
    // Keep 2 MiB of the 4 MB cap for that final cancellation. Transaction metrics settle each attempt.
    // An arbitrary peer can exceed even this reserve; verified CDN behavior is part of the cellular gate.
    static let cancellationReserve: Int64 = 2 * 1_024 * 1_024
    private var revoked = false
    var admission: MediaLocation? { lock.withLock { revoked ? nil : grant } }
    private var grant: MediaLocation
    private var resource: URL
    private let pool: MediaPool
    let file: MediaPool.File
    private var forward: (task: URLSessionDataTask, response: RangeResponse)?
    private let lock = NSLock()
    private var cancelled = false
    private let stopBackoff = DispatchSemaphore(value: 0)
    private var tasks = [URLSessionTask]()
    private let transfers = DispatchGroup()
    private(set) var speculative: Bool
    private let budget: Budget
    let occurrence: Int
    // Four blocks cover about 6.5 seconds at 320 kbit/s, plus a separate decoder tail probe.
    static let openingPrefix = Int64(4 * block)
    static let wifiWindow: Int64 = 6_000_000
    private let successorWindow: SuccessorWindow?
    // A foreground range hint until the first PCM. The decoder still chooses its exact cursor.
    var meteredSeekByte: Int64 = 0
    private var lastReadEnd: Int64 = 0
    private static let meteredWindow = Int64(4 * block)
    private var windowFailed = false
    var specBytes: Int64 { budget.charged[occurrence] ?? 0 }

    private let began = ProcessInfo.processInfo.systemUptime
    private var reportedFirstByte = false
    private let trace: (String) -> Void
    private let diagnostic: (String) -> Void
    private let renew: ((MediaLocation) throws -> MediaLocation)?
    #if DEBUG
    private let signalDebug: () -> Void
    #endif
    private let awaitDemand: (() throws -> Void)?
    var onFirstBlockData: (() -> Void)?
    var onDecoderWait: ((Bool) -> Void)?

    init(_ location: MediaLocation, drive: String = "", item: String = "", pool: MediaPool = MediaPool(),
         budget: Budget = Budget(), occurrence: Int = 0, speculative: Bool, successorWindow: SuccessorWindow? = nil,
         signalDebug: @escaping () -> Void = {}, trace: @escaping (String) -> Void,
         diagnostic: @escaping (String) -> Void = { _ in }, awaitDemand: (() throws -> Void)? = nil, renew: ((MediaLocation) throws -> MediaLocation)? = nil) throws {
        guard location.size > 0, !location.etag.isEmpty, Self.allowed(location.url) else {
            throw PlaybackError("Invalid media metadata")
        }
        self.grant = location
        self.resource = location.url
        self.successorWindow = successorWindow
        #if DEBUG
        self.signalDebug = signalDebug
        #endif
        self.speculative = speculative
        self.trace = trace
        self.diagnostic = diagnostic
        self.renew = renew
        self.awaitDemand = awaitDemand
        self.budget = budget
        self.occurrence = occurrence
        self.pool = pool
        self.file = MediaPool.File(drive: drive, item: item, version: location.etag, size: location.size)
        pool.discard(drive: drive, item: item, keeping: file)
    }

    private static func allowed(_ url: URL) -> Bool {
        #if RANGE_TRANSPORT_TEST && (os(macOS) || targetEnvironment(simulator))
        if url.scheme == "http", url.host == "127.0.0.1" { return true }
        #endif
        return url.scheme?.lowercased() == "https" && url.host != nil && url.user == nil && url.password == nil
            && url.fragment == nil && (url.port == nil || url.port == 443)
    }

    deinit { cancel() }

    func cancel() {
        lock.withLock { cancelled = true; tasks.forEach { $0.cancel() }; stopBackoff.signal() }
        successorWindow?.changed.signal()
    }

    /// The decoder worker has finished issuing requests. Wait outside its playback lock for final metrics.
    func cancelAndDrain() { cancel(); transfers.wait() }

    /// Demand takes over the same reader, signed resource and forward response. The response keeps its route restrictions.
    func promote() {
        speculative = false
    }

    /// A known denial or changed version fences cache-only continuations while committed PCM drains.
    func revokeAdmission() {
        lock.withLock { revoked = true }
        cancel()
        pool.discard(drive: file.drive, item: file.item)
    }

    /// Drain the old response before even starting the lookup, including the Debug renewal hold.
    /// A different version cannot continue the decoder's existing cursor or queued PCM.
    func renewLocation(using lookup: () throws -> MediaLocation) throws {
        if let stream = forward {
            stream.task.cancel()
            stream.response.done.wait()
            forward = nil
        }
        let fresh = try lookup()
        guard fresh.size == file.size, fresh.etag == file.version, Self.allowed(fresh.url) else {
            revokeAdmission()
            throw PlaybackError("Recording changed during playback")
        }
        lock.withLock { grant = fresh }
        resource = fresh.url
        windowFailed = false
        diagnostic("Renewed media URL validated")
    }

    func read(_ offset: Int64, _ count: Int) throws -> Data {
        guard offset >= 0, count >= 0, offset <= file.size, Int64(count) <= file.size-offset else {
            throw PlaybackError("Decoder read outside recording")
        }
        lastReadEnd = offset + Int64(count)
        var result = Data()
        while result.count < count {
            if lock.withLock({ cancelled }) { throw CancellationError() }
            let position = offset + Int64(result.count)
            let base = position - position % Int64(Self.block)
            let length = min(file.size-base, Int64(Self.block))
            let block = try pool.read(file, at: base) ?? fetch(base..<(base+length))
            let from = Int(position-base)
            let take = min(count-result.count, block.count-from)
            result.append(block[from..<(from+take)])
        }
        return result
    }

    /// Once PCM is ready, keep delivered blocks and cancel a metered scan that substantially overshot.
    func finishMeteredSeek() {
        guard meteredSeekByte > 0 else { return }
        meteredSeekByte = 0
        if let stream = forward, stream.task.originalRequest?.allowsCellularAccess == true,
           stream.response.bounds.upperBound - lastReadEnd > Self.meteredWindow {
            stream.task.cancel()
        }
    }

    /// Register each task before resuming it so Stop can cancel both the forward read and a tail probe.
    private func startTransfer(_ bounds: Range<Int64>, streams: Bool,
                               wifiOnly: Bool) throws -> (URLSessionDataTask, RangeResponse) {
        let response = RangeResponse(bounds, size: file.size, onFirstData: onFirstBlockData)
        onFirstBlockData = nil
        let resource = self.resource
        let cdnTag = grant.validator(for: resource)
        response.acceptTag = { [grant] tag in grant.acceptValidator(tag, for: resource) }
        var request = URLRequest(url: resource)
        request.setValue("bytes=\(bounds.lowerBound)-\(bounds.upperBound-1)", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let cdnTag, !cdnTag.hasPrefix("W/") { request.setValue(cdnTag, forHTTPHeaderField: "If-Match") }
        if streams || (speculative && bounds.count > Self.block) {
            response.publish = { [weak self] offset, bytes in
                guard let self else { return }
                self.lock.withLock {
                    if !self.cancelled { self.pool.store(bytes, for: self.file, at: offset) }
                }
            }
        }
        if wifiOnly { request.requireUnmeteredWiFi() }
        #if DEBUG
        let requestID = UUID()
        #endif
        let isSpec = speculative
        response.onComplete = { [weak self, trace, transfers, grant] r, task in
            if r.rejectsResource { grant.markRejected() }
            defer { transfers.leave() }
            #if DEBUG
            self?.pool.setDebugRequest(requestID, nil)
            self?.signalDebug()
            #endif
            self?.lock.withLock { self?.tasks.removeAll { $0 === task } }
            if !isSpec || streams {
                trace(r.metricsLine(bytes: max(r.received, r.wireBytes ?? 0, task.countOfBytesReceived), speculative: isSpec, charged: 0))
            }
        }
        let active = try lock.withLock {
            if cancelled { throw CancellationError() }
            let task = pool.session.dataTask(with: request)
            task.priority = speculative ? URLSessionTask.lowPriority : streams ? URLSessionTask.defaultPriority : URLSessionTask.highPriority
            task.delegate = response
            transfers.enter()
            tasks.append(task)
            #if DEBUG
            pool.setDebugRequest(requestID, (file, bounds))
            signalDebug()
            #endif
            task.resume()
            return task
        }
        return (active, response)
    }

    /// Size the rolling range from the last decoded byte to the estimated future position.
    func extendMeteredWindow(through target: Int64) throws {
        guard !speculative else { return }
        // Include the block containing the time estimate when the shared window rounds down.
        let cap: Int64 = 2 * 1_024 * 1_024
        let distance = min(cap, target - lastReadEnd)
        let bytes = min(cap, max(Self.meteredWindow, distance + Int64(Self.block)))
        try extendWindow(from: lastReadEnd, to: lastReadEnd + min(bytes, file.size - lastReadEnd), wifiOnly: false)
    }

    /// Rolling forward transfers are shared with demand. Only unmetered Wi-Fi expands the successor window.
    func extendWindow(from start: Int64, to end: Int64, wifiOnly: Bool = true) throws {
        guard !grant.isRejected, !wifiOnly || pool.unmeteredWiFi(), end > start else { return }
        if let stream = forward {
            guard stream.response.isFinished else { return }
            windowFailed = stream.response.failure != nil && !stream.response.transportCancelled && !stream.response.networkLost
            forward = nil
        }
        guard !windowFailed else { return }
        let block = Int64(Self.block)
        let upper = end >= file.size ? file.size : end / block * block
        let lower = start / block * block
        guard lower < upper, let gap = pool.firstGap(file, in: lower..<upper) else { return }
        // Batch small extensions to a covered prefix. Always fill an initial gap, a hole, or EOF.
        let batch = wifiOnly ? 4*Self.block : min(4*Self.block, max(Self.block, Int(end-start)/4))
        if gap.lowerBound > lower && gap.upperBound == upper && upper < file.size && gap.count < batch { return }
        // Leave the final metadata probe independent of a large sequential read.
        let tail = (file.size-1) / block * block
        let limit = gap.upperBound == file.size && gap.lowerBound < tail ? tail : gap.upperBound
        forward = try startTransfer(gap.lowerBound..<limit, streams: true, wifiOnly: wifiOnly)
    }

    /// Keep one forward transfer. A distant decoder probe gets an independent small range on the same session.
    private func fetch(_ wanted: Range<Int64>) throws -> Data {
        // Only the decoder calls fetch on a cache miss. Rolling read-ahead never enters here.
        onDecoderWait?(true)
        defer { onDecoderWait?(false) }
        var retriedLocation = false
        var redirects = 0
        var singleBlock = false
        while true {
            if lock.withLock({ cancelled }) { throw CancellationError() }
            if let hit = pool.read(file, at: wanted.lowerBound) { return hit }
            if grant.isRejected, let renew {
                guard !retriedLocation else { throw PlaybackError("Renewed media URL rejected") }
                try renewLocation { try renew(grant) }
                retriedLocation = true
                redirects = 0
                continue
            }
            let early = speculative && successorWindow?.early == true
            let wide = pool.unmeteredWiFi()
            let earlyWiFi = early && wide
            let base = wanted.lowerBound
            let tail = (file.size - 1) / Int64(Self.block) * Int64(Self.block)
            if speculative, let successorWindow {
                let prefix = successorWindow.prefix()
                let target = wide ? prefix : min(prefix, Self.openingPrefix)
                if wide { try extendWindow(from: 0, to: target) }
                if early && (target == 0 || (wanted.upperBound > target && base != tail)) {
                    // A large tag or high bitrate can put the prepared PCM beyond the early allowance.
                    // A manual Next reopens against every complete block already delivered.
                    successorWindow.changed.wait()
                    continue
                }
            }
            if let stream = forward {
                let available = stream.response.availableEnd
                let meteredScan = meteredSeekByte > 0 && stream.task.originalRequest?.allowsCellularAccess == true
                if stream.response.bounds.contains(base), base >= available, (speculative || meteredScan || base - available <= Int64(Self.block)) {
                    stream.response.waitForBlock(endingAt: wanted.upperBound)
                    if let hit = pool.read(file, at: base) { return hit }
                    // Replay just the missing demand through the normal redirect, backoff and renewal path.
                    singleBlock = true
                    if speculative && stream.response.isFinished {
                        windowFailed = stream.response.failure != nil && !stream.response.transportCancelled && !stream.response.networkLost
                    }
                }
                // The last block can wake the decoder before URLSession delivers completion metrics.
                // A fully published range has no more bytes to supply and frees the forward slot.
                if stream.response.isFinished || stream.response.availableEnd == stream.response.bounds.upperBound {
                    forward = nil
                }
            }
            if let hit = pool.read(file, at: base) { return hit }
            if grant.isRejected && renew != nil { continue }
            if speculative && Int64(wanted.count) + Self.cancellationReserve > Self.limit-specBytes {
                // The decoder can need more than the opening. Revisit the moving window until
                // Wi-Fi covers this block or normal near-join preparation can wait for promotion.
                if early, let successorWindow {
                    successorWindow.changed.wait()
                    continue
                }
                guard let awaitDemand else { throw PlaybackError("Speculation budget exhausted") }
                try awaitDemand()
                promote()
                continue
            }
            let window = wide ? Self.wifiWindow / Int64(Self.block) * Int64(Self.block) : Self.meteredWindow
            // ExtAudioFileSeek can scan every intervening MP3 frame header. Start at its actual miss
            // and stream through the estimated target plus the ordinary playback window. Split very
            // long scans so a fast response cannot evict its own beginning from the 40 MB pool.
            let target = meteredSeekByte - meteredSeekByte % Int64(Self.block)
            let scan = wide ? 0 : min(16 * 1_024 * 1_024 - window, max(0, target - base))
            let end = min(tail, base + min(file.size - base, scan + window))
            // Leave the final block free for the decoder's opening metadata probe.
            let prefixEnd = min(tail, Self.openingPrefix)
            let batchOpening = early && !wide && base < prefixEnd && prefixEnd-base + Self.cancellationReserve <= Self.limit-specBytes
            let gap: Range<Int64>?
            if batchOpening { gap = pool.firstGap(file, in: base..<prefixEnd) }
            else if !speculative && !singleBlock && forward == nil && end > wanted.upperBound { gap = pool.firstGap(file, in: base..<end) }
            else { gap = wanted }
            guard let bounds = gap, bounds.lowerBound == base else { continue }
            // The bounded cellular prefix is validated and charged as one transaction.
            let streams = !speculative && bounds != wanted
            let (active, response) = try startTransfer(bounds, streams: streams, wifiOnly: earlyWiFi || (wide && streams))
            if streams {
                forward = (active, response)
                continue
            }
            response.done.wait()
            let actual = max(response.wireBytes ?? 0, response.received, active.countOfBytesReceived)
            if speculative {
                // Missing metrics leave wire cost unknown. Close speculation for this occurrence.
                if let measured = response.wireBytes, measured >= response.received {
                    budget.charged[occurrence, default: 0] += actual
                } else {
                    budget.charged[occurrence] = Self.limit
                }
            }
            if !reportedFirstByte, let time = response.firstByte {
                reportedFirstByte = true
                trace("first body elapsed=\(time-began)")
            }
            if lock.withLock({ cancelled }) { throw CancellationError() }
            if speculative {
                trace(response.metricsLine(bytes: actual, speculative: true, charged: specBytes))
                guard specBytes <= Self.limit else { throw PlaybackError("Speculative cap exceeded") }
                if earlyWiFi && response.transportCancelled { continue }
                // An unmeasured attempt has already closed the occurrence's allowance. Valid
                // bytes can still be used; the next miss waits for demand before further traffic.
            }
            if speculative, !(response.rejectsResource && response.status >= 400), response.expectedBytes > Int64(bounds.count) {
                throw PlaybackError("Oversized speculative response (HTTP \(response.status))")
            }
            // Follow each HTTPS redirect as a separate credential-free range. Charge its body before
            // reserving the next attempt, since both transactions count against the same speculative item.
            if let redirect = response.redirect, Self.allowed(redirect), redirects < 3 {
                redirects += 1
                resource = redirect
                continue
            }
            if let failure = response.failure {
                if response.rejectsResource, !retriedLocation, renew != nil {
                    diagnostic("HTTP \(response.status); renewing media URL at offset \(bounds.lowerBound)")
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
            if response.publish != nil {
                guard response.availableEnd == bounds.upperBound else { throw PlaybackError("Incomplete media range") }
                // Complete opening blocks were published as they arrived, including if Next
                // cancelled partway. The transaction's wire charge was settled above.
                if let hit = pool.read(file, at: base) { return hit }
                continue
            }
            guard response.body.count == bounds.count else { throw PlaybackError("Incomplete media range") }
            if retriedLocation { diagnostic("Renewed media URL returned HTTP \(response.status) at offset \(bounds.lowerBound)") }
            try lock.withLock {
                if cancelled { throw CancellationError() }
                pool.store(response.body, for: file, at: base)
            }
            #if DEBUG
            signalDebug()
            #endif
            if !speculative { windowFailed = false } // Successful demand can re-enable read-ahead after a failed range.
            return response.body
        }
    }
}
