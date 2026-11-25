#if CELLULAR_PROBE
import AVFoundation
import MediaPlayer
import SwiftUI

/// The test owns one serial decode worker. Only the player node runs on the render thread.
final class CellularRun: @unchecked Sendable {
    let id = UUID()
    let mode: String
    let muted: Bool
    let trace: (String) -> Void
    private let lock = NSLock()
    private var sources = [MeteredSource]()
    private var cancelled = false
    private var longPreparation: MeteredSource?
    // The node owns all queued samples after commit. Editing that successor then needs a reschedule.
    private var committed: Int?
    private var replacement: Int?
    private var title = ""
    private var fileOffset = 0.0
    private var command: (item: Int, seconds: Double?)?
    private var current = -1
    private var elapsed = 0.0
    private let node = AVAudioPlayerNode()
    private let engine = AVAudioEngine()
    private let rate = 44100
    private var scheduled: Int64 = 0
    private var hasPlayed = false

    init(_ mode: String, muted: Bool, trace: @escaping (String) -> Void) {
        self.mode = mode
        self.muted = muted
        self.trace = trace
    }

    func snapshot() -> [String: Any] {
        lock.withLock { ["occurrence": current, "seconds": elapsed, "fileSeconds": fileOffset+elapsed, "title": title, "run": id.uuidString] }
    }

    /// Requests carry the identity visible at gesture start. The worker checks again before applying.
    func request(item: Int, seconds: Double?) -> Bool {
        lock.withLock {
            guard !cancelled, current == item, current >= 0 else {
                trace("stale command for=\(item) current=\(current)")
                return false
            }
            command = (item, seconds)
            trace("command item=\(item) seconds=\(seconds.map(String.init(describing:)) ?? "next")")
            return true
        }
    }

    func skipLongPreparation() {
        lock.withLock {
            trace("skip two-hour preparation pending=\(longPreparation != nil)")
            longPreparation?.cancel()
        }
    }

    /// A command names its predecessor. A gesture cannot silently edit a different join after promotion.
    @discardableResult func replaceUpcoming(after expected: Int, with track: Int) -> Bool {
        lock.withLock {
            let accepted = current == expected && committed == nil
            if accepted { replacement = track }
            trace("replace after=\(expected) withTrack=\(track+1) current=\(current) committed=\(String(describing: committed)) accepted=\(accepted)")
            return accepted
        }
    }

    func cancel() {
        lock.withLock { cancelled = true; sources.forEach { $0.cancel() } }
    }

    private func check() throws {
        if lock.withLock({ cancelled }) { throw CancellationError() }
    }

    /// Source registration and cancellation share one lock so a late preparation cannot escape Stop.
    private func open(_ media: RemoteMP3, _ item: Int, speculative: Bool) throws -> (MeteredSource, MP3RangeDecoder) {
        let source = try MeteredSource(media, number: item, speculative: speculative, trace: trace)
        try lock.withLock {
            if cancelled { throw CancellationError() }
            sources.append(source)
        }
        trace("prepare item=\(item) name=\(media.name) speculative=\(speculative)")
        return (source, try MP3RangeDecoder(bytes: media.bytes, read: source.read))
    }

    private var clock: Int64 {
        guard let t = node.lastRenderTime, let p = node.playerTime(forNodeTime: t) else { return 0 }
        return p.sampleTime
    }

    private func append(_ pcm: AVAudioPCMBuffer) {
        node.scheduleBuffer(pcm)
        scheduled += Int64(pcm.frameLength)
    }

    private func slice(_ pcm: AVAudioPCMBuffer, _ range: Range<Int>) throws -> AVAudioPCMBuffer {
        guard range.lowerBound >= 0, range.upperBound <= pcm.frameLength, !range.isEmpty,
              let part = AVAudioPCMBuffer(pcmFormat: pcm.format, frameCapacity: UInt32(range.count)) else {
            throw ProbeError("Invalid PCM slice")
        }
        part.frameLength = UInt32(range.count)
        for ch in 0..<Int(pcm.format.channelCount) {
            part.floatChannelData![ch].update(from: pcm.floatChannelData![ch] + range.lowerBound, count: range.count)
        }
        return part
    }

    /// The ten original rips have version-only LAME tags. The probe manifest identifies this fixture set.
    private func quiet(_ pcm: AVAudioPCMBuffer, tail: Bool) -> Int {
        let n = Int(pcm.frameLength)
        let limit = min(n, tail ? 6615 : 1543)
        for i in 0..<limit {
            let index = tail ? n-1-i : i
            for ch in 0..<Int(pcm.format.channelCount) where abs(pcm.floatChannelData![ch][index]) > 0.0001 { return i }
        }
        return limit
    }

    private func position(_ item: Int, _ seconds: Double) {
        lock.withLock { current = item; elapsed = seconds }
    }

