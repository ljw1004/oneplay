import AVFoundation
import OSLog

struct IndexedTrack: Decodable, Sendable {
    let driveId: String
    let itemId: String
}

private enum Recording: Sendable {
    case oneDrive(IndexedTrack)
    #if DEBUG
    case local(URL)
    #endif
}

/// One serial worker schedules PCM. A separate worker prepares the single successor while the
/// outgoing music renders. Replacement drains both, including outstanding transfer accounting.
final class NativePlayback: @unchecked Sendable {
    typealias Lookup = @Sendable (_ driveId: String, _ itemId: String, _ forceRefresh: Bool) async throws -> MediaLocation
    static let captureURL = URL.cachesDirectory.appendingPathComponent("OnePlayJoin.caf")
    private let destination: URL
    private let diagnostics: NativeDiagnostics?
    private let lookup: Lookup
    private let worker = DispatchQueue(label: "me.unto.oneplay.music.decode", qos: .default)
    private let lock = NSLock()
    private var active: PlaybackRun?

    init(captureURL: URL = NativePlayback.captureURL, diagnostics: NativeDiagnostics? = nil, lookup: @escaping Lookup) {
        destination = captureURL
        self.diagnostics = diagnostics
        self.lookup = lookup
    }
    var status: String { lock.withLock { active?.status ?? "Stopped" } }

