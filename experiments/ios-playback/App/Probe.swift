import AVFoundation
import SwiftUI

enum Source: String, CaseIterable { case pcm = "PCM", original = "AVQueue", trimmed = "Edited WAV", hard = "Hard-cut WAV", untrimmed = "Uncut WAV" }

@MainActor final class Playback: ObservableObject {
    @Published var status = "Ready"
    @Published var storage = "Checking…"
    let logURL = URL.documentsDirectory.appendingPathComponent("gate1.log")
    private let media = Bundle.main.bundleURL.appendingPathComponent("Media")
    private var player: AVQueuePlayer?
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var queue: [(item: AVPlayerItem, name: String)] = []
    private var clockObserver: Any?
    private var inserted = 0
    private var run = UUID()

    init() {
        record("launch iOS=\(ProcessInfo.processInfo.operatingSystemVersionString) model=\(UIDevice.current.model)")
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged),
            name: AVAudioSession.routeChangeNotification, object: nil)
    }

    /// Persist host uptime on every event so evidence survives process termination.
    func record(_ message: String) {
        let line = String(format: "%.6f", ProcessInfo.processInfo.systemUptime) + " \(run) \(message)\n"
        do {
            if !FileManager.default.fileExists(atPath: logURL.path) {
                try Data().write(to: logURL)
            }
            let file = try FileHandle(forWritingTo: logURL)
            defer { try? file.close() }
            try file.seekToEnd()
            try file.write(contentsOf: Data(line.utf8))
        } catch { status = "Trace write failed: " + error.localizedDescription }
    }

    @objc private func routeChanged() {
        let s = AVAudioSession.sharedInstance()
        record("route=\(s.currentRoute.outputs.map(\.portName)) rate=\(s.sampleRate)")
    }

    /// Invalidate the previous seek and queued callbacks before releasing its items.
    func stop() {
        if player != nil || engine != nil { record("stop/cancel") }
        run = UUID()
        if let clockObserver { player?.removeTimeObserver(clockObserver) }
        clockObserver = nil
        observations.removeAll()
        for token in notifications { NotificationCenter.default.removeObserver(token) }
        notifications.removeAll()
        node?.stop()
        engine?.stop()
        node = nil
        engine = nil
        player?.pause()
        player?.removeAllItems()
        player = nil
        queue = []
        inserted = 0
        status = "Ready"
        UIApplication.shared.isIdleTimerDisabled = false
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { record("session deactivation: \(error.localizedDescription)") }
    }

    /// Shortcuts use the same original files and end points as the full album queue.
    func play(_ track: String, source: Source) async {
        stop()
        let token = run
        let full = track == "album"
        let live = full || source == .original || source == .pcm
        let first = full ? "02" : track == "tagged-pair" ? "tagged" : track
        let ids = full ? ["02", "03", "04"] : (live ? [first, track == "tagged-pair" ? "tagged" : first == "02" ? "03" : "04"] : [track])
        do {
            // Auto-lock ends the iOS screen recording. Restore the normal idle timer after each audition.
            UIApplication.shared.isIdleTimerDisabled = true
            status = "Preparing…"
            record("prepare \(track) \(source.rawValue)")
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback)
            try session.setActive(true)
            routeChanged()
            let fixtures = try JSONDecoder().decode([String: Fixture].self, from: Data(contentsOf: media.appendingPathComponent("frames.json")))
            var prepared: [(AVPlayerItem, String)] = []
            let pcmNode = source == .pcm ? AVAudioPlayerNode() : nil
            if let pcmNode {
                let mixer = AVAudioEngine()
                mixer.attach(pcmNode)
                engine = mixer
                node = pcmNode
            }
            var slices: [Slice] = []
            for (idx, id) in ids.enumerated() {
                let name = live ? id + (id == "quiet" ? ".wav" : ".mp3") :
                    id + (source == .trimmed ? "-trimmed.wav" : source == .hard ? "-hard.wav" : "-untrimmed.wav")
                let url = media.appendingPathComponent(name)
                let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                record("local occurrence=\(idx) file=\(name) fileBytes=\(bytes)")
                guard live else {
                    prepared.append((AVPlayerItem(url: url), name))
                    continue
                }
                guard let fixture = fixtures[id] else { throw ProbeError("Missing fixture: " + id) }
                let file = try AVAudioFile(forReading: url)
                let region = try decodedBounds(file, fixture: fixture, mp3: url.pathExtension == "mp3")
                let start = !full && idx == 0 ? max(region.lowerBound, region.upperBound - 4*44100) : region.lowerBound
                let end = !full && idx == 1 ? min(region.upperBound, start + 4*44100) : region.upperBound
                record("trim \(name) head=\(region.lowerBound) tail=\(file.length-region.upperBound) frames; play [\(start),\(end))")
                slices.append(Slice(file: file, start: start, end: end,
                                    trimmedHead: region.lowerBound > 0, trimmedTail: region.upperBound < file.length))
            }
            var usedHead: Int64 = 0
            for (idx, slice) in slices.enumerated() {
                let file = slice.file, url = file.url, name = url.lastPathComponent
                let next = idx+1 < slices.count ? slices[idx+1] : nil
                let overlap = next.map { slice.overlapFrames(with: $0) } ?? 0
                let start = slice.start + usedHead, end = slice.end
                usedHead = overlap
                if next != nil { record("splice after occurrence=\(idx) overlapFrames=\(overlap)") }
                if let pcmNode, let engine {
                    if idx == 0 { engine.connect(pcmNode, to: engine.mainMixerNode, format: file.processingFormat) }
                    // A nil time appends directly after the preceding region on one continuous node clock.
                    let finished: AVAudioPlayerNodeCompletionHandler = { [weak self] _ in
                        Task { @MainActor in
                            guard let self, self.run == token else { return }
                            self.record("played occurrence=\(idx) \(name)")
                            if idx + 1 == ids.count {
                                self.record("queue finished")
                                self.stop()
                                self.status = "Finished"
                            } else { self.status = "Playing " + ids[idx+1] }
                        }
                    }
                    pcmNode.scheduleSegment(file, startingFrame: start, frameCount: AVAudioFrameCount(end-start-overlap),
                                            at: nil, completionCallbackType: .dataPlayedBack) { type in
                        if overlap == 0 { finished(type) }
                    }
                    if let next, overlap > 0 {
                        try scheduleSplice(on: pcmNode, from: slice, to: next, frames: overlap, completion: finished)
                    }
                    record("ready \(name)")
                } else {
                    // Each AVQueue item has its own source range, including the trimmed successor start.
                    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
                    guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw ProbeError("Missing audio track") }
                    guard token == run else { return }
                    let composition = AVMutableComposition()
                    guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                        throw ProbeError("Cannot create audio track")
                    }
                    let range = CMTimeRange(start: CMTime(value: start, timescale: 44100), end: CMTime(value: end, timescale: 44100))
                    try audio.insertTimeRange(range, of: track, at: .zero)
                    let item = AVPlayerItem(asset: composition)
                    if let next, overlap > 0 {
                        let successor = AVURLAsset(url: next.file.url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
                        guard let sourceTrack = try await successor.loadTracks(withMediaType: .audio).first,
                              let incoming = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                            throw ProbeError("Cannot load the incoming splice")
                        }
                        guard token == run else { return }
                        let length = CMTime(value: overlap, timescale: 44100)
                        let at = range.duration - length
                        try incoming.insertTimeRange(CMTimeRange(start: CMTime(value: next.start, timescale: 44100), duration: length),
                                                     of: sourceTrack, at: at)
                        let ramp = CMTimeRange(start: at, duration: CMTime(value: overlap-1, timescale: 44100))
                        let a = AVMutableAudioMixInputParameters(track: audio)
                        let b = AVMutableAudioMixInputParameters(track: incoming)
                        a.setVolumeRamp(fromStartVolume: 1, toEndVolume: 0, timeRange: ramp)
                        b.setVolumeRamp(fromStartVolume: 0, toEndVolume: 1, timeRange: ramp)
                        let mix = AVMutableAudioMix()
                        mix.inputParameters = [a,b]
                        item.audioMix = mix
                    }
                    prepared.append((item, name))
                }
            }
            if let pcmNode, let engine {
                try engine.start()
                pcmNode.play()
                status = "Playing " + first
                record("play PCM")
                return
            }
            queue = prepared
            let p = AVQueuePlayer()
            player = p
            // Only the current and its immediate successor enter AVQueuePlayer.
            func fillWindow() {
                while p.items().count < 2 && inserted < queue.count {
                    p.insert(queue[inserted].item, after: p.items().last)
                    inserted += 1
                }
            }
            fillWindow()
            for (item, name) in queue {
                observations.append(item.observe(\.status, options: [.initial,.new]) { [weak self] item, _ in
                    let state = item.status
                    Task { @MainActor in
                        guard let self, self.run == token else { return }
                        if state == .readyToPlay { self.record("ready \(name)") }
                        if state == .failed { self.fail(item.error?.localizedDescription ?? "Item failed") }
                    }
                })
                for event in [AVPlayerItem.playbackStalledNotification, AVPlayerItem.failedToPlayToEndTimeNotification] {
                    notifications.append(NotificationCenter.default.addObserver(forName: event, object: item, queue: .main) { [weak self] note in
                        let detail = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
                        Task { @MainActor in
                            guard let self, self.run == token else { return }
                            if event == AVPlayerItem.playbackStalledNotification { self.record("stall \(name)") }
                            else { self.fail(detail ?? "Failed to finish " + name) }
                        }
                    })
                }
            }
            observations.append(p.observe(\.currentItem, options: [.initial,.new]) { _, change in
                let item = change.newValue ?? nil
                Task { @MainActor in
                    guard self.run == token else { return }
                    if let item, let row = self.queue.firstIndex(where: { $0.item === item }) {
                        self.status = "Playing " + self.queue[row].name
                        self.record("current occurrence=\(row) \(self.queue[row].name)")
                        fillWindow()
                    } else if item == nil {
                        self.record("queue finished")
                        self.stop()
                        self.status = "Finished"
                    }
                }
            })
            // Sample a running item clock once per occurrence. These scheduling timestamps
            // can diagnose a discontinuity; only recording the output measures the join.
            var clocked = Set<ObjectIdentifier>()
            clockObserver = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self, weak p] _ in
                MainActor.assumeIsolated {
                    guard let self, self.run == token, let item = p?.currentItem,
                          let base = item.timebase, CMTimebaseGetRate(base) > 0,
                          clocked.insert(ObjectIdentifier(item)).inserted,
                          let row = self.queue.firstIndex(where: { $0.item === item }) else { return }
                    let host = CMClockGetHostTimeClock()
                    let origin = CMSyncConvertTime(.zero, from: base, to: host).seconds
                    let end = item.forwardPlaybackEndTime.isNumeric ? item.forwardPlaybackEndTime : item.duration
                    self.record("clock occurrence=\(row) zeroHost=\(origin) endHost=\(CMSyncConvertTime(end, from: base, to: host).seconds)")
                }
            }
            record("play AVQueue")
            p.play()
        } catch {
            if token == run { fail(error.localizedDescription) }
        }
    }

    private func fail(_ reason: String) {
        record("error \(reason)")
        stop()
        status = reason
    }
}