    /// Output-node time is meaningful through a starvation interval as well as during audible output.
    private func wait(until target: Int64, item: Int, origin: Int64, allowCommand: Bool = false) throws -> (Int, Double?)? {
        while clock < target {
            try check()
            let now = clock
            position(item, Double(max(0, now-origin)) / Double(rate))
            if allowCommand, let action = lock.withLock({ let action = command; command = nil; return action }), action.item == item {
                return action
            }
            Thread.sleep(forTimeInterval: 0.012)
        }
        return nil
    }

    /// For a short listening trial the first item starts near its real end. The album trial streams whole tracks.
    func play() throws {
        let docs = URL.documentsDirectory
        let tracks = try JSONDecoder().decode([RemoteMP3].self, from: Data(contentsOf: docs.appendingPathComponent("cellular.json")))
        guard tracks.count == 11 else { throw ProbeError("Expected ten MP3s and the cancellation control") }
        let album = mode == "album"
        var queue = album ? Array(0..<10) : mode == "join03" ? [2,3] : ["advance","web"].contains(mode) ? [1,2,3] : [1,2]
        let delay = mode == "five" ? 5.0 : 10.0
        let prefix = mode == "short" ? rate : 12*rate
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback)
        try session.setActive(true)
        trace("session mode=\(mode) muted=\(muted) route=\(session.currentRoute.outputs.map(\.portName)) rate=\(session.sampleRate)")
        let (firstSource,first) = try open(tracks[queue[0]], 0, speculative: false)
        let fmt = first.format
        engine.mainMixerNode.outputVolume = muted ? 0 : 1
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        // Record the rendered graph, including any silence during a short-prefix stall.
        let captureURL = docs.appendingPathComponent("cellular-\(mode).caf")
        if !album {
            let capture = try AVAudioFile(forWriting: captureURL, settings: fmt.settings)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: captureURL.path)
            node.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [trace] pcm, _ in
                do { try capture.write(from: pcm) } catch { trace("capture error \((error as NSError).code)") }
            }
        }
        defer {
            node.stop()
            if !album { node.removeTap(onBus: 0) }
            engine.stop()
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            cancel()
        }
        try engine.start()
        var decoder = first
        var source = firstSource
        var item = 0
        var origin: Int64 = 0
        let firstStart = album ? 0 : max(0,first.frames-Int64(16*rate))
        lock.withLock { title = tracks[queue[0]].name; fileOffset = Double(firstStart)/Double(rate) }
        var readPosition = firstStart
        var pending = try decoder.decode(album ? 4*rate : Int(first.frames-firstStart), at: firstStart)
        readPosition += Int64(pending.frameLength)
        if firstStart == 0 && !decoder.hasDeclaredTiming {
            let head = quiet(pending, tail: false)
            pending = try slice(pending, head..<Int(pending.frameLength))
        }

        while true {
            try check()
            // Keep the final buffer for the edge detector. Current demand is decoded in four-second windows.
            let last = item+1 == queue.count
            let excerpt = (!album && last) || (mode == "web" && item == 1)
            let end = excerpt ? min(decoder.frames, Int64(22*rate)) : decoder.frames
            var skip = false
            while readPosition < end {
                append(pending)
                if !hasPlayed { position(item,0); node.play(); hasPlayed = true; trace("playing item=\(item)") }
                if let action = try wait(until: scheduled-Int64(8*rate), item: item, origin: origin, allowCommand: !last) {
                    if action.1 == nil {
                        skip = true
                        trace("advance requested while streaming item=\(item)")
                        break
                    }
                    trace("seek outside prepared audition window")
                }
                let remaining = end-readPosition
                // Keep at least a full silence window in the final chunk.
                let count = remaining <= Int64(5*rate) ? Int(remaining) : 4*rate
                pending = try decoder.decode(count)
                guard pending.frameLength > 0 else { throw ProbeError("Unexpected decoder EOF") }
                readPosition += Int64(pending.frameLength)
            }
            if last {
                let tail = end == decoder.frames && !decoder.hasDeclaredTiming ? quiet(pending, tail: true) : 0
                let count = Int(pending.frameLength)
                if tail > 0 && tail < count { append(try slice(pending, 0..<(count-tail))) }
                else { append(pending) }
                _ = try wait(until: scheduled, item: item, origin: origin)
                trace("finished item=\(item) playedThroughPrefix=true")
                return
            }
            let tail = !skip && end == decoder.frames && !decoder.hasDeclaredTiming ? quiet(pending, tail: true) : 0
            let endOfTail = Int(pending.frameLength)-tail
            let next = item+1
            let tailBase = scheduled
            let tailPosition = tailBase-origin
            let early = skip ? 0 : max(0,endOfTail-rate*3)
            if early > 0 {
                append(try slice(pending, 0..<early))
                if !hasPlayed {
                    position(item,0); node.play(); hasPlayed = true
                    trace("playing item=\(item) preparing next")
                }
            }
            if mode == "cancel" && item == 0 {
                let long = try MeteredSource(tracks[10], number: 99, speculative: true, trace: trace)
                lock.withLock { sources.append(long); longPreparation = long }
                // Script the same Skip action as the screen once real data has reached the delegate.
                long.onFirstBlockData = { [weak self] in self?.skipLongPreparation() }
                do {
                    let d = try MP3RangeDecoder(bytes: long.media.bytes, read: long.read)
                    _ = try d.decode(prefix)
                    throw ProbeError("Cancellation control unexpectedly completed")
                } catch is CancellationError {
                    trace("cancel drained item=99 charged=\(long.specBytes)")
                }
                lock.withLock { sources.removeAll { $0 === long }; longPreparation = nil }
            }
            let choice = lock.withLock { () -> Int in
                committed = next
                let track = replacement ?? queue[next]
                replacement = nil
                return track
            }
            queue[next] = choice
            let (nextSource,nextDecoder) = try open(tracks[queue[next]], next, speculative: true)
            let runway = try nextDecoder.decode(prefix)
            let head = nextDecoder.hasDeclaredTiming ? 0 : quiet(runway, tail: false)
            let overlap = !skip && (tail > 0 || head > 0) ? 88 : 0
            let cut = endOfTail-overlap
            let prefixFrames = Int(runway.frameLength)
            trace("ready item=\(next) frames=\(prefixFrames-head) bytes=\(nextSource.specBytes) tail=\(tail) head=\(head) overlap=\(overlap)")
            if skip { node.stop(); scheduled = 0 }
            else { append(try slice(pending, early..<cut)) }
            var boundary = scheduled
            let bridge = try slice(runway, head..<prefixFrames)
            if overlap > 0 {
                for ch in 0..<2 {
                    for k in 0..<overlap {
                        let gain = Float(k)/Float(overlap-1)
                        let right = bridge.floatChannelData![ch]
                        right[k] = pending.floatChannelData![ch][cut+k]*(1-gain) + right[k]*gain
                    }
                }
            }
            append(bridge)
            if skip { node.play(); trace("native next applied item=\(next)") }
            if !hasPlayed { position(item,0); node.play(); hasPlayed = true; trace("playing item=\(item) leadFrames=\(cut)") }
            if mode == "raceBefore" {
                _ = try wait(until: boundary-Int64(rate/10), item: item, origin: origin)
                trace("race before playerFrame=\(clock) boundary=\(boundary)")
                replaceUpcoming(after: item, with: 3)
            }
            while let (_, seek) = try wait(until: boundary, item: item, origin: origin, allowCommand: true) {
                if let seek {
                    // The listening shortcut exposes its cached, audible tail as the scrub window.
                    guard let local = Int(exactly: Int64(seek*Double(rate))-tailPosition), (0..<cut).contains(local) else {
                        trace("seek outside prepared audition window"); continue
                    }
                    node.stop(); scheduled = 0
                    append(try slice(pending, local..<cut))
                    boundary = scheduled
                    append(bridge); node.play()
                    origin = -Int64(seek*Double(rate))
                    trace("seek applied item=\(item) seconds=\(seek)")
                } else {
                    node.stop(); scheduled = 0; boundary = 0
                    append(bridge); node.play(); trace("native next applied item=\(next)")
                    break
                }
            }
            let actual = clock
            lock.withLock { current = next; elapsed = 0; fileOffset = Double(head)/Double(rate); title = tracks[queue[next]].name; committed = nil }
            if mode == "raceAfter" {
                DispatchQueue.global().asyncAfter(deadline: .now()+0.1) { [weak self, item] in
                    self?.replaceUpcoming(after: item, with: 3)
                }
            }
            source.cancel()
            lock.withLock { sources.removeAll { $0 === source } }
            nextSource.promote()
            trace("lookup start item=\(next) boundary=\(boundary) playerFrame=\(actual)")
            let renewalEnd = ProcessInfo.processInfo.systemUptime + delay
            while ProcessInfo.processInfo.systemUptime < renewalEnd {
                try check()
                position(next,Double(max(0,min(clock,scheduled)-boundary))/Double(rate))
                Thread.sleep(forTimeInterval: 0.015)
            }
            try nextSource.finishRenewal()
            trace("lookup end item=\(next) playerFrame=\(clock)")
            item = next; origin = boundary; source = nextSource; decoder = nextDecoder
            readPosition = Int64(prefixFrames)
            pending = try decoder.decode(2*rate)
            readPosition += Int64(pending.frameLength)
            if clock > scheduled {
                let stalled = clock-scheduled
                trace("stall item=\(item) frames=\(stalled)")
                origin += stalled
                scheduled += stalled
            }
            trace("continuation ready item=\(item) runwayRemainingFrames=\(scheduled-clock)")
        }
    }
}
#endif