    func start(tracks: [IndexedTrack], delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) throws {
        guard !tracks.isEmpty, [0,5,10].contains(delaySeconds),
              tracks.allSatisfy({ !$0.driveId.isEmpty && !$0.itemId.isEmpty }) else {
            throw PlaybackError("Invalid playback request")
        }
        start(tracks.map(Recording.oneDrive), delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
    }

    #if DEBUG
    /// The listener selects original MP3s in Files. Numeric filename order reproduces the album order offline.
    func startLocalFiles(_ urls: [URL], nearEnd: Bool) throws {
        guard !urls.isEmpty, urls.allSatisfy({ $0.isFileURL && $0.pathExtension.lowercased() == "mp3" }) else {
            throw PlaybackError("Choose MP3 files")
        }
        let ordered = urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        start(ordered.map(Recording.local), delaySeconds: 0, nearEnd: nearEnd, forceRefresh: false)
    }
    #endif

    private func start(_ tracks: [Recording], delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) {
        let run = PlaybackRun(lookup: lookup, captureURL: destination, diagnostics: diagnostics)
        lock.withLock {
            active?.cancel()
            active = run
            worker.async {
                run.playAndReport(tracks: tracks, delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
            }
        }
    }

    func stop() { lock.withLock { active?.cancel(); active = nil } }

    /// Logout drains all in-flight bytes before removing the diagnostic recording. Retrying cleanup is safe.
    func stopAndDrain() async throws {
        stop()
        await withCheckedContinuation { continuation in worker.async { continuation.resume() } }
        do { try FileManager.default.removeItem(at: destination) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
    }
}

/// A producer publishes its result before leaving the group. The decoder reads it only after waiting.
/// This bridges Core Audio's synchronous byte reads with Graph and the successor preparation worker.
private final class WorkerReply<Value>: @unchecked Sendable {
    let ready = DispatchGroup()
    private(set) var result: Result<Value, Error>!
    init() { ready.enter() }
    func finish(_ result: Result<Value, Error>) { self.result = result; ready.leave() }
}

private final class PlaybackRun: @unchecked Sendable {
    private let captureURL: URL
    private let diagnostics: NativeDiagnostics?
    private let lookup: NativePlayback.Lookup
    private let log = Logger(subsystem: "me.unto.oneplay.music", category: "Playback")
    private let lock = NSLock()
    private var cancelled = false
    private var activeLookup: Task<Void, Never>?
    private var sources = [MediaRanges]()
    private var message = "Preparing playback"
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let rate = 44_100
    private var scheduled: Int64 = 0
    #if DEBUG
    private var capturing = false
    #endif
    private var started = false
    private var lastPlayed: DispatchGroup?

    init(lookup: @escaping NativePlayback.Lookup, captureURL: URL, diagnostics: NativeDiagnostics?) {
        self.diagnostics = diagnostics
        self.lookup = lookup
        self.captureURL = captureURL
    }
    var status: String {
        lock.withLock {
            started && clock >= scheduled ? "Waiting for audio. " + message : message
        }
    }

    /// Stop audible output immediately, including when Graph or the CDN is unresponsive.
    func cancel() {
        lock.withLock {
            cancelled = true
            activeLookup?.cancel()
            sources.forEach { $0.cancel() }
            if started { node.stop() }
        }
    }

    private func report(_ text: String) {
        lock.withLock { message = text }
        log.notice("\(text, privacy: .public)")
    }

    private func checkCancellation() throws {
        if lock.withLock({ cancelled }) { throw CancellationError() }
    }

    private func resolve(_ track: IndexedTrack, forceRefresh: Bool, delay: Int = 0) throws -> MediaLocation {
        let reply = WorkerReply<MediaLocation>()
        try lock.withLock {
            if cancelled { throw CancellationError() }
            activeLookup = Task { [lookup] in
                do {
                    // Hold delivery from promotion, including time spent making the real live request.
                    let release = ContinuousClock.now.advanced(by: .seconds(delay))
                    var retrying = false
                    while true {
                        try Task.checkCancellation()
                        do {
                            let media = try await lookup(track.driveId, track.itemId, forceRefresh)
                            if delay > 0 { try await ContinuousClock().sleep(until: release) }
                            if retrying { self.lock.withLock { if !self.cancelled { self.diagnostics?.record("Playback metadata lookup recovered") } } }
                            reply.finish(.success(media))
                            return
                        } catch NativeAccountError.transient {
                            if !retrying {
                                self.lock.withLock { if !self.cancelled { self.diagnostics?.record("Playback metadata lookup transient; retrying") } }
                                retrying = true
                            }
                            try await Task.sleep(for: .seconds(2))
                        }
                    }
                } catch { reply.finish(.failure(error)) }
            }
        }
        // MSAL may continue a shared acquisition for the library. The stopped decoder must not wait for it.
        while reply.ready.wait(timeout: .now() + 0.1) == .timedOut { try checkCancellation() }
        try lock.withLock {
            activeLookup = nil
            if cancelled { throw CancellationError() }
        }
        return try reply.result.get()
    }

    private var clock: Int64 {
        guard let time = node.lastRenderTime, let playerTime = node.playerTime(forNodeTime: time) else { return 0 }
        return playerTime.sampleTime
    }

    private func wait(until target: Int64) throws {
        while clock < target {
            try checkCancellation()
            guard engine.isRunning && node.isPlaying else { throw PlaybackError("Audio output interrupted") }
            Thread.sleep(forTimeInterval: 0.012)
        }
        try checkCancellation()
    }

    /// Advance the schedule clock through starvation once. The decoder stays at its first missing frame.
    @discardableResult private func enqueue(_ pcm: AVAudioPCMBuffer, frames: Range<Int>) throws -> Int64 {
        guard !frames.isEmpty else { return scheduled }
        let part: AVAudioPCMBuffer
        if frames == 0..<Int(pcm.frameLength) { part = pcm }
        else {
            guard let slice = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: UInt32(frames.count)) else {
                throw PlaybackError("Cannot allocate PCM slice")
            }
            slice.frameLength = UInt32(frames.count)
            for channel in 0..<Int(pcm.format.channelCount) {
                slice.floatChannelData![channel].update(from: pcm.floatChannelData![channel] + frames.lowerBound, count: frames.count)
            }
            part = slice
        }
        return try lock.withLock {
            if cancelled { throw CancellationError() }
            let now = clock
            if now > scheduled {
                log.notice("stall frames=\(now-self.scheduled)"); scheduled = now
            }
            let start = scheduled
            let played = DispatchGroup()
            played.enter()
            node.scheduleBuffer(part, atTime: nil, options: [], completionCallbackType: .dataPlayedBack) { played.leave() }
            lastPlayed = played
            scheduled += Int64(part.frameLength)
            if !started {
                try node.playAudio()
                started = true
                message = "Playing track 1"
                log.notice("Playing track 1")
            }
            return start
        }
    }

    /// Output latency can extend beyond the player-node clock. Drain the last committed buffer on
    /// natural completion or permanent failure. User cancellation interrupts this wait immediately.
    private func drainAudio() throws {
        try checkCancellation()
        guard started else { return }
        while lastPlayed?.wait(timeout: .now() + 0.1) == .timedOut {
            try checkCancellation()
            guard engine.isRunning && node.isPlaying else { throw PlaybackError("Audio output interrupted") }
        }
        try checkCancellation()
        #if DEBUG
        // The tap batches up to 4096 frames even when it is asked for 1024. Leave the render graph
        // alive for the pending callback and a silent buffer, so the measured file includes the last sound.
        if capturing && started { try wait(until: scheduled + 8192) }
        #endif
    }

    /// Convert operational errors into safe diagnostics. Native account errors expose a bounded category.
    func playAndReport(tracks: [Recording], delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) {
        do {
            try play(tracks: tracks, delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
            report("Finished \(tracks.count) track(s)")
        } catch is CancellationError {
            report("Stopped")
        } catch let error as PlaybackError {
            diagnostics?.record("Playback stopped: \(error.errorDescription ?? "decoder error")")
            report(error.errorDescription ?? "Playback failed")
        } catch let error as NativeAccountError {
            diagnostics?.record("Playback lookup stopped: \(error.rawValue)")
            report(error == .forbidden ? "OneDrive denied access to this recording" : "Playback lookup: \(error.rawValue)")
        } catch {
            report("Playback failed (\((error as NSError).code))")
        }
    }

    private func play(tracks: [Recording], delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) throws {
        try checkCancellation()
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback)
        try audio.setActive(true)
        defer { try? audio.setActive(false, options: .notifyOthersOnDeactivation) }
        #endif
        defer {
            lock.withLock { node.stop(); started = false; sources.forEach { $0.cancel() }; sources.removeAll() }
            #if DEBUG
            if capturing { node.removeTap(onBus: 0) }
            #endif
            engine.stop()
        }
        var (source, decoder) = try open(tracks[0], ordinal: 1, speculative: false)
        engine.attach(node)
        try engine.connectNode(node, to: engine.mainMixerNode, format: decoder.format)
        #if DEBUG
        // A near-end audition writes a bounded render capture for the independent waveform comparison.
        if nearEnd {
            let settings = decoder.format.settings.merging([AVLinearPCMIsNonInterleaved: false]) { _, value in value }
            let capture = try AVAudioFile(forWriting: captureURL, settings: settings)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: captureURL.path)
            #endif
            try node.installAudioTap(onBus: 0, bufferSize: 1024, format: decoder.format) { [rate, log] pcm, _ in
                guard capture.framePosition < Int64(rate*45) else { return }
                do { try capture.write(from: pcm) } catch { log.error("Playback capture write failed") }
            }
            capturing = true
        }
        #endif
        try engine.start()
        let firstFrame = nearEnd ? max(0,decoder.frames - Int64(16*rate)) : 0
        var chunk = try decode(decoder, from: firstFrame, seconds: 4, seek: firstFrame > 0)
        var nextFrame = firstFrame + Int64(chunk.pcm.frameLength)
        var ordinal = 1
        do {
            while true {
                // For each full track this cursor advances exactly once, including across URL replacement.
                if !chunk.final {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    repeat {
                        try wait(until: scheduled - Int64(8*rate))
                        chunk = try decode(decoder, from: nextFrame, seconds: 4)
                        nextFrame += Int64(chunk.pcm.frameLength)
                        if !chunk.final { try enqueue(chunk.pcm, frames: chunk.audible) }
                    } while !chunk.final
                }
                if ordinal == tracks.count {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    try drainAudio()
                    return
                }

                // The final 88 playable frames suffice for the mix. Start preparing while earlier PCM is audible.
                let tail = chunk.audible
                var hold = min(88, tail.count, chunk.playableCount/2)
                try enqueue(chunk.pcm, frames: tail.lowerBound..<(tail.upperBound-hold))
                let next = tracks[ordinal]
                // Preparing can block on Graph and Core Audio. If the next song misses its deadline,
                // commit the outgoing tail intact, including on denial. The decoder worker alone schedules PCM.
                let prepared = WorkerReply<(MediaRanges?, MP3RangeDecoder, Chunk)>()
                let demandAllowed = DispatchSemaphore(value: 0)
                DispatchQueue.global(qos: .default).async { [self, ordinal] in
                    prepared.finish(Result {
                        let (incoming, decoder) = try open(next, ordinal: ordinal+1, speculative: true) {
                            while demandAllowed.wait(timeout: .now() + 0.1) == .timedOut { try self.checkCancellation() }
                            try self.checkCancellation()
                        }
                        return (incoming, decoder, try decode(decoder, from: 0, seconds: 12))
                    })
                }
                let runwaySeconds = Double(scheduled-clock)/Double(rate)
                let late = prepared.ready.wait(timeout: .now() + max(0,runwaySeconds-0.1)) == .timedOut
                // Drain the preparing worker and its last task metrics on cancellation before replacing the queue.
                defer { demandAllowed.signal(); prepared.ready.wait() }
                if late {
                    try enqueue(chunk.pcm, frames: (tail.upperBound-hold)..<tail.upperBound)
                    hold = 0
                    let remaining = max(0, Double(scheduled-clock)/Double(rate))
                    if prepared.ready.wait(timeout: .now() + remaining) == .timedOut {
                        try wait(until: scheduled)
                        demandAllowed.signal()
                        prepared.ready.wait()
                    }
                }
                let (incoming, nextDecoder, ready): (MediaRanges?, MP3RangeDecoder, Chunk)
                do { (incoming,nextDecoder,ready) = try prepared.result.get() }
                catch {
                    try enqueue(chunk.pcm, frames: (tail.upperBound-hold)..<tail.upperBound)
                    throw error
                }
                var head = ready
                let possible = (chunk.trimmedEnd || head.trimmedStart) ? min(hold, head.audible.count/2) : 0
                let mix = possible >= 2 ? possible : 0
                try enqueue(chunk.pcm, frames: (tail.upperBound-hold)..<(tail.upperBound-mix))
                for channel in 0..<Int(head.pcm.format.channelCount) {
                    for index in 0..<mix {
                        let gain = Float(index)/Float(mix-1)
                        let at = head.audible.lowerBound+index
                        let left = chunk.pcm.floatChannelData![channel][tail.upperBound-mix+index]
                        let right = head.pcm.floatChannelData![channel]
                        right[at] = left*(1-gain) + right[at]*gain
                    }
                }
                // A fully prepared short song keeps its outgoing splice available for the following song.
                let retain = head.final && ordinal+1 < tracks.count ? min(88,head.audible.count/2) : 0
                let cut = head.audible.upperBound-retain
                let boundary = try enqueue(head.pcm, frames: head.audible.lowerBound..<cut)
                log.notice("ready item=\(ordinal+1) prefixFrames=\(cut-head.audible.lowerBound) specBytes=\(incoming?.specBytes ?? 0) overlap=\(mix) boundary=\(boundary)")
                try wait(until: boundary)
                source?.cancel()
                lock.withLock { sources.removeAll { $0 === source } }
                ordinal += 1
                report("Playing track \(ordinal)")
                if !head.final, let incoming, incoming.speculative, case .oneDrive(let recording) = next {
                    // The player consumes the runway independently of this lookup and its first new range.
                    incoming.promote()
                    diagnostics?.record("CDN item=\(ordinal) promotion; renewing media URL forcedAuth=\(forceRefresh)")
                    try incoming.installRenewal(resolve(recording, forceRefresh: forceRefresh, delay: delaySeconds))
                }
                source = incoming
                decoder = nextDecoder
                nextFrame = Int64(head.pcm.frameLength)
                head.audible = cut..<head.audible.upperBound
                chunk = head
            }
        } catch {
            // A permanent media error stops at this occurrence, after its already committed music.
            // Explicit Stop and sign-out cancel this wait immediately.
            try drainAudio()
            throw error
        }
    }

    private func open(_ recording: Recording, ordinal: Int, speculative: Bool, awaitDemand: (() throws -> Void)? = nil) throws -> (MediaRanges?, MP3RangeDecoder) {
        let track: IndexedTrack
        switch recording {
        case .oneDrive(let indexed): track = indexed
        #if DEBUG
        case .local(let url):
            let file = try LocalMP3(url)
            return (nil, try MP3RangeDecoder(bytes: file.size, read: file.read))
        #endif
        }
        let media = try resolve(track, forceRefresh: false)
        let source = try MediaRanges(media, speculative: speculative, trace: { [log] entry in
            log.info("range item=\(ordinal) \(entry, privacy: .public)")
        }, diagnostic: { [diagnostics] event in diagnostics?.record("CDN item=\(ordinal) \(event)") }, awaitDemand: awaitDemand, renew: { [unowned self] in try self.resolve(track, forceRefresh: false) })
        try lock.withLock {
            if cancelled { throw CancellationError() }
            sources.append(source)
        }
        return (source, try MP3RangeDecoder(bytes: media.size, read: source.read))
    }

    private struct Chunk {
        let pcm: AVAudioPCMBuffer
        var audible: Range<Int>
        let playableCount: Int
        let final: Bool
        let trimmedStart: Bool
        let trimmedEnd: Bool
    }

    /// Ask beyond estimated EOF. A clean short read is authoritative across resampling.
    /// Combining a small remainder with its preceding read keeps the entire trailing trim window available.
    private func decode(_ decoder: MP3RangeDecoder, from position: Int64, seconds: Int, seek: Bool = false) throws -> Chunk {
        let normal = seconds*rate
        let remaining = max(0, decoder.frames-position)
        let count = remaining <= Int64(normal+rate) ? Int(remaining)+rate : normal
        let pcm = try decoder.decode(count, at: seek ? position : nil)
        let n = Int(pcm.frameLength)
        guard n > 0 else { throw PlaybackError("Unexpected decoder EOF") }
        let final = n < count
        func quiet(_ limit: Int, tail: Bool) -> Int {
            for i in 0..<limit {
                let at = tail ? n-1-i : i
                for ch in 0..<Int(pcm.format.channelCount) where abs(pcm.floatChannelData![ch][at]) > 0.0001 { return i }
            }
            return limit
        }
        let head = position == 0 && !decoder.hasDeclaredTiming ? quiet(min(n,1543), tail: false) : 0
        let tail = final && !decoder.hasDeclaredTiming ? quiet(min(n-head,6615), tail: true) : 0
        // Preserve a playable sample region for entirely silent sub-185-ms tracks.
        let audible = head+tail == n ? 0..<n : head..<(n-tail)
        return Chunk(pcm: pcm, audible: audible, playableCount: audible.count, final: final, trimmedStart: audible.lowerBound > 0, trimmedEnd: audible.upperBound < n)
    }
}

#if DEBUG
/// One decoder owns this file descriptor and the picker access grant through its last synchronous byte read.
private final class LocalMP3 {
    private let url: URL
    private let scoped: Bool
    private let file: FileHandle
    let size: Int64

    init(_ url: URL) throws {
        self.url = url
        scoped = url.startAccessingSecurityScopedResource()
        do {
            file = try FileHandle(forReadingFrom: url)
            size = try Int64(file.seekToEnd())
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    deinit {
        try? file.close()
        if scoped { url.stopAccessingSecurityScopedResource() }
    }

    func read(_ offset: Int64, _ count: Int) throws -> Data {
        try file.seek(toOffset: UInt64(offset))
        return try file.read(upToCount: count) ?? Data()
    }
}
#endif