@main struct Gate1App: App {
    @StateObject private var playback = Playback()
    #if CELLULAR_PROBE
    @StateObject private var cellular = CellularController()
    @State private var showCellular = false
    #endif
    @State private var source = Source.pcm
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                List {
                    #if CELLULAR_PROBE
                    Button("Locked cellular trials") { playback.stop(); showCellular = true }
                        .navigationDestination(isPresented: $showCellular) { CellularScreen(probe: cellular) }
                    #endif
                    Section("Listen across a join") {
                        Picker("Source", selection: $source) {
                            ForEach(Source.allCases, id: \.self) { Text($0.rawValue) }
                        }.pickerStyle(.menu)
                        ForEach([("02", "[02] The Thin Ice → [03]"), ("03", "[03] Another Brick → [04]"), ("quiet", "Quiet WAV → [04]"), ("tagged", "Tagged quiet MP3 → [04]"), ("tagged-pair", "Tagged → tagged control")], id: \.0) { id, label in
                            Button(label) { Task { await playback.play(id, source: source) } }
                        }
                    }
                    Section("Playback") {
                        Button("Play full tracks [02]–[04]") { Task { await playback.play("album", source: source == .original ? .original : .pcm) } }
                        HStack { Text(playback.status); Spacer(); Button("Stop") { playback.stop() } }
                    }
                    Section("Web storage on launch") {
                        Text(playback.storage).font(.footnote.monospaced()).textSelection(.enabled)
                    }
                    ShareLink("Share event log", item: playback.logURL)
                }.navigationTitle("OnePlay Probe")
            }
            .background {
                StorageProbe { result in playback.storage = result; playback.record("webkit " + result) }
                    .frame(width: 1, height: 1).accessibilityHidden(true)
            }
            .task {
                // Command-line equivalent of the listening buttons for detached cold runs.
                let args = ProcessInfo.processInfo.arguments
                #if CELLULAR_PROBE
                if let i = args.firstIndex(of: "--cellular"), args.indices.contains(i+1) {
                    showCellular = true
                    if ["web","silent-web","unattended"].contains(args[i+1]) {
                        cellular.webScript = true
                        cellular.startOnAttach = true
                        cellular.unattended = args[i+1] != "web"
                        cellular.runAllControls = args[i+1] == "unattended"
                    }
                    else if args[i+1] == "silent-album" {
                        cellular.unattended = true
                        cellular.start("album")
                    } else { cellular.start(args[i+1]) }
                    return
                }
                #endif
                if let i = args.firstIndex(of: "--trial"), args.indices.contains(i+2),
                   ["02","03","quiet","tagged","tagged-pair","album"].contains(args[i+1]), let mode = Source(rawValue: args[i+2]) {
                    source = mode
                    await playback.play(args[i+1], source: mode)
                }
            }
        }
    }
}
