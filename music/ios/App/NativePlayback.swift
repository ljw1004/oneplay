import AVFoundation
import OSLog

struct IndexedTrack: Decodable, Equatable, Sendable {
    let driveId: String
    let itemId: String
    var path: [String]? = nil
    var key: String? = nil
    var sourceRootKey: String? = nil
    var title: String? = nil
    var album: String? = nil
}

private enum Recording: Sendable {
    case oneDrive(IndexedTrack)
    var indexed: IndexedTrack? {
        if case .oneDrive(let entry) = self { return entry }
        return nil
    }
    #if DEBUG
    case local(URL)
    #endif
}

enum QueueMode: String, CaseIterable {
    case one, timer, all, `repeat`, shuffle

    var following: Self {
        Self.allCases[(Self.allCases.firstIndex(of: self)! + 1) % Self.allCases.count]
    }
}

/// A fenced edit has no trustworthy Next until the revised queue arrives.
private enum NextPolicy { case automatic, manualOnly, fenced }

/// An immutable pass travels with the audible anchor. Preparing a new shuffle pass does
/// not change the current one until its first frame is actually rendered.
private struct PlayCursor {
    let order: [Int]
    let slot: Int
    /// A removed recording is appended outside canonical order. Keep its former neighbors
    /// until handoff, so repeated edits cannot redirect it to the new occupant of its old row.
    var held: Held? = nil
    struct Held {
        let index: Int
        let former: [Int]
        let slot: Int
        let previous: Int?
        let next: Int?
    }
    var index: Int { held?.index ?? order[slot] }

    /// Preserve the shuffle pass across path-only edits. Removing the audible occurrence
    /// retains its former order for one handoff, including through subsequent revisions.
    func revised(for canonical: [Int], from mode: QueueMode, to nextMode: QueueMode) -> Self {
        let current = index
        let samePass = mode == nextMode && (mode == .shuffle ? Set(order) == Set(canonical) : order == canonical)
        if samePass { return self }
        let updated: [Int]
        if nextMode != .shuffle { updated = canonical }
        else if canonical.contains(current) { updated = [current] + canonical.filter { $0 != current }.shuffled() }
        else { updated = canonical.shuffled() }
        if let index = updated.firstIndex(of: current) { return Self(order: updated, slot: index) }

        let former = held?.former ?? order
        let oldSlot = held?.slot ?? slot
        let positions = Dictionary(uniqueKeysWithValues: updated.enumerated().map { ($0.element, $0.offset) })
        return Self(order: updated, slot: 0, held: .init(index: current, former: former, slot: oldSlot,
            previous: former[..<oldSlot].reversed().lazy.compactMap { positions[$0] }.first,
            next: former.dropFirst(oldSlot + 1).lazy.compactMap { positions[$0] }.first))
    }

    func neighbor(_ step: Int, mode: QueueMode) -> Self? {
        if let held {
            return (step < 0 ? held.previous : held.next).map { Self(order: order, slot: $0) }
        }
        let target = slot + step
        if order.indices.contains(target) { return Self(order: order, slot: target) }
        guard mode == .repeat || mode == .shuffle else { return nil }
        if step > 0 && mode == .shuffle && order.count > 1 {
            var pass = order.shuffled()
            if pass[0] == index { pass.swapAt(0, Int.random(in: 1..<pass.count)) }
            return Self(order: pass, slot: 0)
        }
        return Self(order: order, slot: step > 0 ? 0 : order.count - 1)
    }
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
    private var mode = QueueMode.all
    private var timerSetting = "30m"
    private var expiry: Task<Void, Never>?
    private var deadline: ContinuousClock.Instant?
    private let timerInterval: @Sendable (Int) -> Duration
    private var timerGeneration = 0
    private var folder: [String] = []
    private var folderKey = ""
    private var session = ""
    private var revision = 0
    private var targetRevision = 0
    private var fencedRevision: Int?
    private var continueAfterFence = false
    // Slot numbers are stable within a session, including while its queue is edited.
    private var catalog = [Recording]()
    private var slots = [String: Int]()
    private var canonical = [Int]()
    private var deniedRoots = Set<String>()
    private var connectedShares: Set<String>?
    private func blocked(_ root: String) -> Bool {
        deniedRoots.contains(root) || (root.hasPrefix("share:") && connectedShares?.contains(root) == false)
    }
    private func nextPolicy(for mode: QueueMode) -> NextPolicy {
        if fencedRevision != nil { return .fenced }
        return mode == .one || (mode == .timer && timerSetting == "end-of-track") ? .manualOnly : .automatic
    }
    private var pool: MediaPool

    @MainActor var onChange: ((_ debugOnly: Bool) -> Void)?

    init(captureURL: URL = NativePlayback.captureURL, diagnostics: NativeDiagnostics? = nil, pool: MediaPool = MediaPool(), timerInterval: @escaping @Sendable (Int) -> Duration = { .seconds($0 * 60) }, lookup: @escaping Lookup) {
        self.pool = pool
        self.timerInterval = timerInterval
        destination = captureURL
        self.diagnostics = diagnostics
        self.lookup = lookup
    }
    var status: String { lock.withLock { active?.status ?? "Stopped" } }
    var sessionID: String { lock.withLock { active == nil ? "" : session } }

    /// A fresh document samples the running node without restarting the decoder.
    var snapshot: [String: Any] { snapshot(lookups: nil) }

