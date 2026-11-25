import AVFoundation
import OSLog

struct IndexedTrack: Decodable, Sendable {
    let driveId: String
    let itemId: String
    var path: [String]? = nil
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
    typealias Lookup = @Sendable (_ driveId: String, _ itemId: String, _ request: MediaLookup, _ wifiOnly: Bool) async throws -> MediaLocation
    static let captureURL = URL.cachesDirectory.appendingPathComponent("OnePlayJoin.caf")
    private let destination: URL
    private let diagnostics: NativeDiagnostics?
    private let lookup: Lookup
    private let worker = DispatchQueue(label: "me.unto.oneplay.music.decode", qos: .default)
    private let lock = NSLock()
    private var active: PlaybackRun?
    private var pool: MediaPool

    @MainActor var onChange: ((_ debugOnly: Bool) -> Void)?

    init(captureURL: URL = NativePlayback.captureURL, diagnostics: NativeDiagnostics? = nil, pool: MediaPool = MediaPool(), lookup: @escaping Lookup) {
        self.pool = pool
        destination = captureURL
        self.diagnostics = diagnostics
        self.lookup = lookup
    }
    var status: String { lock.withLock { active?.status ?? "Stopped" } }

    /// A fresh document samples the running node without restarting the decoder.
    var snapshot: [String: Any] { snapshot(lookups: nil) }

    func snapshot(lookups: [IndexedTrack]?) -> [String: Any] {
        lock.withLock { active?.snapshot(lookups: lookups) ?? [:] }
    }

    func start(tracks: [IndexedTrack], startIndex: Int = 0, delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) throws {
        guard tracks.indices.contains(startIndex), [0,5,10].contains(delaySeconds),
              tracks.allSatisfy({ !$0.driveId.isEmpty && !$0.itemId.isEmpty }) else {
            throw PlaybackError("Invalid playback request")
        }
        lock.withLock { replaceRun(tracks.map(Recording.oneDrive), index: startIndex, delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh) }
    }

    #if DEBUG
    /// The listener selects original MP3s in Files. Numeric filename order reproduces the album order offline.
    func startLocalFiles(_ urls: [URL], nearEnd: Bool) throws {
        guard !urls.isEmpty, urls.allSatisfy({ $0.isFileURL && $0.pathExtension.lowercased() == "mp3" }) else {
            throw PlaybackError("Choose MP3 files")
        }
        let ordered = urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        lock.withLock { replaceRun(ordered.map(Recording.local), index: 0, delaySeconds: 0, nearEnd: nearEnd, forceRefresh: false) }
    }
    #endif

    /// Called under the player lock. The serial worker drains the retiring run before decoding its replacement.
    private func replaceRun(_ tracks: [Recording], index: Int, seconds: Double = 0, paused: Bool = false,
                            seekItem: String? = nil, duration: Int64 = 0, admitted: MediaLocation? = nil, budget: MediaRanges.Budget = .init(),
                            delaySeconds: Int = 0, nearEnd: Bool = false, forceRefresh: Bool = false) {
        active?.cancel()
        let issuedAt = ProcessInfo.processInfo.systemUptime
        let run = PlaybackRun(tracks: tracks, index: index, seconds: seconds, paused: paused, seekItem: seekItem, duration: duration,
                              admitted: admitted, lookup: lookup, captureURL: destination, diagnostics: diagnostics, pool: pool, budget: budget) { [weak self] debugOnly in
            DispatchQueue.main.async { [weak self] in self?.onChange?(debugOnly) }
        }
        active = run
        guard !run.startsAtEnd else { return }
        worker.async {
            run.playAndReport(issuedAt: issuedAt, delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
        }
    }

    /// A command belongs to the item that the listener touched, including a repeated play of the same URL.
    func apply(_ action: String, item: String, seconds: Double?) throws {
        try lock.withLock {
            guard let run = active, let restart = try run.apply(action, item: item, seconds: seconds) else { return }
            replaceRun(run.tracks, index: restart.index, seconds: restart.seconds, paused: restart.paused,
                       seekItem: restart.seekItem, duration: restart.duration, admitted: restart.admitted, budget: run.budget)
        }
    }

    func stop() { lock.withLock { active?.cancel(); active = nil } }

    func cancelWiFiReadsIfMetered() { lock.withLock { pool.cancelWiFiReadsIfMetered() } }

    /// UIKit memory pressure may discard any compressed block. Active readers can fetch it again.
    func releaseCachedAudio() { lock.withLock { pool.clear() } }

    /// Logout drains all in-flight bytes before removing the diagnostic recording. Retrying cleanup is safe.
    func stopAndDrain() async throws {
        lock.withLock { active?.cancel(); active = nil; pool = MediaPool(unmeteredWiFi: pool.unmeteredWiFi) }
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
    let id = UUID().uuidString
    let tracks: [Recording]
    private let captureURL: URL
    private let diagnostics: NativeDiagnostics?
    let budget: MediaRanges.Budget
    private let pool: MediaPool
    private let lookup: NativePlayback.Lookup
    private let log = Logger(subsystem: "me.unto.oneplay.music", category: "Playback")
    private let lock = NSLock()
    private var cancelled = false
    private let admitted: MediaLocation?
    private let signalChange: @Sendable (Bool) -> Void
    private var sources = [MediaRanges]()
    private var message = "Preparing playback"
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let rate = 44_100
    private var scheduled: Int64 = 0
    #if DEBUG
    private var capturing = false
    #endif
    private let startIndex: Int
    private let startSeconds: Double
    let startsAtEnd: Bool
    private var paused: Bool
    private let resumeOrStop = DispatchSemaphore(value: 0)
    private let seekItem: String?
    private var lastFrame: Int64 = 0
    private var started = false
    #if os(iOS)
    private var sessionActivated = false
    #endif
    private var lastPlayed: DispatchGroup?

    /// The two anchors cover the currently audible item and an already scheduled successor.
    /// A snapshot crosses the join at the render clock even if the worker has not woken up yet.
    private struct Anchor {
        let index: Int
        var nodeFrame: Int64
        let fileFrame: Int64
        let duration: Int64
    }
    private var anchor: Anchor
    private var successor: Anchor?
    private var terminal: String?
    private var lastPosition: Double = 0

    private func audibleAnchor(at frame: Int64) -> Anchor {
        if let successor, frame >= successor.nodeFrame { return successor }
        return anchor
    }

    /// AVAudioPlayerNode may drop its clock mapping while paused. Remember the last rendered frame.
    private func renderedFrame() -> Int64 {
        if started && !paused, let time = node.lastRenderTime, let mapped = node.playerTime(forNodeTime: time) {
            lastFrame = max(lastFrame, mapped.sampleTime)
        }
        return lastFrame
    }

    private func itemToken(_ index: Int) -> String {
        index == startIndex ? (seekItem ?? id + "/" + String(index)) : id + "/" + String(index)
    }

    func snapshot(lookups: [IndexedTrack]?) -> [String: Any] {
        lock.withLock {
            let rendered = renderedFrame()
            let frame = min(rendered, scheduled)
            let entry = audibleAnchor(at: frame)
            guard case .oneDrive(let track) = tracks[entry.index], let path = track.path else { return [:] }
            let opening = seekItem != nil || admitted != nil ? "positioning" : "loading"
            let state = terminal ?? (paused ? "paused" : !started ? opening : rendered >= scheduled ? "stalled" : "playing")
            let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
            var result: [String: Any] = ["item": itemToken(entry.index), "path": path, "state": state,
                    "position": seconds, "duration": Double(entry.duration) / Double(rate), "message": message]
            #if DEBUG
            if let lookups { result["bars"] = debugBars(at: entry.index, lookups: lookups) }
            #endif
            return result
        }
    }

    init(tracks: [Recording], index: Int, seconds: Double, paused: Bool, seekItem: String?, duration: Int64, admitted: MediaLocation?, lookup: @escaping NativePlayback.Lookup, captureURL: URL, diagnostics: NativeDiagnostics?, pool: MediaPool, budget: MediaRanges.Budget, signalChange: @escaping @Sendable (Bool) -> Void) {
        self.admitted = admitted
        self.signalChange = signalChange
        self.budget = budget
        self.pool = pool
        self.tracks = tracks
        self.startIndex = index
        self.seekItem = seekItem
        self.startSeconds = seconds
        // An end scrub represents the boundary after every sample. This run needs no decode worker.
        self.startsAtEnd = duration > 0 && seconds == Double(duration) / Double(rate)
        self.paused = paused || startsAtEnd
        self.lastPosition = seconds
        self.anchor = Anchor(index: index, nodeFrame: 0, fileFrame: 0, duration: duration)
        self.diagnostics = diagnostics
        self.lookup = lookup
        self.captureURL = captureURL
        if startsAtEnd {
            terminal = paused ? nil : "ended"
            message = paused ? "Paused at end of track" : "Finished \(tracks.count) track(s)"
        }
    }
    #if DEBUG
    private func debugBars(at index: Int, lookups: [IndexedTrack]) -> [[String: Any]] {
        return (index-1...index+1).map { ordinal in
            guard tracks.indices.contains(ordinal), case .oneDrive(let track) = tracks[ordinal] else { return [:] }
            let file = sources.last { $0.occurrence == ordinal+1 }?.file
            var bar = pool.debugRanges(drive: track.driveId, item: track.itemId, admitted: file)
            bar["name"] = track.path?.last
            bar["lookup"] = lookups.contains { $0.driveId == track.driveId && $0.itemId == track.itemId }
            return bar
        }
    }
    #endif

    var status: String {
        lock.withLock {
            started && clock >= scheduled ? "Waiting for audio. " + message : message
        }
    }

    /// Native All follows queue order once. Natural joins, read-ahead and seeks to EOF use this same decision.
    private func successorAfterEnd(of index: Int) -> Int? {
        tracks.indices.contains(index + 1) ? index + 1 : nil
    }

    /// Sample and stop the touched occurrence in one critical section, before its successor can be scheduled.
    func apply(_ action: String, item: String, seconds: Double?) throws -> (index: Int, seconds: Double, paused: Bool, seekItem: String?, duration: Int64, admitted: MediaLocation?)? {
        try lock.withLock {
            let frame = min(renderedFrame(), scheduled)
            let entry = audibleAnchor(at: frame)
            // An output failure cancels its preparation worker. The still-current failed occurrence
            // remains a valid retry target. External Stop/replacement removes it from NativePlayback.active.
            guard item == itemToken(entry.index), !cancelled || terminal == "error" else { return nil }
            // Only continuations of this occurrence or its admitted immediate successor may start from retained bytes.
            func admission(_ index: Int) -> MediaLocation? {
                guard terminal == nil else { return nil }
                if let source = sources.last(where: { $0.occurrence == index+1 }) { return source.admission }
                return index == startIndex ? admitted : nil
            }
            switch action {
            case "seek", "skip":
                guard let seconds, seconds.isFinite, entry.duration > 0 else { return nil }
                let duration = Double(entry.duration) / Double(rate)
                let current = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
                let time = max(0, min(duration, action == "skip" ? current + seconds : seconds))
                let target = action == "seek" && time > 0 && time >= duration - 0.1 ? duration : time
                // A late wheel release cannot turn a stopped or failed occurrence into a natural end.
                if target == duration && terminal != nil { return nil }
                if paused || target < duration {
                    cancelLocked()
                    return (entry.index, target, paused, item, entry.duration, admission(entry.index))
                }
                // Releasing at EOF during playback completes the touched occurrence immediately.
                fallthrough
            case "play" where startsAtEnd && terminal == nil:
                cancelLocked()
                if let next = successorAfterEnd(of: entry.index) {
                    return (next, 0, false, nil, 0, admission(next))
                }
                return (entry.index, Double(entry.duration) / Double(rate), false, item, entry.duration, admission(entry.index))
            case "next", "previous":
                let index = entry.index + (action == "previous" ? -1 : 1)
                guard tracks.indices.contains(index) else { return nil }
                cancelLocked()
                return (index, 0, false, nil, 0, action == "previous" ? nil : admission(index))
            case "pause", "play":
                if terminal == nil {
                    if paused && action == "play" { resumeOrStop.signal() }
                    paused = action == "pause"
                    if started {
                        if paused { node.pause() } else if !node.isPlaying { try node.playAudio() }
                    }
                    return nil
                }
                guard action == "play" else { return nil }
                cancelLocked()
                return (entry.index, 0, false, nil, 0, nil)
            default: throw NativeAccountError.invalidRequest
            }
        }
    }

    /// Stop audible output immediately, including when Graph or the CDN is unresponsive.
    func cancel() { lock.withLock { cancelLocked() } }

    /// The item comparison and the stop share the same critical section as successor scheduling.
    private func cancelLocked() {
        guard !cancelled else { return }
        cancelled = true
        resumeOrStop.signal()
        sources.forEach { $0.cancel() }
        if started { node.stop() }
    }

    private func report(_ text: String, terminal state: String? = nil) {
        lock.withLock { message = text; terminal = state }
        if state != nil { signalChange(false) }
        log.notice("\(text, privacy: .public)")
    }

    private func checkCancellation() throws {
        if lock.withLock({ cancelled }) { throw CancellationError() }
    }

    private func resolve(_ track: IndexedTrack, _ request: MediaLookup, delay: Int = 0, wifiOnly: (() throws -> Bool)? = nil) throws -> MediaLocation {
        let reply = WorkerReply<MediaLocation>()
        try checkCancellation()
        let task = Task { [lookup] in
            do {
                // Hold delivery from promotion, including time spent making the real live request.
                let release = ContinuousClock.now.advanced(by: .seconds(delay))
                var retrying = false
                while true {
                    try Task.checkCancellation()
                    do {
                        let begin = ProcessInfo.processInfo.systemUptime
                        let media = try await lookup(track.driveId, track.itemId, request, try wifiOnly?() ?? false)
                        self.log.info("Media lookup including auth durationMs=\(Int((ProcessInfo.processInfo.systemUptime-begin)*1000))")
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
        // Each worker owns its lookup, including when a successor is preparing during a demand renewal.
        defer { task.cancel() }
        while reply.ready.wait(timeout: .now() + 0.1) == .timedOut { try checkCancellation() }
        do {
            let media = try reply.result.get()
            try checkCancellation()
            return media
        }
        catch let error as NativeAccountError where error == .forbidden || error == .wrongAccount {
            lock.withLock {
                for source in sources where error == .wrongAccount || (source.file.drive == track.driveId && source.file.item == track.itemId) {
                    source.revokeAdmission()
                }
            }
            if error == .wrongAccount { pool.clear() }
            else { pool.discard(drive: track.driveId, item: track.itemId) }
            throw error
        }
    }

    private var clock: Int64 {
        guard let time = node.lastRenderTime, let playerTime = node.playerTime(forNodeTime: time) else { return 0 }
        return playerTime.sampleTime
    }

    private func wait(until target: Int64) throws {
        while clock < target {
            try checkCancellation()
            guard engine.isRunning && lock.withLock({ paused || node.isPlaying }) else { throw PlaybackError("Audio output interrupted") }
            Thread.sleep(forTimeInterval: 0.012)
        }
        try checkCancellation()
    }

    /// Advance the schedule clock through starvation once. The decoder stays at its first missing frame.
    @discardableResult private func enqueue(_ pcm: AVAudioPCMBuffer, frames: Range<Int>, incoming: (index: Int, duration: Int64)? = nil) throws -> Int64 {
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
            let wasWaiting = !started || now >= scheduled
            if now > scheduled {
                log.notice("stall frames=\(now-self.scheduled)")
                anchor.nodeFrame += now - scheduled
                scheduled = now
            }
            let start = scheduled
            if let incoming {
                successor = Anchor(index: incoming.index, nodeFrame: start, fileFrame: Int64(frames.lowerBound), duration: incoming.duration)
            }
            let played = DispatchGroup()
            played.enter()
            node.scheduleBuffer(part, atTime: nil, options: [], completionCallbackType: .dataPlayedBack) { played.leave() }
            lastPlayed = played
            scheduled += Int64(part.frameLength)
            if !started {
                if !paused { try node.playAudio() }
                started = true
                message = "Playing track \(startIndex + 1)"
                log.notice("Playing track \(self.startIndex + 1)")
            }
            if wasWaiting && !paused { signalChange(false) }
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
            guard engine.isRunning && lock.withLock({ paused || node.isPlaying }) else { throw PlaybackError("Audio output interrupted") }
        }
        try checkCancellation()
        #if DEBUG
        // The tap batches up to 4096 frames even when it is asked for 1024. Leave the render graph
        // alive for the pending callback and a silent buffer, so the measured file includes the last sound.
        if capturing && started { try wait(until: scheduled + 8192) }
        #endif
    }

    /// Convert operational errors into safe diagnostics. Native account errors expose a bounded category.
    func playAndReport(issuedAt: Double, delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) {
        let queuedMs = Int((ProcessInfo.processInfo.systemUptime - issuedAt) * 1000)
        log.info("Start item=\(self.startIndex + 1) seekSeconds=\(self.startSeconds) workerWaitMs=\(queuedMs)")
        do {
            try play(delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
            report("Finished \(tracks.count) track(s)", terminal: "ended")
        } catch is CancellationError {
            report("Stopped", terminal: "ended")
        } catch let error as PlaybackError {
            diagnostics?.record("Playback stopped: \(error.errorDescription ?? "decoder error")")
            report(error.errorDescription ?? "Playback failed", terminal: "error")
        } catch let error as NativeAccountError {
            diagnostics?.record("Playback lookup stopped: \(error.rawValue)")
            report(error == .forbidden ? "OneDrive denied access to this recording" : "Playback lookup: \(error.rawValue)", terminal: "error")
        } catch {
            report("Playback failed (\((error as NSError).code))", terminal: "error")
        }
        let retiringSources = lock.withLock {
            if started {
                let frame = min(renderedFrame(), scheduled)
                anchor = audibleAnchor(at: frame)
                successor = nil
                lastPosition = Double(anchor.fileFrame + max(0, frame - anchor.nodeFrame)) / Double(rate)
            }
            node.stop()
            started = false
            defer { sources.removeAll() }
            return sources
        }
        retiringSources.forEach { $0.cancelAndDrain() }
        #if DEBUG
        if capturing { node.removeTap(onBus: 0) }
        #endif
        engine.stop()
        #if os(iOS)
        if sessionActivated { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        #endif
    }

    /// Defer decoding a paused seek until Play. Replacing or stopping the run also releases this wait.
    private func waitWhilePaused() throws {
        while lock.withLock({ paused && !cancelled }) { resumeOrStop.wait() }
        try checkCancellation()
    }

    private func play(delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool) throws {
        try waitWhilePaused()
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback)
        try audio.setActive(true)
        sessionActivated = true
        #endif
        var (source, decoder) = try open(tracks[startIndex], ordinal: startIndex + 1, speculative: false, admitted: admitted)
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
        let firstFrame = nearEnd ? max(0, decoder.frames - Int64(16*rate)) : min(max(0, decoder.frames - 1), Int64(startSeconds * Double(rate)))
        var chunk = try decode(decoder, from: firstFrame, seconds: 4, seek: firstFrame > 0)
        source?.finishMeteredSeek()
        // A cellular seek can outlast the entire diagnostic capture. Start rendering when PCM is ready.
        try checkCancellation()
        lock.withLock {
            anchor = Anchor(index: startIndex, nodeFrame: 0, fileFrame: firstFrame + Int64(chunk.audible.lowerBound), duration: decoder.frames)
        }
        try engine.start()
        var nextFrame = firstFrame + Int64(chunk.pcm.frameLength)
        var ordinal = startIndex + 1
        var failedSuccessor: Int?
        do {
            while true {
                // The same worker supplies early Wi-Fi Next and the natural join. It never schedules output.
                let prepared = WorkerReply<(MediaRanges?, MP3RangeDecoder, Chunk)>()
                let demandAllowed = DispatchSemaphore(value: 0)
                let nearJoin = DispatchGroup()
                nearJoin.enter()
                var atJoin = false
                let allowSuccessorAudio = DispatchSemaphore(value: 0)
                let currentBytes = source?.file.size ?? 0
                // The audible clock, not the decoder's queued end or its most recent MP3 metadata probe.
                let byteCursor = { [self] () -> Int64? in
                    lock.withLock {
                        guard !paused, anchor.duration > 0 else { return nil }
                        let elapsed = anchor.fileFrame + max(0, min(renderedFrame(), scheduled) - anchor.nodeFrame)
                        let fraction = min(1, Double(elapsed) / Double(anchor.duration))
                        return Int64(exactly: (Double(currentBytes) * fraction).rounded(.down)) ?? currentBytes
                    }
                }
                let successorPrefix = { () -> Int64 in
                    guard let cursor = byteCursor() else { return 0 }
                    return max(0, MediaRanges.wifiWindow - (currentBytes - cursor))
                }
                let nextIndex = successorAfterEnd(of: ordinal - 1)
                if let index = nextIndex {
                    let next = tracks[index]
                    DispatchQueue.global(qos: .utility).async { [self] in
                        prepared.finish(Result {
                            // Early media reads are Wi-Fi only. On downgrade wait until normal join preparation.
                            let wifiOnly = {
                                while nearJoin.wait(timeout: .now()) == .timedOut {
                                    try self.checkCancellation()
                                    if self.pool.unmeteredWiFi() { return true }
                                    _ = nearJoin.wait(timeout: .now() + 0.1)
                                }
                                return false
                            }
                            let (incoming, decoder) = try open(next, ordinal: index + 1, speculative: true, wifiOnly: wifiOnly, successorPrefix: successorPrefix, beforeDecoding: {
                                allowSuccessorAudio.wait()
                                try self.checkCancellation()
                            }) {
                                while demandAllowed.wait(timeout: .now() + 0.1) == .timedOut { try self.checkCancellation() }
                                try self.checkCancellation()
                            }
                            return (incoming, decoder, try decode(decoder, from: 0, seconds: 12))
                        })
                    }
                }
                defer {
                    if !atJoin {
                        // A foreground decode failure retires its early preparation even if Graph is retrying.
                        if nextIndex != nil {
                            try? drainAudio()
                            cancel()
                        }
                        nearJoin.leave()
                    }
                    if nextIndex != nil {
                        allowSuccessorAudio.signal()
                        demandAllowed.signal()
                        prepared.ready.wait()
                    }
                }
                // For each full track this cursor advances exactly once, including across URL replacement.
                if !chunk.final {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    repeat {
                        try wait(until: scheduled - Int64(8*rate))
                        if let source, let cursor = byteCursor(), scheduled - clock >= Int64(3*rate) {
                            if pool.unmeteredWiFi() {
                                try source.extendWindow(from: cursor, to: cursor + min(currentBytes-cursor, MediaRanges.wifiWindow))
                                let prefix = successorPrefix()
                                if nextIndex != nil, prefix > 0 {
                                    allowSuccessorAudio.signal()
                                    if prepared.ready.wait(timeout: .now()) == .success,
                                       case .success(let (incoming, _, _))? = prepared.result {
                                        try incoming?.extendWindow(from: 0, to: prefix)
                                    }
                                }
                            } else {
                                let duration = Double(decoder.frames) / Double(rate)
                                let through = min(duration, Double(nextFrame) / Double(rate) + 45)
                                let target = MP3RangeDecoder.estimatedSeekByte(seconds: through, duration: duration,
                                    size: currentBytes, header: pool.read(source.file, at: 0))
                                try source.extendMeteredWindow(through: target)
                            }
                        }
                        chunk = try decode(decoder, from: nextFrame, seconds: 4)
                        nextFrame += Int64(chunk.pcm.frameLength)
                        if !chunk.final { try enqueue(chunk.pcm, frames: chunk.audible) }
                    } while !chunk.final
                }
                if chunk.audible.isEmpty { try waitWhilePaused() }
                guard let nextIndex else {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    try drainAudio()
                    return
                }

                // The final 88 playable frames suffice for the mix. Start preparing while earlier PCM is audible.
                let tail = chunk.audible
                var hold = min(88, tail.count, chunk.playableCount/2)
                try enqueue(chunk.pcm, frames: tail.lowerBound..<(tail.upperBound-hold))
                nearJoin.leave()
                atJoin = true
                allowSuccessorAudio.signal()
                let runwaySeconds = Double(scheduled-clock)/Double(rate)
                let late = prepared.ready.wait(timeout: .now() + max(0,runwaySeconds-0.1)) == .timedOut
                if late {
                    try enqueue(chunk.pcm, frames: (tail.upperBound-hold)..<tail.upperBound)
                    hold = 0
                    let remaining = max(0, Double(scheduled-clock)/Double(rate))
                    if prepared.ready.wait(timeout: .now() + remaining) == .timedOut {
                        do { try wait(until: scheduled) }
                        catch {
                            // An interrupted output cannot promote this worker. Unblock its I/O before joining it.
                            cancel()
                            throw error
                        }
                        demandAllowed.signal()
                        prepared.ready.wait()
                    }
                }
                let (incoming, nextDecoder, ready): (MediaRanges?, MP3RangeDecoder, Chunk)
                do { (incoming,nextDecoder,ready) = try prepared.result.get() }
                catch {
                    try enqueue(chunk.pcm, frames: (tail.upperBound-hold)..<tail.upperBound)
                    failedSuccessor = nextIndex
                    throw error
                }
                if let incoming, incoming.speculative {
                    try incoming.extendWindow(from: 0, to: successorPrefix())
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
                let retain = head.final && successorAfterEnd(of: nextIndex) != nil ? min(88,head.audible.count/2) : 0
                let cut = head.audible.upperBound-retain
                let boundary = try enqueue(head.pcm, frames: head.audible.lowerBound..<cut,
                                           incoming: (nextIndex, nextDecoder.frames))
                log.notice("ready item=\(nextIndex + 1) prefixFrames=\(cut-head.audible.lowerBound) specBytes=\(incoming?.specBytes ?? 0) overlap=\(mix) boundary=\(boundary)")
                try wait(until: boundary)
                lock.withLock {
                    if let successor { anchor = successor; self.successor = nil }
                }
                source?.cancelAndDrain()
                lock.withLock { sources.removeAll { $0 === source } }
                ordinal = nextIndex + 1
                report("Playing track \(ordinal)")
                if let incoming {
                    // The player consumes the runway independently of this lookup and its first new range.
                    incoming.promote()
                    if forceRefresh, !head.final, case .oneDrive(let recording) = tracks[ordinal-1] {
                        diagnostics?.record("CDN item=\(ordinal) promotion; renewing media URL forcedAuth=\(forceRefresh)")
                        try incoming.renewLocation { try resolve(recording, .force, delay: delaySeconds) }
                    }
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
            if !lock.withLock({ cancelled }) { try drainAudio() }
            if let failedSuccessor {
                lock.withLock {
                    anchor = Anchor(index: failedSuccessor, nodeFrame: scheduled, fileFrame: 0, duration: 0)
                    successor = nil
                }
            }
            throw error
        }
    }

    private func open(_ recording: Recording, ordinal: Int, speculative: Bool, admitted: MediaLocation? = nil, wifiOnly: (() throws -> Bool)? = nil, successorPrefix: (() -> Int64)? = nil, beforeDecoding: (() throws -> Void)? = nil, awaitDemand: (() throws -> Void)? = nil) throws -> (MediaRanges?, MP3RangeDecoder) {
        let track: IndexedTrack
        switch recording {
        case .oneDrive(let indexed): track = indexed
        #if DEBUG
        case .local(let url):
            try beforeDecoding?()
            let file = try LocalMP3(url)
            return (nil, try MP3RangeDecoder(bytes: file.size, read: file.read))
        #endif
        }
        // Resolve the immediate successor on either route. Its decoder and CDN wait for audio eligibility.
        let media = try resolve(track, .reuse(admitted))
        try beforeDecoding?()
        if let admitted, admitted.etag != media.etag || admitted.size != media.size {
            throw PlaybackError("Recording changed during playback")
        }
        let source = try MediaRanges(media, drive: track.driveId, item: track.itemId, pool: pool, budget: budget, occurrence: ordinal, speculative: speculative, wifiOnly: wifiOnly, successorPrefix: successorPrefix, signalDebug: { [signalChange] in signalChange(true) }, trace: { [log] entry in
            log.info("range item=\(ordinal) \(entry, privacy: .public)")
        }, diagnostic: { [diagnostics] event in diagnostics?.record("CDN item=\(ordinal) \(event)") }, awaitDemand: awaitDemand, renew: { [unowned self] rejected in try self.resolve(track, .replace(rejected), wifiOnly: wifiOnly) })
        try lock.withLock {
            if cancelled { throw CancellationError() }
            guard !media.accessDenied else { throw NativeAccountError.forbidden }
            sources.append(source)
        }
        if !speculative, startSeconds > 0, anchor.duration > 0 {
            let duration = Double(anchor.duration) / Double(rate)
            source.meteredSeekByte = MP3RangeDecoder.estimatedSeekByte(seconds: startSeconds, duration: duration,
                size: media.size, header: pool.read(source.file, at: 0))
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
        // MP3 duration is an estimate. A successful zero-frame read at a positive cursor is clean EOF,
        // including a seek past the last playable frame. A recording must still decode some audio at zero.
        guard n > 0 || position > 0 else { throw PlaybackError("Recording contains no decodable audio") }
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