    func snapshot(lookups: [IndexedTrack]?) -> [String: Any] {
        lock.withLock {
            var result = active?.snapshot(lookups: lookups) ?? [:]
            result["mode"] = mode.rawValue
            if active != nil && (result["item"] != nil || fencedRevision != nil) {
                result["fenced"] = fencedRevision != nil
                result["session"] = session
                result["folder"] = folder
                result["folderKey"] = folderKey
                result["revision"] = revision
                result["targetRevision"] = targetRevision
            }
            return result
        }
    }

    func start(tracks: [IndexedTrack], startIndex: Int = 0, delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool,
               folder: [String] = [], folderKey: String = "", selected: Bool = true, timer: String? = nil, initialMode: QueueMode? = nil) throws {
        guard tracks.indices.contains(startIndex), [0,5,10].contains(delaySeconds),
              tracks.allSatisfy({ !$0.driveId.isEmpty && !$0.itemId.isEmpty }) else {
            throw PlaybackError("Invalid playback request")
        }
        try lock.withLock {
            let eligible = tracks.indices.filter { !blocked(tracks[$0].sourceRootKey ?? "") }
            guard let first = eligible.first, !selected || eligible.contains(startIndex) else { throw NativeAccountError.forbidden }
            let initial = selected ? startIndex : first
            if let timer { try setTimerSetting(timer) }
            if let initialMode { mode = initialMode }
            else if self.folder.dropFirst().first?.hasPrefix("fav:") == true && self.folder.dropFirst().first != folder.dropFirst().first { mode = .all }
            deadline = nil
            catalog = tracks.map(Recording.oneDrive)
            slots.removeAll()
            for (i, entry) in tracks.enumerated() { if let key = entry.key { slots[key] = i } }
            canonical = eligible

            self.folder = folder
            self.folderKey = folderKey
            session = UUID().uuidString
            revision = 0
            fencedRevision = nil
            let order: [Int]
            if mode != .shuffle { order = eligible }
            else if selected { order = [initial] + eligible.filter { $0 != initial }.shuffled() }
            else { order = eligible.shuffled() }
            replaceRun(cursor: PlayCursor(order: order, slot: selected ? order.firstIndex(of: initial)! : 0),
                       delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
            armTimer(playing: true)
        }
    }

    #if DEBUG
    /// The listener selects original MP3s in Files. Numeric filename order reproduces the album order offline.
    func startLocalFiles(_ urls: [URL], nearEnd: Bool) throws {
        guard !urls.isEmpty, urls.allSatisfy({ $0.isFileURL && $0.pathExtension.lowercased() == "mp3" }) else {
            throw PlaybackError("Choose MP3 files")
        }
        let ordered = urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        lock.withLock {
            mode = .all
            catalog = ordered.map(Recording.local)
            canonical = Array(catalog.indices)
            slots.removeAll()
            armTimer(playing: false)
            replaceRun(cursor: PlayCursor(order: canonical, slot: 0), nearEnd: nearEnd)
        }
    }
    #endif

    /// Called under the player lock. The serial worker drains the retiring run before decoding its replacement.
    private func replaceRun(cursor: PlayCursor, advanced: Bool = false, position: PlaybackRun.Position = .seconds(0), paused: Bool = false,
                            seekItem: String? = nil, duration: MP3RangeDecoder.Length = .unknown, admitted: MediaLocation? = nil, budget: MediaRanges.Budget = .init(),
                            delaySeconds: Int = 0, nearEnd: Bool = false, forceRefresh: Bool = false,
                            issuedAt: Double = ProcessInfo.processInfo.systemUptime) {
        active?.cancel()
        let run = PlaybackRun(tracks: catalog, cursor: cursor, advanced: advanced, mode: mode, nextPolicy: nextPolicy(for: mode), position: position, paused: paused, seekItem: seekItem, duration: duration,
                              admitted: admitted, lookup: lookup, captureURL: destination, diagnostics: diagnostics, pool: pool, budget: budget) { [weak self] debugOnly in
            DispatchQueue.main.async { [weak self] in self?.onChange?(debugOnly) }
        }
        active = run
        run.setDeadline(deadline)
        guard !run.startsAtEnd else { return }
        worker.async {
            run.playAndReport(issuedAt: issuedAt, delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
        }
    }

    /// A command belongs to the item that the listener touched, including a repeated play of the same URL.
    func apply(_ action: String, item: String, seconds: Double?) throws {
        let issuedAt = ProcessInfo.processInfo.systemUptime
        try lock.withLock {
            guard let run = active else { return }
            if fencedRevision != nil && (action == "next" || action == "previous") { return }
            if action == "cycleMode" {
                let next = mode.following
                if configure(run, mode: next, item: item) { armTimer(playing: active?.wantsPlay == true) }
                return
            }
            guard let result = try run.apply(action, item: item, seconds: seconds) else { return }
            if let restart = result.restart {
                // A seek can keep the occurrence. Only a newly accepted target supersedes its wait.
                targetRevision += 1
                replaceRun(cursor: restart.cursor, advanced: restart.advanced, position: restart.position, paused: restart.paused,
                           seekItem: restart.seekItem, duration: restart.duration, admitted: restart.admitted, budget: run.budget, issuedAt: issuedAt)
            }
            if fencedRevision != nil { continueAfterFence = result.playing }
            armTimer(playing: result.playing)
        }
    }

    /// A compatible revision keeps the decoder, node and prepared bytes. Only a different
    /// immediate audio decision needs the existing stop-and-seek path to retract submitted PCM.
    @discardableResult private func configure(_ run: PlaybackRun, mode newMode: QueueMode, item: String? = nil, resumeAtBoundary: Bool = false) -> Bool {
        let updated = run.configure(catalog: catalog, canonical: canonical, mode: newMode,
            nextPolicy: nextPolicy(for: newMode), item: item, blocked: blocked, resumeAtBoundary: resumeAtBoundary)
        guard updated.applied else { return false }
        mode = newMode
        if updated.revoked {
            active = nil
            armTimer(playing: false)
        } else if let point = updated.restart {
            replaceRun(cursor: point.cursor, advanced: point.advanced, position: point.position, paused: point.paused,
                       seekItem: point.seekItem, duration: point.duration, admitted: point.admitted, budget: run.budget)
        }
        return true
    }

    /// The incomplete queue belongs to the document. Only this stop-at-boundary policy
    /// survives a detach, until the returning document submits a complete revision.
    func fence(session expected: String, revision next: Int) {
        lock.withLock {
            guard session == expected, next > revision, let run = active else { return }
            if fencedRevision == nil { continueAfterFence = run.wantsPlay && nextPolicy(for: mode) == .automatic }
            fencedRevision = next
            revision = next
            configure(run, mode: mode)
        }
    }

    /// Library revisions carry canonical order. Preparation budgets and occurrence references
    /// retain their slot even when a row moves or temporarily disappears.
    func revise(session expected: String, revision next: Int, folder: [String], tracks: [IndexedTrack]) {
        lock.withLock {
            guard session == expected, next > revision || next == fencedRevision, let run = active else { return }
            let continueAtEnd = fencedRevision != nil && continueAfterFence
            fencedRevision = nil
            revision = next
            self.folder = folder
            canonical = tracks.compactMap { entry in
                guard let key = entry.key, !blocked(entry.sourceRootKey ?? "") else { return nil }
                if let slot = slots[key] { catalog[slot] = .oneDrive(entry); return slot }
                slots[key] = catalog.count
                catalog.append(.oneDrive(entry))
                return catalog.count - 1
            }
            configure(run, mode: mode, resumeAtBoundary: continueAtEnd && (deadline.map { $0 > .now } ?? true))
        }
    }

    /// Access updates are independent of library traversal and survive session replacement.
    func updateAccess(connected: Set<String>?, denied: Set<String>, allowed: Set<String> = []) {
        lock.withLock {
            let known = connected ?? connectedShares
            let excluded = deniedRoots.subtracting(allowed).union(denied)
            guard connectedShares != known || deniedRoots != excluded else { return }
            connectedShares = known
            deniedRoots = excluded
            guard let run = active else { return }
            canonical = canonical.filter { !blocked(catalog[$0].indexed?.sourceRootKey ?? "") }
            configure(run, mode: mode)
        }
    }

    private func setTimerSetting(_ setting: String) throws {
        guard ["15m", "30m", "45m", "60m", "end-of-track"].contains(setting) else { throw NativeAccountError.invalidRequest }
        timerSetting = setting
    }

    /// A session deadline survives automatic joins and absence of the web document.
    private func armTimer(playing: Bool) {
        timerGeneration += 1
        expiry?.cancel()
        expiry = nil
        deadline = nil
        if playing, mode == .timer, let minutes = Int(timerSetting.dropLast()) { deadline = .now + timerInterval(minutes) }
        active?.setDeadline(deadline)
        guard let deadline else { return }
        let generation = timerGeneration
        expiry = Task { [weak self] in
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            guard let self else { return }
            self.lock.withLock {
                guard generation == self.timerGeneration else { return }
                self.active?.checkDeadline()
            }
        }
    }

    func changeTimer(_ setting: String) throws {
        try lock.withLock {
            let old = timerSetting
            try setTimerSetting(setting)
            guard old != setting, mode == .timer, let run = active else { return }
            configure(run, mode: mode)
            armTimer(playing: active?.wantsPlay == true)
        }
    }

    func stop() { lock.withLock { active?.cancel(); active = nil; armTimer(playing: false) } }

    func cancelWiFiReadsIfMetered() { lock.withLock { pool.cancelWiFiReadsIfMetered() } }

    /// UIKit memory pressure may discard any compressed block. Active readers can fetch it again.
    func releaseCachedAudio() { lock.withLock { pool.clear() } }

    /// Logout drains all in-flight bytes before removing the diagnostic recording. Retrying cleanup is safe.
    func stopAndDrain() async throws {
        lock.withLock { active?.cancel(); active = nil; catalog = []; canonical = []; slots = [:]; connectedShares = nil; deniedRoots = []; mode = .all; armTimer(playing: false); pool = MediaPool(unmeteredWiFi: pool.unmeteredWiFi) }
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
    private var tracks: [Recording]
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
    private weak var preparingWindow: MediaRanges.SuccessorWindow?
    private var message = "Preparing playback"
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let rate = 44_100
    private var scheduled: Int64 = 0
    #if DEBUG
    private var capturing = false
    #endif

    private let startCursor: PlayCursor
    private var startIndex: Int { startCursor.index }
    private var mode: QueueMode
    private var nextPolicy: NextPolicy
    private let startSeconds: Double
    let startsAtEnd: Bool
    private var deadline: ContinuousClock.Instant?
    private var paused: Bool
    private let resumeOrStop = DispatchSemaphore(value: 0)
    // Ordinals in the catalog can repeat. Each successive decoder in this run gets its own input number.
    private var cachedStarts = Set<Int>()
    private var requiredInput = 0
    private var waitingInputs = Set<Int>()
    private var lastFrame: Int64 = 0
    private var started = false
    private var drainingFinal = false
    #if os(iOS)
    private var sessionActivated = false
    #endif
    private var lastPlayed: DispatchGroup?

    /// The two anchors cover the currently audible item and an already scheduled successor.
    /// A snapshot crosses the join at the render clock even if the worker has not woken up yet.
    private struct Anchor {
        var cursor: PlayCursor
        var next: PlayCursor?
        let item: String
        let advanced: Bool
        var index: Int { cursor.index }
        var nodeFrame: Int64
        let fileFrame: Int64
        var duration: MP3RangeDecoder.Length
    }
    private var anchor: Anchor
    private var successor: Anchor?
    private var terminal: String?
    private var lastPosition: Double = 0

    private func audibleAnchor(at frame: Int64) -> Anchor {
        if let successor, frame > successor.nodeFrame { return successor }
        return anchor
    }

    /// AVAudioPlayerNode may drop its clock mapping while paused. Remember the last rendered frame.
    private func renderedFrame() -> Int64 {
        if started && !paused, let time = node.lastRenderTime, let mapped = node.playerTime(forNodeTime: time) {
            lastFrame = max(lastFrame, mapped.sampleTime)
        }
        return lastFrame
    }

    func snapshot(lookups: [IndexedTrack]?) -> [String: Any] {
        lock.withLock {
            expireIfDue()
            let rendered = renderedFrame()
            let frame = min(rendered, scheduled)
            let entry = audibleAnchor(at: frame)
            guard let track = tracks[entry.index].indexed, let path = track.path else { return [:] }
            if entry.cursor.held != nil && terminal == "ended" { return [:] }
            let needsPCM = !started || rendered >= scheduled
            let playing = !needsPCM && engine.isRunning && node.isPlaying
            let showWait = needsPCM && waitingInputs.contains(requiredInput) && !cachedStarts.contains(requiredInput)
            let state = terminal ?? (paused ? "paused" : playing ? "playing" : showWait ? "buffering" : "positioning")
            let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
            var result: [String: Any] = ["item": entry.item, "advanced": entry.advanced, "title": track.title ?? path.last ?? "", "key": track.key ?? track.itemId, "path": path, "state": state,
                    "album": track.album ?? "", "position": seconds, "duration": Double(entry.duration.frames) / Double(rate), "message": message]
            if entry.cursor.held != nil { result.removeValue(forKey: "path") }
            #if DEBUG
            if let lookups { result["bars"] = debugBars(at: entry, lookups: lookups) }
            #endif
            return result
        }
    }

    init(tracks: [Recording], cursor: PlayCursor, advanced: Bool, mode: QueueMode, nextPolicy: NextPolicy, position: Position, paused: Bool, seekItem: String?, duration: MP3RangeDecoder.Length, admitted: MediaLocation?, lookup: @escaping NativePlayback.Lookup, captureURL: URL, diagnostics: NativeDiagnostics?, pool: MediaPool, budget: MediaRanges.Budget, signalChange: @escaping @Sendable (Bool) -> Void) {
        self.admitted = admitted
        self.signalChange = signalChange
        self.budget = budget
        self.pool = pool
        self.tracks = tracks
        self.startCursor = cursor
        self.mode = mode
        self.nextPolicy = nextPolicy
        switch position {
        case .seconds(let time): self.startSeconds = time
        case .end: self.startSeconds = Double(duration.frames) / Double(rate)
        }
        // An end scrub represents the boundary after every sample. This run needs no decode worker.
        self.startsAtEnd = position == .end
        self.paused = paused || startsAtEnd
        self.lastPosition = startSeconds
        self.anchor = Anchor(cursor: cursor, next: cursor.neighbor(1, mode: mode), item: seekItem ?? UUID().uuidString, advanced: advanced, nodeFrame: 0, fileFrame: 0, duration: duration)
        self.diagnostics = diagnostics
        self.lookup = lookup
        self.captureURL = captureURL
        if startsAtEnd {
            terminal = paused ? nil : "ended"
            message = paused ? "Paused at end of track" : "Finished \(tracks.count) track(s)"
        }
    }
    #if DEBUG
    private func debugBars(at entry: Anchor, lookups: [IndexedTrack]) -> [[String: Any]] {
        return [entry.cursor.neighbor(-1, mode: mode)?.index, entry.index, nextPolicy == .fenced ? nil : entry.next?.index].map { index in
            guard let ordinal = index, let track = tracks[ordinal].indexed else { return [:] }
            let file = sources.last { $0.occurrence == ordinal+1 }?.file
            var bar = pool.debugRanges(drive: track.driveId, item: track.itemId, admitted: file)
            bar["name"] = track.title ?? track.path?.last
            bar["lookup"] = lookups.contains { $0.driveId == track.driveId && $0.itemId == track.itemId }
            return bar
        }
    }
    #endif

    var wantsPlay: Bool { lock.withLock { !paused && terminal == nil } }
    var status: String {
        lock.withLock {
            started && clock >= scheduled ? "Waiting for audio. " + message : message
        }
    }

    enum Position: Equatable { case seconds(Double), end }
    typealias Point = (cursor: PlayCursor, position: Position, paused: Bool, seekItem: String?, duration: MP3RangeDecoder.Length, admitted: MediaLocation?, advanced: Bool)

    /// Reconcile against the render anchor while excluding buffer submission. An unchanged
    /// prepared edge keeps playing even when the rest of the order changes under it.
    func configure(catalog: [Recording], canonical: [Int], mode nextMode: QueueMode, nextPolicy policy: NextPolicy,
                   item: String?, blocked: (String) -> Bool, resumeAtBoundary: Bool) -> (applied: Bool, revoked: Bool, restart: Point?) {
        lock.withLock {
            expireIfDue()
            var frozeNode = false
            defer { if frozeNode && !cancelled && !paused { try? node.playAudio() } }
            while true {
                let frame = min(renderedFrame(), scheduled)
                var entry = audibleAnchor(at: frame)
                guard item == nil || item == entry.item else { return (false, false, nil) }
                let current = entry.index
                if blocked(catalog[current].indexed?.sourceRootKey ?? "") {
                    cancelLocked()
                    return (true, true, nil)
                }
                let cursor = entry.cursor.revised(for: canonical, from: mode, to: nextMode)
                // A pass-edge Shuffle choice belongs to the prepared occurrence. A path edit
                // keeps that choice instead of drawing again against the same pass.
                let preserve = nextMode == mode && cursor.order == entry.cursor.order
                let next = preserve ? entry.next : cursor.neighbor(1, mode: nextMode)
                let priorTarget = nextPolicy == .fenced ? nil : entry.next?.index
                let nextTarget = policy == .fenced ? nil : next?.index
                let changed = priorTarget != nextTarget || (nextTarget != nil && policy != nextPolicy)
                if changed && started && !paused && terminal == nil && !frozeNode {
                    _ = renderedFrame()
                    node.pause()
                    frozeNode = true
                    // Hardware can cross the boundary during a large order comparison.
                    // Resolve it again with output stationary before withdrawing any PCM.
                    continue
                }
                tracks = catalog
                mode = nextMode
                nextPolicy = policy
                entry.cursor = cursor
                entry.next = next
                if entry.item == anchor.item {
                    anchor = entry
                    if var pending = successor, let next, pending.index == next.index {
                        pending.cursor = next
                        if !preserve { pending.next = next.neighbor(1, mode: nextMode) }
                        successor = pending
                    }
                } else { successor = entry }
                if resumeAtBoundary && policy == .automatic && !paused && (terminal == "ended" || (drainingFinal && frame >= scheduled)), let next {
                    cancelLocked()
                    return (true, false, (next, .seconds(0), false, nil, .unknown, nil, true))
                }
                if !changed || terminal != nil || startsAtEnd { return (true, false, nil) }
                let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
                let location = sources.last { $0.occurrence == current + 1 }?.admission ?? (current == startIndex ? admitted : nil)
                cancelLocked()
                return (true, false, (cursor, .seconds(seconds), paused, entry.item, entry.duration, location, entry.advanced))
            }
        }
    }

    func setDeadline(_ value: ContinuousClock.Instant?) { lock.withLock { deadline = value } }
    func checkDeadline() { lock.withLock { expireIfDue() } }

    /// Called under the render lock, including just before buffer submission. Expiry does
    /// not depend on when the system schedules the sleeper or the next web-view sample.
    private func expireIfDue() {
        guard let deadline, .now >= deadline else { return }
        self.deadline = nil
        guard !paused, !cancelled, terminal == nil else { return }
        _ = renderedFrame()
        if started { node.pause() }
        paused = true
        signalChange(false)
    }

    /// Sample and stop the touched occurrence in one critical section, before its successor can be scheduled.
    func apply(_ action: String, item: String, seconds: Double?) throws -> (restart: Point?, playing: Bool)? {
        try lock.withLock {
            expireIfDue()
            let frame = min(renderedFrame(), scheduled)
            let entry = audibleAnchor(at: frame)
            // A failed or naturally ended run remains controllable after its preparation
            // worker has been cancelled. An explicit Stop/replacement removes the run.
            guard item == entry.item, !cancelled || terminal != nil else { return nil }
            // Only continuations of this occurrence or its admitted immediate successor may start from retained bytes.
            func admission(_ index: Int) -> MediaLocation? {
                guard terminal == nil else { return nil }
                if let source = sources.last(where: { $0.occurrence == index+1 }) { return source.admission }
                return index == startIndex ? admitted : nil
            }
            switch action {
            case "seek", "skip":
                guard let seconds, seconds.isFinite, entry.duration.frames > 0 else { return nil }
                let duration = Double(entry.duration.frames) / Double(rate)
                let current = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
                // A relative skip is a time, even when an unindexed VBR file initially looks shorter.
                let relative = action == "skip" && entry.duration.estimated && terminal == nil
                let requested = action == "skip" ? current + seconds : seconds
                let time = max(0, relative ? requested : min(duration, requested))
                guard Int64(exactly: (time * Double(rate)).rounded()) != nil else { return nil }
                let target = action == "seek" && time > 0 && time >= duration - 0.1 ? duration : time
                // A late wheel release cannot turn a stopped or failed occurrence into a natural end.
                if target == duration && terminal != nil { return nil }
                if paused || relative || target < duration {
                    cancelLocked()
                    return ((entry.cursor, !relative && target == duration ? .end : .seconds(target), paused, item, entry.duration, admission(entry.index), entry.advanced), !paused)
                }
                // Releasing at EOF during playback completes the touched occurrence immediately.
                fallthrough
            case "play" where startsAtEnd && terminal == nil:
                cancelLocked()
                if nextPolicy == .automatic, let next = entry.next {
                    return ((next, .seconds(0), false, nil, .unknown, admission(next.index), true), true)
                }
                return ((entry.cursor, .end, false, item, entry.duration, admission(entry.index), entry.advanced), false)
            case "next", "previous":
                guard let next = action == "previous" ? entry.cursor.neighbor(-1, mode: mode) : entry.next else {
                    if entry.cursor.held != nil && action == "next" {
                        cancelLocked()
                        terminal = "ended"
                        return (nil, false)
                    }
                    return nil
                }
                cancelLocked()
                return ((next, .seconds(0), false, nil, .unknown, action == "previous" ? nil : admission(next.index), action == "next"), true)
            case "pause", "play":
                if terminal == nil {
                    if paused && action == "play" {
                        resumeOrStop.signal()
                        preparingWindow?.changed.signal()
                    }
                    paused = action == "pause"
                    if started {
                        if paused { node.pause() } else if !node.isPlaying { try node.playAudio() }
                    }
                    return (nil, !paused)
                }
                guard action == "play" else { return nil }
                cancelLocked()
                return ((entry.cursor, .seconds(0), false, nil, .unknown, nil, false), true)
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
        preparingWindow?.changed.signal()
        sources.forEach { $0.cancel() }
        if started { _ = renderedFrame(); node.stop() }
    }

    private func report(_ text: String, terminal state: String? = nil) {
        lock.withLock { message = text; terminal = state }
        if state != nil { signalChange(false) }
        log.notice("\(text, privacy: .public)")
    }

    private func checkCancellation() throws {
        if lock.withLock({ cancelled }) { throw CancellationError() }
    }

    private func resolve(_ track: IndexedTrack, _ request: MediaLookup, delay: Int = 0) throws -> MediaLocation {
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
                        let media = try await lookup(track.driveId, track.itemId, request, false)
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
    @discardableResult private func enqueue(_ pcm: AVAudioPCMBuffer, frames: Range<Int>, incoming: (index: Int, duration: MP3RangeDecoder.Length)? = nil) throws -> Int64 {
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
            expireIfDue()
            let now = clock
            let wasWaiting = !started || now >= scheduled
            if now > scheduled {
                log.notice("stall frames=\(now-self.scheduled)")
                anchor.nodeFrame += now - scheduled
                scheduled = now
            }
            let start = scheduled
            if let incoming, let cursor = anchor.next {
                successor = Anchor(cursor: cursor, next: cursor.neighbor(1, mode: mode), item: UUID().uuidString, advanced: true, nodeFrame: start, fileFrame: Int64(frames.lowerBound), duration: incoming.duration)
            }
            let played = DispatchGroup()
            played.enter()
            node.scheduleBuffer(part, atTime: nil, options: [], completionCallbackType: .dataPlayedBack) { played.leave() }
            lastPlayed = played
            scheduled += Int64(part.frameLength)
            // A decoder miss can begin while this PCM is still audible. Wake the drawer at
            // exhaustion if the last submitted buffer played out with its input still pending.
            played.notify(queue: .global()) { [weak self] in
                guard let self else { return }
                self.lock.withLock {
                    if self.lastPlayed === played && !self.cancelled && !self.paused && self.waitingInputs.contains(self.requiredInput) {
                        self.signalChange(false)
                    }
                }
            }
            // After the first scheduled PCM, later starvation is a fresh demand wait.
            if !started || incoming != nil { cachedStarts.remove(requiredInput) }
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
            report("Finished \(lock.withLock { anchor.cursor.order.count }) track(s)", terminal: "ended")
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
        #if DEBUG
        let timingStart = ProcessInfo.processInfo.systemUptime
        #endif
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback)
        try audio.setActive(true)
        sessionActivated = true
        #endif
        #if DEBUG
        let activated = ProcessInfo.processInfo.systemUptime
        #endif
        var (source, decoder) = try open(lock.withLock { tracks[startIndex] }, ordinal: startIndex + 1, input: 0, speculative: false, admitted: admitted)
        #if DEBUG
        let opened = ProcessInfo.processInfo.systemUptime
        #endif
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
        #if DEBUG
        let connected = ProcessInfo.processInfo.systemUptime
        #endif
        // A seek already names a frame on the playing timeline. A freshly opened unindexed
        // decoder may have a shorter provisional duration until it reads the target packets.
        var firstFrame = Int64(startSeconds * Double(rate))
        #if DEBUG
        if nearEnd { firstFrame = max(0, try decoder.exactFramesForAudition() - Int64(16*rate)) }
        #endif
        var chunk = try decode(decoder, from: firstFrame, seconds: 4, seek: firstFrame > 0)
        if chunk.pcm.frameLength == 0 { firstFrame = min(firstFrame, decoder.frames) }
        source?.finishMeteredSeek()
        // A cellular seek can outlast the entire diagnostic capture. Start rendering when PCM is ready.
        try checkCancellation()
        lock.withLock {
            lastPosition = Double(firstFrame) / Double(rate)
            anchor = Anchor(cursor: anchor.cursor, next: anchor.next, item: anchor.item, advanced: anchor.advanced, nodeFrame: 0, fileFrame: firstFrame + Int64(chunk.audible.lowerBound), duration: decoder.length)
        }
        #if DEBUG
        let decoded = ProcessInfo.processInfo.systemUptime
        #endif
        try engine.start()
        #if DEBUG
        let engineStarted = ProcessInfo.processInfo.systemUptime
        func ms(_ interval: Double) -> Int { Int((interval * 1000).rounded()) }
        log.notice("First PCM seek=\(self.startSeconds) sessionMs=\(ms(activated-timingStart)) openMs=\(ms(opened-activated)) connectMs=\(ms(connected-opened)) decodeMs=\(ms(decoded-connected)) engineMs=\(ms(engineStarted-decoded))")
        #endif
        var nextFrame = firstFrame + Int64(chunk.pcm.frameLength)
        var ordinal = startIndex + 1
        var successorFailed = false
        do {
            while true {
                // The same worker supplies early manual Next and the natural join. It never schedules output.
                let prepared = WorkerReply<(MediaRanges?, MP3RangeDecoder, Chunk)>()
                let demandAllowed = DispatchSemaphore(value: 0)
                var atJoin = false
                let currentBytes = source?.file.size ?? 0
                // The audible clock, not the decoder's queued end or its most recent MP3 metadata probe.
                let byteCursor = { [self] () -> Int64? in
                    lock.withLock {
                        let frame = renderedFrame()
                        guard !paused, anchor.duration.frames > 0, scheduled-frame >= Int64(3*rate) else { return nil }
                        let elapsed = anchor.fileFrame + max(0, frame - anchor.nodeFrame)
                        let fraction = min(1, Double(elapsed) / Double(anchor.duration.frames))
                        return Int64(exactly: (Double(currentBytes) * fraction).rounded(.down)) ?? currentBytes
                    }
                }
                let (policy, nextIndex) = lock.withLock { (nextPolicy, nextPolicy == .fenced ? nil : anchor.next?.index) }
                let window = MediaRanges.SuccessorWindow {
                    guard let cursor = byteCursor() else { return 0 }
                    let spill = policy == .automatic ? MediaRanges.wifiWindow - (currentBytes - cursor) : 0
                    return max(MediaRanges.openingPrefix, spill)
                }
                let nextInput = requiredInput + 1
                if let index = nextIndex {
                    let next = lock.withLock { preparingWindow = window; return tracks[index] }
                    DispatchQueue.global(qos: .utility).async { [self] in
                        prepared.finish(Result {
                            let (incoming, decoder) = try open(next, ordinal: index + 1, input: nextInput, speculative: true,
                                successorWindow: window) {
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
                        window.releaseAtJoin()
                    }
                    if nextIndex != nil {
                        demandAllowed.signal()
                        prepared.ready.wait()
                    }
                }
                // For each full track this cursor advances exactly once, including across URL replacement.
                if !chunk.final {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    repeat {
                        window.changed.signal()
                        try wait(until: scheduled - Int64(8*rate))
                        if let source, let cursor = byteCursor() {
                            if pool.unmeteredWiFi() {
                                try source.extendWindow(from: cursor, to: cursor + min(currentBytes-cursor, MediaRanges.wifiWindow))
                                let prefix = window.prefix()
                                if prefix > 0, prepared.ready.wait(timeout: .now()) == .success,
                                   case .success(let (incoming, _, _))? = prepared.result {
                                    try incoming?.extendWindow(from: 0, to: prefix)
                                }
                            } else {
                                let duration = Double(decoder.frames) / Double(rate)
                                let through = min(duration, Double(nextFrame) / Double(rate) + 45)
                                let target = MP3RangeDecoder.seekByte(seconds: through, duration: duration,
                                    size: currentBytes, header: pool.read(source.file, at: 0)).offset
                                try source.extendMeteredWindow(through: target)
                            }
                        }
                        chunk = try decode(decoder, from: nextFrame, seconds: 4)
                        nextFrame += Int64(chunk.pcm.frameLength)
                        lock.withLock { anchor.duration = decoder.length }
                        if !chunk.final { try enqueue(chunk.pcm, frames: chunk.audible) }
                    } while !chunk.final
                }
                if chunk.audible.isEmpty { try waitWhilePaused() }
                guard let nextIndex, policy == .automatic else {
                    try enqueue(chunk.pcm, frames: chunk.audible)
                    lock.withLock { drainingFinal = true }
                    window.changed.signal()
                    try drainAudio()
                    // The manual Next worker can still be waiting on Graph or a decoder scan.
                    if nextIndex != nil { cancel() }
                    return
                }

                // The final 88 playable frames suffice for the mix. Start preparing while earlier PCM is audible.
                let tail = chunk.audible
                var hold = min(88, tail.count, chunk.playableCount/2)
                try enqueue(chunk.pcm, frames: tail.lowerBound..<(tail.upperBound-hold))
                // Outgoing PCM is queued. Only the successor can now be the cause of an audible network wait.
                lock.withLock {
                    requiredInput = nextInput
                    if !paused && clock >= scheduled && waitingInputs.contains(nextInput) { signalChange(false) }
                }
                window.releaseAtJoin()
                atJoin = true
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
                    successorFailed = true
                    throw error
                }
                if let incoming, incoming.speculative {
                    try incoming.extendWindow(from: 0, to: window.prefix())
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
                let retain = head.final ? min(88,head.audible.count/2) : 0
                let cut = head.audible.upperBound-retain
                let boundary = try enqueue(head.pcm, frames: head.audible.lowerBound..<cut,
                                           incoming: (nextIndex, nextDecoder.length))
                log.notice("ready item=\(nextIndex + 1) prefixFrames=\(cut-head.audible.lowerBound) specBytes=\(incoming?.specBytes ?? 0) overlap=\(mix) boundary=\(boundary)")
                try wait(until: boundary + 1)
                lock.withLock {
                    if let successor { anchor = successor; self.successor = nil }
                }
                signalChange(false)
                source?.cancelAndDrain()
                lock.withLock { sources.removeAll { $0 === source } }
                ordinal = nextIndex + 1
                report("Playing track \(ordinal)")
                if let incoming {
                    // The player consumes the runway independently of this lookup and its first new range.
                    incoming.promote()
                    if forceRefresh, !head.final, case .oneDrive(let recording) = lock.withLock({ tracks[ordinal-1] }) {
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
            if successorFailed {
                lock.withLock {
                    guard let failedSuccessor = anchor.next else { return }
                    anchor = Anchor(cursor: failedSuccessor, next: failedSuccessor.neighbor(1, mode: mode), item: UUID().uuidString, advanced: false, nodeFrame: scheduled, fileFrame: 0, duration: .unknown)
                    successor = nil
                }
            }
            throw error
        }
    }

    /// A decoder can be waiting in the background while several seconds of PCM are still audible.
    private func setInputWaiting(_ input: Int, _ waiting: Bool) {
        lock.withLock {
            if waiting { waitingInputs.insert(input) } else { waitingInputs.remove(input) }
            if requiredInput == input && !cancelled && !paused && (!started || clock >= scheduled) { signalChange(false) }
        }
    }

    private func open(_ recording: Recording, ordinal: Int, input: Int, speculative: Bool, admitted: MediaLocation? = nil, successorWindow: MediaRanges.SuccessorWindow? = nil, awaitDemand: (() throws -> Void)? = nil) throws -> (MediaRanges?, MP3RangeDecoder) {
        let track: IndexedTrack
        switch recording {
        case .oneDrive(let indexed): track = indexed
        #if DEBUG
        case .local(let url):
            let file = try LocalMP3(url)
            return (nil, try MP3RangeDecoder(bytes: file.size, read: file.read))
        #endif
        }
        // Resolve the immediate successor on either route. Its decoder and CDN wait for audio eligibility.
        let setWaiting = { [weak self] (waiting: Bool) -> Void in self?.setInputWaiting(input, waiting) }
        // A warm selection may still need its version confirmed. Keep the time visible unless
        // the admitted decoder actually asks for an absent block.
        let coldLookup = admitted == nil && !pool.hasCachedAudio(drive: track.driveId, item: track.itemId)
        let media: MediaLocation
        do {
            if coldLookup { setWaiting(true) }
            defer { if coldLookup { setWaiting(false) } }
            media = try resolve(track, .reuse(admitted))
        }
        if let successorWindow {
            while successorWindow.early && successorWindow.prefix() == 0 {
                try checkCancellation()
                successorWindow.changed.wait()
            }
            try checkCancellation()
        }
        if let admitted, admitted.etag != media.etag || admitted.size != media.size {
            throw PlaybackError("Recording changed during playback")
        }
        let source = try MediaRanges(media, drive: track.driveId, item: track.itemId, pool: pool, budget: budget, occurrence: ordinal, speculative: speculative, successorWindow: successorWindow, signalDebug: { [signalChange] in signalChange(true) }, trace: { [log] entry in
            log.info("range item=\(ordinal) \(entry, privacy: .public)")
        }, diagnostic: { [diagnostics] event in diagnostics?.record("CDN item=\(ordinal) \(event)") }, awaitDemand: awaitDemand, renew: { [unowned self] rejected in try self.resolve(track, .replace(rejected)) })
        source.onDecoderWait = setWaiting
        try lock.withLock {
            if cancelled { throw CancellationError() }
            guard !media.accessDenied else { throw NativeAccountError.forbidden }
            sources.append(source)
        }
        var exact = true
        if !speculative, startSeconds > 0, anchor.duration.frames > 0 {
            let duration = Double(anchor.duration.frames) / Double(rate)
            (source.meteredSeekByte, exact) = MP3RangeDecoder.seekByte(seconds: startSeconds, duration: duration,
                size: media.size, header: pool.read(source.file, at: 0))
        }
        // The decoder can scan headers or request bytes beyond the target before emitting PCM.
        // Its setup reads must not put a spinner over audio that was cached at selection time.
        let target = min(source.meteredSeekByte, media.size - 1)
        let base = target - target % Int64(MediaRanges.block)
        // Without an exact packet offset (e.g. VBR with its header evicted), a miss at
        // the estimated offset cannot prove the target is cold. Favor the time display.
        let warm = exact ? pool.firstGap(source.file, in: base..<(base+1)) == nil
                         : pool.hasCachedAudio(drive: track.driveId, item: track.itemId)
        if warm { lock.withLock { _ = cachedStarts.insert(input) } }
        // Only a continuation whose admitted version matched above can inherit a proven duration.
        let knownLength = admitted == nil ? .unknown : lock.withLock { anchor.duration }
        return (source, try MP3RangeDecoder(bytes: media.size, knownLength: knownLength, read: source.read))
    }

    private struct Chunk {
        let pcm: AVAudioPCMBuffer
        var audible: Range<Int>
        let playableCount: Int
        let final: Bool
        let trimmedStart: Bool
        let trimmedEnd: Bool
    }

    /// The decoder preserves a trailing PCM window across reads, independently of its duration estimate.
    private func decode(_ decoder: MP3RangeDecoder, from position: Int64, seconds: Int, seek: Bool = false) throws -> Chunk {
        let (pcm, final) = try decoder.decodePlaybackChunk(seconds*rate, at: seek ? position : nil)
        let n = Int(pcm.frameLength)
        // MP3 duration is an estimate. A successful zero-frame read at a positive cursor is clean EOF,
        // including a seek past the last playable frame. A recording must still decode some audio at zero.
        guard n > 0 || position > 0 else { throw PlaybackError("Recording contains no decodable audio") }
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
        let audible = position == 0 && head+tail == n ? 0..<n : head..<(n-tail)
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
