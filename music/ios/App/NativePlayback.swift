import AVFoundation
import OSLog

struct IndexedTrack: Codable, Equatable, Sendable {
    let driveId: String
    let itemId: String
    var path: [String]? = nil
    var key: String? = nil
    var sourceRootKey: String? = nil
    var fileKey: String { driveId + ":" + itemId }
    var title: String? = nil
    var album: String? = nil
    var systemTitle: String? = nil
}

enum QueueMode: String, CaseIterable, Codable {
    case one, timer, all, `repeat`, shuffle

    var following: Self {
        Self.allCases[(Self.allCases.firstIndex(of: self)! + 1) % Self.allCases.count]
    }
}

/// A fenced edit has no trustworthy Next until the revised queue arrives.
private enum NextPolicy { case automatic, manualOnly, fenced }

/// An immutable pass travels with the audible anchor. Preparing a new shuffle pass does
/// not change the current one until its first frame is actually rendered.
private struct PlayCursor: Codable {
    let order: [Int]
    let slot: Int
    /// A removed recording is appended outside canonical order. Keep its former neighbors
    /// until handoff, so repeated edits cannot redirect it to the new occupant of its old row.
    var held: Held? = nil
    struct Held: Codable, Equatable {
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

/// The structural record contains a complete restart point. A newer small checkpoint applies
/// only to the same record and occurrence. A kill between replacements leaves either point usable.
private struct SessionPoint: Codable, Equatable {
    let generation: UUID
    let item: String
    let key: String
    let slot: Int
    let seconds: Double
    let duration: MP3RangeDecoder.Length
    let atEnd: Bool
}

private struct SavedSession: Codable {
    let tracks: [IndexedTrack]
    let canonical: [Int]
    let cursor: PlayCursor
    let next: PlayCursor?
    let point: SessionPoint
    let folder: [String]
    let folderKey: String
    let mode: QueueMode
    let timer: String
    let favorite: String?
    let fenced: Bool
}

private struct SourceAccess: Codable {
    // Build 29 recorded membership and denials before assigning access revisions.
    let revision: Int?
    let connected: Set<String>?
    let denied: Set<String>
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
    // Activation and release run on the serial decoder. A system deactivation also
    // clears ownership under the player lock, before issuing a resumption recommendation.
    private var ownsAudioSession = false
    private var active: PlaybackRun?
    private var interruptedItem: String?
    private var mode = QueueMode.all
    private var timerSetting = "30m"
    private var expiry: Task<Void, Never>?
    private var deadline: ContinuousClock.Instant?
    private let shuffledStart: @Sendable ([Int]) -> [Int]
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
    private var catalog = [IndexedTrack]()
    private var slots = [String: Int]()
    private var canonical = [Int]()
    private var accessRevision = 0
    private var accessDirty = false
    private var deniedRoots = Set<String>()
    private var connectedShares: Set<String>?
    private func blocked(_ root: String) -> Bool {
        deniedRoots.contains(root) || (root.hasPrefix("share:") && connectedShares?.contains(root) == false)
    }
    func allowsPinSource(_ root: String) -> Bool { lock.withLock { !blocked(root) } }
    func holdsPin(_ key: String) -> Bool { lock.withLock { active?.lease(for: key) != nil } }
    private var unreadable = Set<String>()
    private var offlineKeys: Set<String>?
    private var playableOrder: [Int] {
        guard offlineKeys != nil || !unreadable.isEmpty else { return canonical }
        return canonical.filter { !unreadable.contains(catalog[$0].fileKey) && offlineKeys?.contains(catalog[$0].fileKey) != false }
    }

    /// Preserve the canonical library and bookmark while restricting the next pass to complete files.
    @discardableResult func setOfflineAvailability(_ keys: Set<String>?) -> Bool {
        lock.withLock {
            guard keys != offlineKeys else { return false }
            offlineKeys = keys
            if let run = active { configure(run, mode: mode); saveCheckpoint() }
            return true
        }
    }

    private func nextPolicy(for mode: QueueMode) -> NextPolicy {
        if fencedRevision != nil { return .fenced }
        return mode == .one || (mode == .timer && timerSetting == "end-of-track") ? .manualOnly : .automatic
    }
    private var pool: MediaPool

    private let writer = DispatchQueue(label: "me.unto.oneplay.music.checkpoints", qos: .utility)
    // Each failed file retains its newest write until that file succeeds. A different
    // favorite or a newer session record cannot acknowledge an unsaved outgoing spot.
    private var pendingWrites = [String: () throws -> Void]()
    private var spots = [String: FavoriteSpot]()
    private var store: PlaybackStore?
    private var favorite: String?
    private var savedCursor: PlayCursor?
    private var savedNextOrder: [Int]?
    private var savedPoint: SessionPoint?
    private var structureDirty = true
    private var ticker: DispatchSourceTimer?
    private var hasHistory = false

    /// Reattaching WebKit never reopens a live session. The paused run waits before activating audio or resolving a URL.
    func restoreIfNeeded(from storage: PlaybackStore) throws {
        try lock.withLock {
            guard store?.directory != storage.directory else { return }
            let access = try storage.read(SourceAccess.self, "access")
            guard store == nil else { throw NativeAccountError.wrongAccount }
            let saved: SavedSession??
            do { saved = try storage.read(SavedSession?.self, "queue") }
            catch is DecodingError { saved = .some(nil); diagnostics?.record("Unreadable playback queue") }
            store = storage
            accessRevision = access?.revision ?? 0
            connectedShares = access?.connected
            deniedRoots = access?.denied ?? []
            hasHistory = saved != nil
            guard let record = saved ?? nil else { return }
            let indices = record.tracks.indices
            func validCursor(_ cursor: PlayCursor) -> Bool {
                guard cursor.order.allSatisfy(indices.contains), Set(cursor.order).count == cursor.order.count else { return false }
                if let held = cursor.held {
                    return indices.contains(held.index) && held.former.indices.contains(held.slot)
                        && held.former[held.slot] == held.index && held.former.allSatisfy(indices.contains)
                        && [held.previous, held.next].compactMap { $0 }.allSatisfy(cursor.order.indices.contains)
                }
                return cursor.order.indices.contains(cursor.slot)
            }
            guard validCursor(record.cursor), record.next.map(validCursor) != false, record.canonical.allSatisfy(indices.contains),
                  Set(record.canonical).count == record.canonical.count, Set(record.tracks.compactMap(\.key)).count == record.tracks.count else { return }
            let recent = try? storage.read(SessionPoint.self, "position")
            func valid(_ point: SessionPoint) -> Bool {
                let index = record.cursor.held?.index ?? (record.cursor.order.indices.contains(point.slot) ? record.cursor.order[point.slot] : -1)
                return point.generation == record.point.generation && record.tracks.indices.contains(index)
                    && record.tracks[index].key == point.key && Self.validPosition(point.seconds) && point.duration.frames >= 0
            }
            let point = recent.flatMap { valid($0) ? $0 : nil } ?? record.point
            guard valid(point) else { return }
            let cursor = PlayCursor(order: record.cursor.order, slot: point.slot, held: record.cursor.held)
            guard !blocked(record.tracks[cursor.index].sourceRootKey ?? "") else {
                try storage.save(Optional<SavedSession>.none, "queue")
                return
            }
            catalog = record.tracks
            slots = Dictionary(uniqueKeysWithValues: record.tracks.enumerated().compactMap { i, entry in entry.key.map { ($0, i) } })
            canonical = record.canonical.filter { !blocked(record.tracks[$0].sourceRootKey ?? "") }
            mode = record.mode
            folder = record.folder
            folderKey = record.folderKey
            favorite = record.favorite
            timerSetting = record.timer
            session = UUID().uuidString
            fencedRevision = record.fenced ? revision : nil
            let eligible = cursor.revised(for: playableOrder, from: mode, to: mode)
            replaceRun(cursor: eligible, position: point.atEnd ? .end : .seconds(point.seconds), paused: true,
                       duration: point.duration, restoredNext: eligible.order == cursor.order && canonical == record.canonical && point.slot == record.cursor.slot ? record.next : nil)
            savedCursor = cursor
            savedPoint = point
            savedNextOrder = mode == .shuffle && cursor.held == nil && cursor.slot == cursor.order.count - 1 ? record.next?.order : nil
            structureDirty = canonical != record.canonical
        }
    }

    /// Checkpoint the audible anchor independently of UI polling, even during locked playback.
    func checkpoint() { lock.withLock { saveCheckpoint() } }

    static func validPosition(_ seconds: Double) -> Bool {
        seconds >= 0 && Int64(exactly: (seconds * 44_100).rounded()) != nil
    }

    /// Encode immutable snapshots on one serial writer. A slow 30k queue write cannot
    /// freeze WebKit or the audio clock, or overtake the checkpoint for its replacement.
    private func enqueueWrite(_ name: String, _ operation: @escaping () throws -> Void) {
        writer.async { [self] in
            do {
                try operation()
                pendingWrites.removeValue(forKey: name)
            } catch {
                pendingWrites[name] = operation
                diagnostics?.record("Playback checkpoint write failed")
            }
        }
    }

    func waitForCheckpointWrites() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writer.async { [self] in
                do {
                    for (name, operation) in pendingWrites {
                        try operation()
                        pendingWrites.removeValue(forKey: name)
                    }
                    if lock.withLock({ accessDirty }) { throw NativeAccountError.unavailable }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func saveCheckpoint() {
        guard let store else { return }
        if accessDirty {
            do {
                let next = accessRevision + 1
                try store.save(SourceAccess(revision: next, connected: connectedShares, denied: deniedRoots), "access")
                accessRevision = next
                accessDirty = false
            } catch { diagnostics?.record("Playback source access write failed") }
        }
        guard let run = active, !folderKey.isEmpty, let anchor = run.persistenceAnchor() else {
            if hasHistory && (structureDirty || savedPoint != nil) {
                enqueueWrite("queue") { try store.save(Optional<SavedSession>.none, "queue") }
                savedPoint = nil
                savedCursor = nil
                structureDirty = false
            }
            return
        }
        let cursor = anchor.cursor
        let entry = catalog[cursor.index]
        guard let key = entry.key, let path = entry.path else { return }
        // Only a shuffle wrap has a next pass distinct from the current order.
        let alternate = mode == .shuffle && cursor.held == nil && cursor.slot == cursor.order.count - 1 ? anchor.next?.order : nil
        let structural = structureDirty || savedCursor?.order != cursor.order || savedCursor?.held != cursor.held
            || savedNextOrder != alternate || savedPoint == nil
        let point = SessionPoint(generation: structural ? UUID() : savedPoint!.generation,
            item: anchor.item, key: key, slot: cursor.slot, seconds: anchor.seconds, duration: anchor.duration, atEnd: anchor.atEnd)
        guard structural || savedPoint != point else { return }
        if structural {
            let record = SavedSession(tracks: catalog, canonical: canonical, cursor: cursor,
                next: alternate == nil ? nil : anchor.next, point: point, folder: folder, folderKey: folderKey, mode: mode,
                timer: timerSetting, favorite: favorite, fenced: fencedRevision != nil)
            enqueueWrite("queue") { try store.save(record, "queue") }
            hasHistory = true
        } else { enqueueWrite("position") { try store.save(point, "position") } }
        if let favorite, cursor.held == nil {
            let spot = FavoriteSpot(folder: folder, folderKey: folderKey, path: path, key: key, seconds: point.seconds)
            spots[favorite] = spot
            let name = store.bookmarkFile(favorite)
            enqueueWrite(name) { try store.save(spot, name) }
        }
        savedPoint = point
        savedCursor = cursor
        savedNextOrder = alternate
        structureDirty = false
    }

    /// One-time migration accepts resolved identities only and can never replace Swift's bookmark.
    func importSpot(_ spot: FavoriteSpot, favorite: String) throws {
        try lock.withLock {
            guard Self.validPosition(spot.seconds), let store, spots[favorite] == nil, try store.read(FavoriteSpot.self, store.bookmarkFile(favorite)) == nil else { return }
            try store.save(spot, store.bookmarkFile(favorite))
        }
    }

    @MainActor var onChange: ((_ debugOnly: Bool) -> Void)?

    init(captureURL: URL = NativePlayback.captureURL, diagnostics: NativeDiagnostics? = nil, pool: MediaPool = MediaPool(), timerInterval: @escaping @Sendable (Int) -> Duration = { .seconds($0 * 60) },
         shuffledStart: @escaping @Sendable ([Int]) -> [Int] = { $0.shuffled() }, lookup: @escaping Lookup) {
        self.pool = pool
        self.shuffledStart = shuffledStart
        self.timerInterval = timerInterval
        destination = captureURL
        self.diagnostics = diagnostics
        self.lookup = lookup
    }
    var status: String { lock.withLock { active?.status ?? "Stopped" } }
    var sessionID: String { lock.withLock { active == nil ? "" : session } }

    /// Only the occurrence whose title was published may supply its cover.
    func artworkReader(for item: String) -> NowPlayingArtwork.ReadPrefix? {
        lock.withLock { active?.artworkReader(for: item) }
    }

    /// A fresh document samples the running node without restarting the decoder.
    var snapshot: [String: Any] { snapshot(lookups: nil) }

    func snapshot(lookups: [IndexedTrack]?, pinSizes: [String: Int] = [:], includeDenied: Bool = false) -> [String: Any] {
        lock.withLock {
            var result = active?.snapshot(lookups: lookups, pinSizes: pinSizes) ?? [:]
            result["accessRevision"] = accessRevision
            if includeDenied { result["denied"] = Array(deniedRoots) }
            result["hasHistory"] = hasHistory
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
               folder: [String] = [], folderKey: String = "", selected: Bool = true, timer: String? = nil, initialMode: QueueMode? = nil, favorite: String? = nil, legacyPosition: Double? = nil) throws {
        guard legacyPosition.map(Self.validPosition) != false, tracks.indices.contains(startIndex), [0,5,10].contains(delaySeconds),
              tracks.allSatisfy({ !$0.driveId.isEmpty && !$0.itemId.isEmpty }) else {
            throw PlaybackError("Invalid playback request")
        }
        try lock.withLock {
            let allowed = tracks.indices.filter { !blocked(tracks[$0].sourceRootKey ?? "") }
            let eligible = offlineKeys.map { keys in allowed.filter { keys.contains(tracks[$0].fileKey) } } ?? allowed
            guard let first = eligible.first, !selected || eligible.contains(startIndex) else {
                throw offlineKeys == nil ? NativeAccountError.forbidden : .unavailableOffline
            }
            if legacyPosition != nil && (hasHistory || active != nil) { return }
            saveCheckpoint()
            if let timer { try setTimerSetting(timer) }
            let startingMode = initialMode ?? mode
            let bookmark: FavoriteSpot?
            if let favorite, !selected, startingMode != .shuffle, let store {
                bookmark = spots[favorite] ?? (try? store.read(FavoriteSpot.self, store.bookmarkFile(favorite)))
            } else { bookmark = nil }
            let bookmarked = bookmark.flatMap { spot in Self.validPosition(spot.seconds) ? eligible.first { tracks[$0].key == spot.key } : nil }
            let initial = bookmarked ?? (selected ? startIndex : first)
            interruptedItem = nil
            self.favorite = favorite
            structureDirty = true
            mode = startingMode
            deadline = nil
            catalog = tracks
            unreadable.removeAll()
            slots.removeAll()
            for (i, entry) in tracks.enumerated() { if let key = entry.key { slots[key] = i } }
            canonical = allowed

            self.folder = folder
            self.folderKey = folderKey
            session = UUID().uuidString
            revision = 0
            fencedRevision = nil
            let order: [Int]
            if mode != .shuffle { order = eligible }
            else if selected { order = [initial] + shuffledStart(eligible.filter { $0 != initial }) }
            else { order = shuffledStart(eligible) }
            replaceRun(cursor: PlayCursor(order: order, slot: selected || bookmarked != nil ? order.firstIndex(of: initial)! : 0),
                       position: .seconds(legacyPosition ?? (bookmarked != nil ? bookmark!.seconds : 0)), paused: legacyPosition != nil,
                       delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh)
            armTimer(playing: legacyPosition == nil)
            saveCheckpoint()
        }
    }

    /// Called under the player lock. The serial worker drains the retiring run before decoding its replacement.
    private func replaceRun(cursor: PlayCursor, advanced: Bool = false, position: PlaybackRun.Position = .seconds(0), paused: Bool = false,
                            seekItem: String? = nil, duration: MP3RangeDecoder.Length = .unknown, admitted: MediaLocation? = nil, budget: MediaRanges.Budget = .init(),
                            delaySeconds: Int = 0, nearEnd: Bool = false, forceRefresh: Bool = false,
                            issuedAt: Double = ProcessInfo.processInfo.systemUptime, restoredNext: PlayCursor? = nil) {
        // Keep the descriptor across a seek or resume even if the last pin was removed.
        let carry = active?.lease(for: catalog[cursor.index].fileKey)
        active?.cancel()
        let run = PlaybackRun(tracks: catalog, cursor: cursor, restoredNext: restoredNext, advanced: advanced, mode: mode, nextPolicy: nextPolicy(for: mode), position: position, paused: paused, seekItem: seekItem, duration: duration,
                              admitted: admitted, pinStore: store, lease: carry, lookup: lookup, captureURL: destination, diagnostics: diagnostics, pool: pool, budget: budget) { [weak self] debugOnly in
            DispatchQueue.main.async { [weak self] in
                if !debugOnly { self?.checkpoint() }
                self?.onChange?(debugOnly)
            }
        }
        active = run
        if store != nil && ticker == nil {
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + 5, repeating: 5)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.checkpoint()
                Task { try? await self.waitForCheckpointWrites() }
            }
            timer.resume()
            ticker = timer
        }
        run.setDeadline(deadline)
        worker.async { [self] in
            releaseIdleAudioSession()
            if !run.startsAtEnd {
                if let failed = run.playAndReport(issuedAt: issuedAt, delaySeconds: delaySeconds, nearEnd: nearEnd,
                                                  forceRefresh: forceRefresh, setOutputActive: setOutputActive) {
                    lock.withLock {
                        guard active === run else { return }
                        unreadable.insert(catalog[failed.index].fileKey)
                        guard fencedRevision == nil, run.shouldContinueAfterUnreadable,
                              deadline.map({ .now < $0 }) != false else { return }
                        // Removal keeps the relative order of the current pass, including Shuffle.
                        let allowed = Set(playableOrder)
                        let order = failed.order.filter(allowed.contains)
                        guard !order.isEmpty else { return }
                        let skipped = failed.revised(for: order, from: .all, to: .all)
                        if let next = skipped.neighbor(1, mode: mode) {
                            replaceRun(cursor: next, advanced: true)
                        } else if mode == .repeat || mode == .shuffle {
                            replaceRun(cursor: PlayCursor(order: mode == .shuffle ? order.shuffled() : order, slot: 0), advanced: true)
                        }
                    }
                }
            }
            releaseIdleAudioSession()
        }
    }

    /// Take focus only after the first chunk has decoded. A paused cold restore never activates.
    private func setOutputActive(_ playing: Bool) throws {
        guard playing else { releaseIdleAudioSession(); return }
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
        try audio.setPrefersInterruptionOnRouteDisconnect(true)
        try audio.setActive(true)
        lock.withLock { ownsAudioSession = true }
        #endif
    }

    /// Runs on the decoder queue, after the retiring I/O has stopped. The successor's
    /// intent determines whether this is a handoff inside OnePlay or the end of listening.
    private func releaseIdleAudioSession() {
        #if os(iOS)
        guard lock.withLock({ ownsAudioSession && active?.wantsPlay != true }) else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            lock.withLock { ownsAudioSession = false }
        } catch { diagnostics?.record("Audio session deactivation failed") }
        #endif
    }

    #if DEBUG
    /// XCTest stops a live graph to exercise the loss of the hardware render clock.
    var engineForTesting: AVAudioEngine? { lock.withLock { active?.engine } }
    #endif

    /// A command belongs to the item that the listener touched, including a repeated play of the same URL.
    @discardableResult
    func apply(_ action: String, item: String, seconds: Double?) throws -> Bool {
        try lock.withLock { try applyLocked(action, item: item, seconds: seconds) }
    }

    /// Remote transport keys address the audible occurrence even while WebKit is suspended.
    func applyRemote(_ command: String, seconds: Double? = nil, displayedItem: String? = nil) throws -> Bool {
        try lock.withLock { try applyLocked(command, item: displayedItem, seconds: seconds) }
    }

    @discardableResult private func applyLocked(_ action: String, item: String?, seconds: Double?, automaticResume: Bool = false) throws -> Bool {
        let issuedAt = ProcessInfo.processInfo.systemUptime
        guard let run = active else { return false }
        if fencedRevision != nil && (action == "next" || action == "previous") { return false }
        defer { saveCheckpoint() }
        if action == "cycleMode" {
            let next = mode.following
            guard configure(run, mode: next, item: item) else { return false }
            armTimer(playing: active?.wantsPlay == true)
            return true
        }
        guard let result = try run.apply(action, item: item, seconds: seconds, interruptedItem: interruptedItem,
                                         offlineKeys: offlineKeys, resumeBefore: automaticResume ? deadline : nil) else { return false }
        interruptedItem = nil
        if let restart = result.restart {
            // A seek can keep the occurrence. Only a newly accepted target supersedes its wait.
            targetRevision += 1
            replaceRun(cursor: restart.cursor, advanced: restart.advanced, position: restart.position, paused: restart.paused,
                       seekItem: restart.seekItem, duration: restart.duration, admitted: restart.admitted, budget: run.budget, issuedAt: issuedAt)
        }
        if fencedRevision != nil { continueAfterFence = result.playing }
        if !automaticResume || deadline == nil { armTimer(playing: result.playing) }
        return true
    }

    /// A compatible revision keeps the decoder, node and prepared bytes. Only a different
    /// immediate audio decision needs the existing stop-and-seek path to retract submitted PCM.
    @discardableResult private func configure(_ run: PlaybackRun, mode newMode: QueueMode, item: String? = nil, resumeAtBoundary: Bool = false) -> Bool {
        let updated = run.configure(catalog: catalog, canonical: playableOrder, mode: newMode,
            nextPolicy: nextPolicy(for: newMode), item: item, blocked: blocked, resumeAtBoundary: resumeAtBoundary)
        guard updated.applied else { return false }
        structureDirty = structureDirty || mode != newMode
        mode = newMode
        if updated.revoked {
            interruptedItem = nil
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
            structureDirty = true
            defer { saveCheckpoint() }
            fencedRevision = next
            revision = next
            configure(run, mode: mode)
        }
    }

    /// Library revisions carry canonical order. Preparation budgets and occurrence references
    /// retain their slot even when a row moves or temporarily disappears.
    func revise(session expected: String, revision next: Int, folder: [String], tracks: [IndexedTrack], favorite: String? = nil) {
        lock.withLock {
            guard session == expected, next > revision || next == fencedRevision, let run = active else { return }
            let continueAtEnd = fencedRevision != nil && continueAfterFence
            structureDirty = structureDirty || fencedRevision != nil || self.folder != folder || self.favorite != favorite
            self.favorite = favorite
            fencedRevision = nil
            revision = next
            self.folder = folder
            let newOrder = tracks.compactMap { entry -> Int? in
                guard let key = entry.key, !blocked(entry.sourceRootKey ?? "") else { return nil }
                if let slot = slots[key] {
                    if catalog[slot] != entry { catalog[slot] = entry; structureDirty = true }
                    return slot
                }
                slots[key] = catalog.count
                catalog.append(entry)
                return catalog.count - 1
            }
            structureDirty = structureDirty || canonical != newOrder
            canonical = newOrder
            configure(run, mode: mode, resumeAtBoundary: continueAtEnd && (deadline.map { $0 > .now } ?? true))
            saveCheckpoint()
        }
    }

    /// A fresh decision fences older probes even when it confirms the previous value. Omitted
    /// membership is unknown; only an explicit allowed decision clears a persisted denial.
    /// Revoke output immediately. Publish the new revision only after the complete access file commits.
    @discardableResult
    func updateAccess(base: Int, connected: Set<String>?, denied: Set<String>, allowed: Set<String> = [], disconnected: Set<String> = []) throws -> Bool {
        try lock.withLock {
            // A prior write may have failed after its denial took effect in memory. Finish it
            // before comparing the caller's observed (durable) revision.
            if accessDirty {
                saveCheckpoint()
                guard !accessDirty else { throw NativeAccountError.unavailable }
            }
            guard base == accessRevision else { return false }
            let known = connected ?? connectedShares
            // A stale cached membership list may re-add a disconnected root on reattachment.
            // Only a successful source probe can grant access again.
            let removed = connected.map { (connectedShares ?? []).subtracting($0) } ?? []
            let excluded = deniedRoots.subtracting(allowed).union(denied).union(removed).union(disconnected)
            let changed = connectedShares != known || deniedRoots != excluded
            connectedShares = known
            deniedRoots = excluded
            if changed, let run = active {
                canonical = canonical.filter { !blocked(catalog[$0].sourceRootKey ?? "") }
                configure(run, mode: mode)
                structureDirty = true
            }
            accessDirty = store != nil
            if store == nil { accessRevision += 1 } // Standalone in-memory player.
            saveCheckpoint()
            guard !accessDirty else { throw NativeAccountError.unavailable }
            return true
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
            guard old != setting else { return }
            structureDirty = true
            defer { saveCheckpoint() }
            guard mode == .timer, let run = active else { return }
            configure(run, mode: mode)
            // An interruption preserves the cutoff already promised to the listener.
            // The changed setting governs the next user-initiated Play.
            if interruptedItem == nil { armTimer(playing: active?.wantsPlay == true) }
        }
    }

    /// A stopped audio graph can lose both the node timeline and its queued PCM.
    /// Keep the occurrence and its admitted bytes, and rebuild from the frozen position.
    enum OutputChange {
        case interruption(mayResume: Bool)
        case configuration(AVAudioEngine)
        case servicesReset
        case routeDisconnected
        case parkPaused
    }

    @discardableResult func handleOutputChange(_ change: OutputChange) -> Bool {
        lock.withLock {
            switch change {
            case .interruption, .servicesReset: ownsAudioSession = false
            default: break
            }
            guard let run = active else { return false }
            switch change {
            case .interruption(mayResume: false), .servicesReset, .routeDisconnected:
                interruptedItem = nil
            default: break
            }
            guard let (point, next) = run.retireOutput(for: change) else { return false }
            let paused: Bool
            switch change {
            case .interruption(let mayResume):
                if mayResume && !point.paused { interruptedItem = point.seekItem }
                if !mayResume { armTimer(playing: false) }
                continueAfterFence = false
                paused = true
            case .servicesReset, .routeDisconnected:
                armTimer(playing: false)
                continueAfterFence = false
                paused = true
            case .parkPaused, .configuration: paused = point.paused
            }
            replaceRun(cursor: point.cursor, advanced: point.advanced, position: point.position,
                       paused: paused, seekItem: point.seekItem, duration: point.duration,
                       admitted: point.admitted, budget: run.budget, restoredNext: next)
            saveCheckpoint()
            return true
        }
    }

    /// Only the occurrence that iOS interrupted can consume this one-shot recommendation.
    func finishInterruption(shouldResume: Bool) throws {
        try lock.withLock {
            guard let item = interruptedItem else { return }
            interruptedItem = nil
            if shouldResume, deadline.map({ $0 > .now }) ?? true {
                try applyLocked("play", item: item, seconds: nil, automaticResume: true)
            }
        }
    }

    func stop() { lock.withLock { interruptedItem = nil; active?.cancel(); active = nil; armTimer(playing: false); saveCheckpoint() } }

    func cancelWiFiReadsIfMetered() { lock.withLock { pool.cancelWiFiReadsIfMetered() } }

    /// UIKit memory pressure may discard any compressed block. Active readers can fetch it again.
    func releaseCachedAudio() { lock.withLock { pool.clear() } }

    /// Park the audible anchor before replacing the player. Logout's stop clears the saved queue.
    func parkAndCheckpointForProfileSwitch() {
        lock.withLock {
            _ = try? applyLocked("pause", item: nil, seconds: nil)
            saveCheckpoint()
        }
    }

    /// Logout drains all in-flight bytes before removing the diagnostic recording. Retrying cleanup is safe.
    func stopAndDrain() async throws {
        lock.withLock { interruptedItem = nil; ticker?.cancel(); ticker = nil; store = nil; accessRevision = 0; accessDirty = false; spots.removeAll(); hasHistory = false; savedPoint = nil; savedCursor = nil; structureDirty = true; favorite = nil; folder = []; folderKey = ""; active?.cancel(); active = nil; catalog = []; canonical = []; slots = [:]; connectedShares = nil; deniedRoots = []; mode = .all; armTimer(playing: false); pool = MediaPool(unmeteredWiFi: pool.unmeteredWiFi) }
        await withCheckedContinuation { continuation in writer.async { self.pendingWrites.removeAll(); continuation.resume() } }
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
    private var tracks: [IndexedTrack]
    private let captureURL: URL
    private let diagnostics: NativeDiagnostics?
    let budget: MediaRanges.Budget
    private let pool: MediaPool
    private var pinLeases = [String: LocalMP3]()
    func lease(for key: String) -> LocalMP3? { lock.withLock { pinLeases[key] } }
    private let pinStore: PlaybackStore?
    private let lookup: NativePlayback.Lookup
    private let log = Logger(subsystem: "me.unto.oneplay.music", category: "Playback")
    private let lock = NSLock()
    private var cancelled = false
    private let admitted: MediaLocation?
    private let signalChange: @Sendable (Bool) -> Void
    private var sources = [MediaRanges]()
    private weak var preparingWindow: MediaRanges.SuccessorWindow?
    private var message = "Preparing playback"
    fileprivate let engine = AVAudioEngine()
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
    private var graphStarted = false
    private var started = false
    private var drainingFinal = false
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
        var streamedFile: MediaPool.File? = nil
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

    /// Cursor, successor, clock and length must all describe the same side of a render boundary.
    func persistenceAnchor() -> (cursor: PlayCursor, next: PlayCursor?, item: String, seconds: Double, duration: MP3RangeDecoder.Length, atEnd: Bool)? {
        lock.withLock {
            let frame = min(renderedFrame(), scheduled)
            let entry = audibleAnchor(at: frame)
            if entry.cursor.held != nil && terminal == "ended" { return nil }
            let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
            return (entry.cursor, entry.next, entry.item, terminal == "ended" ? 0 : seconds, entry.duration, startsAtEnd && terminal == nil)
        }
    }

    /// Capture the same file lease or versioned blocks as the audible decoder. The
    /// returned reader runs off the playback worker and never changes its byte cursor.
    func artworkReader(for item: String) -> NowPlayingArtwork.ReadPrefix? {
        lock.withLock {
            let entry = audibleAnchor(at: min(renderedFrame(), scheduled))
            guard item == entry.item else { return nil }
            let track = tracks[entry.index]
            guard let file = entry.streamedFile else {
                guard let file = pinLeases[track.fileKey] else { return nil }
                return { count in Int64(count) <= file.size ? try? file.read(0, count) : nil }
            }
            return { [pool] count in
                guard Int64(count) <= file.size else { return nil }
                var data = Data()
                for offset in stride(from: 0, to: count, by: MediaRanges.block) {
                    let needed = min(count - offset, MediaRanges.block)
                    guard let block = pool.read(file, at: Int64(offset)), block.count >= needed else { return nil }
                    data.append(block.prefix(needed))
                }
                return data
            }
        }
    }

    func snapshot(lookups: [IndexedTrack]?, pinSizes: [String: Int]) -> [String: Any] {
        lock.withLock {
            expireIfDue()
            let rendered = renderedFrame()
            let frame = min(rendered, scheduled)
            let entry = audibleAnchor(at: frame)
            let track = tracks[entry.index]
            guard let path = track.path else { return [:] }
            if entry.cursor.held != nil && terminal == "ended" { return [:] }
            let needsPCM = !started || rendered >= scheduled
            let playing = !needsPCM && engine.isRunning && node.isPlaying
            let showWait = needsPCM && waitingInputs.contains(requiredInput) && !cachedStarts.contains(requiredInput)
            let state = terminal ?? (paused ? "paused" : playing ? "playing" : showWait ? "buffering" : "positioning")
            let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
            var result: [String: Any] = ["item": entry.item, "advanced": entry.advanced, "title": track.title ?? path.last ?? "", "key": track.key ?? track.itemId, "path": path, "state": state,
                    "album": track.album ?? "", "position": seconds, "duration": Double(entry.duration.frames) / Double(rate), "message": message]
            result["systemTitle"] = track.systemTitle
            result["canPrevious"] = nextPolicy != .fenced && (entry.cursor.held.map { $0.previous != nil } ?? (entry.cursor.slot > 0 || mode == .repeat || mode == .shuffle))
            result["canNext"] = nextPolicy != .fenced && (entry.next != nil || entry.cursor.held != nil)
            result["sourceRootKey"] = track.sourceRootKey
            if entry.cursor.held != nil { result.removeValue(forKey: "path") }
            if let lookups { result["bars"] = debugBars(at: entry, lookups: lookups, pinSizes: pinSizes) }
            return result
        }
    }

    init(tracks: [IndexedTrack], cursor: PlayCursor, restoredNext: PlayCursor?, advanced: Bool, mode: QueueMode, nextPolicy: NextPolicy, position: Position, paused: Bool, seekItem: String?, duration: MP3RangeDecoder.Length, admitted: MediaLocation?, pinStore: PlaybackStore?, lease: LocalMP3?, lookup: @escaping NativePlayback.Lookup, captureURL: URL, diagnostics: NativeDiagnostics?, pool: MediaPool, budget: MediaRanges.Budget, signalChange: @escaping @Sendable (Bool) -> Void) {
        self.admitted = admitted
        self.signalChange = signalChange
        self.budget = budget
        self.pool = pool
        self.tracks = tracks
        self.pinStore = pinStore
        if let lease { pinLeases[tracks[cursor.index].fileKey] = lease }
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
        self.anchor = Anchor(cursor: cursor, next: restoredNext ?? cursor.neighbor(1, mode: mode), item: seekItem ?? UUID().uuidString, advanced: advanced, nodeFrame: 0, fileFrame: 0, duration: duration)
        self.diagnostics = diagnostics
        self.lookup = lookup
        self.captureURL = captureURL
        if startsAtEnd {
            terminal = paused ? nil : "ended"
            message = paused ? "Paused at end of track" : "Finished \(tracks.count) track(s)"
        }
    }
    private func debugBars(at entry: Anchor, lookups: [IndexedTrack], pinSizes: [String: Int]) -> [[String: Any]] {
        return [entry.cursor.neighbor(-1, mode: mode)?.index, entry.index, nextPolicy == .fenced ? nil : entry.next?.index].map { index in
            guard let ordinal = index else { return [:] }
            let track = tracks[ordinal]
            let file = sources.last { $0.occurrence == ordinal+1 }?.file
            var bar = pool.debugRanges(drive: track.driveId, item: track.itemId, admitted: file)
            // An active decoder can still read the whole file after the last favorite unpins it.
            bar["offlineBytes"] = pinLeases[track.fileKey].map { Int($0.size) } ?? pinSizes[track.fileKey]
            bar["name"] = track.title ?? track.path?.last
            bar["lookup"] = lookups.contains { $0.driveId == track.driveId && $0.itemId == track.itemId }
            return bar
        }
    }

    var shouldContinueAfterUnreadable: Bool { lock.withLock { !paused } }
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
    func configure(catalog: [IndexedTrack], canonical: [Int], mode nextMode: QueueMode, nextPolicy policy: NextPolicy,
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
                if blocked(catalog[current].sourceRootKey ?? "") {
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
    func apply(_ command: String, item expected: String?, seconds: Double?, interruptedItem: String?, offlineKeys: Set<String>?, resumeBefore: ContinuousClock.Instant?) throws -> (restart: Point?, playing: Bool)? {
        try lock.withLock {
            expireIfDue()
            let frame = min(renderedFrame(), scheduled)
            let entry = audibleAnchor(at: frame)
            // A failed or naturally ended run remains controllable after its preparation
            // worker has been cancelled. An explicit Stop/replacement removes the run.
            let item = entry.item
            guard expected == nil || expected == item, !cancelled || terminal != nil else { return nil }
            if let resumeBefore, .now >= resumeBefore { return nil }
            let action = command == "toggle" ? ((!paused && terminal == nil) || interruptedItem == item ? "pause" : "play") : command
            let key = tracks[entry.index].fileKey
            if action == "play", let offlineKeys,
               !offlineKeys.contains(key), pinLeases[key] == nil { throw PlaybackError("This track is unavailable offline.") }
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
                    if action == "pause" { _ = renderedFrame() }
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

    /// Freeze the render anchor before stopping the node. Configuration notifications from
    /// retired engines and repeated interruptions of a parked run have no effect.
    func retireOutput(for change: NativePlayback.OutputChange) -> (Point, PlayCursor?)? {
        lock.withLock {
            expireIfDue()
            guard !cancelled, terminal == nil, !startsAtEnd else { return nil }
            switch change {
            case .configuration(let changed):
                guard changed === engine, graphStarted, !engine.isRunning else { return nil }
            case .interruption, .routeDisconnected:
                guard !paused || graphStarted else { return nil }
            case .parkPaused:
                guard paused && graphStarted else { return nil }
            case .servicesReset: break // Every audio object predating the reset is invalid.
            }
            let frame = min(renderedFrame(), scheduled)
            let entry = audibleAnchor(at: frame)
            let seconds = started ? Double(entry.fileFrame + max(0, frame - entry.nodeFrame)) / Double(rate) : lastPosition
            let location = sources.last { $0.occurrence == entry.index + 1 }?.admission ?? (entry.index == startIndex ? admitted : nil)
            cancelLocked()
            return ((entry.cursor, .seconds(seconds), paused, entry.item, entry.duration, location, entry.advanced), entry.next)
        }
    }

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
        lock.withLock {
            message = text
            terminal = state
            // A finished footer has no decoder. Explicit cancellation may be handing a
            // descriptor to its replacement in the caller's seek/next critical section.
            if state != nil && (!cancelled || state == "error" || state == "unavailable") { pinLeases.removeAll() }
        }
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
        var stoppedSince: ContinuousClock.Instant?
        while lock.withLock({ renderedFrame() < target }) {
            try checkCancellation()
            try checkOutput(&stoppedSince)
            Thread.sleep(forTimeInterval: 0.012)
        }
        try checkCancellation()
    }

    /// The graph may stop before iOS delivers its lifecycle notification. Bound the wait
    /// for an unexplained output failure while allowing an intentional pause to last indefinitely.
    private func checkOutput(_ stoppedSince: inout ContinuousClock.Instant?) throws {
        if lock.withLock({ paused || (engine.isRunning && node.isPlaying) }) { stoppedSince = nil }
        else if let since = stoppedSince {
            if since.duration(to: .now) > .seconds(2) { throw PlaybackError("Audio output interrupted") }
        } else { stoppedSince = .now }
    }

    /// Advance the schedule clock through starvation once. The decoder stays at its first missing frame.
    @discardableResult private func enqueue(_ pcm: AVAudioPCMBuffer, frames: Range<Int>, incoming: (file: MediaPool.File?, duration: MP3RangeDecoder.Length)? = nil) throws -> Int64 {
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
                successor = Anchor(cursor: cursor, next: cursor.neighbor(1, mode: mode), item: UUID().uuidString, advanced: true, nodeFrame: start, fileFrame: Int64(frames.lowerBound), duration: incoming.duration, streamedFile: incoming.file)
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
        var stoppedSince: ContinuousClock.Instant?
        while lastPlayed?.wait(timeout: .now() + 0.1) == .timedOut {
            try checkCancellation()
            lock.withLock { _ = renderedFrame() }
            try checkOutput(&stoppedSince)
        }
        try checkCancellation()
        // A stopped engine also completes scheduled buffers. Only rendered PCM can finish a song.
        try wait(until: scheduled)
        #if DEBUG
        // The tap batches up to 4096 frames even when it is asked for 1024. Leave the render graph
        // alive for the pending callback and a silent buffer, so the measured file includes the last sound.
        if capturing && started { try wait(until: scheduled + 8192) }
        #endif
    }

    /// Convert operational errors into safe diagnostics. Native account errors expose a bounded category.
    func playAndReport(issuedAt: Double, delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool, setOutputActive: (Bool) throws -> Void) -> PlayCursor? {
        var failed: PlayCursor?
        let queuedMs = Int((ProcessInfo.processInfo.systemUptime - issuedAt) * 1000)
        log.info("Start item=\(self.startIndex + 1) seekSeconds=\(self.startSeconds) workerWaitMs=\(queuedMs)")
        do {
            try play(delaySeconds: delaySeconds, nearEnd: nearEnd, forceRefresh: forceRefresh, setOutputActive: setOutputActive)
            report("Finished \(lock.withLock { anchor.cursor.order.count }) track(s)", terminal: "ended")
        } catch is CancellationError {
            report("Stopped", terminal: "ended")
        } catch is UnreadableRecording {
            failed = lock.withLock { anchor.duration = .unknown; return anchor.cursor }
            report("Skipped unreadable recording", terminal: "ended")
        } catch let error as PlaybackError {
            diagnostics?.record("Playback stopped: \(error.errorDescription ?? "decoder error")")
            report(error.errorDescription ?? "Playback failed", terminal: "error")
        } catch let error as NativeAccountError {
            diagnostics?.record("Playback lookup stopped: \(error.rawValue)")
            if error == .missingRecording { report("This demo recording is unavailable", terminal: "unavailable") }
            else { report(error == .forbidden ? "OneDrive denied access to this recording" : "Playback lookup: \(error.rawValue)", terminal: "error") }
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
        return failed
    }

    /// Defer decoding a paused seek until Play. Replacing or stopping the run also releases this wait.
    private func waitWhilePaused() throws {
        while lock.withLock({ paused && !cancelled }) { resumeOrStop.wait() }
        try checkCancellation()
    }

    private func play(delaySeconds: Int, nearEnd: Bool, forceRefresh: Bool, setOutputActive: (Bool) throws -> Void) throws {
        try waitWhilePaused()
        #if DEBUG
        let timingStart = ProcessInfo.processInfo.systemUptime
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
            anchor = Anchor(cursor: anchor.cursor, next: anchor.next, item: anchor.item, advanced: anchor.advanced, nodeFrame: 0, fileFrame: firstFrame + Int64(chunk.audible.lowerBound), duration: decoder.length, streamedFile: source?.file)
        }
        #if DEBUG
        let decoded = ProcessInfo.processInfo.systemUptime
        #endif
        // Activation can block while Pause or timer expiry arrives. Commit graph startup
        // under the run lock, and return unused focus before waiting for another Play.
        while true {
            try waitWhilePaused()
            try setOutputActive(true)
            let startedGraph = try lock.withLock {
                if cancelled { throw CancellationError() }
                expireIfDue()
                guard !paused else { return false }
                try engine.start()
                graphStarted = true
                return true
            }
            if startedGraph { break }
            try setOutputActive(false)
        }
        // Hardware can discard the node clock while the decoder is blocked on a network
        // read. Keep a recent render position independently of WebKit and disk checkpoints.
        let clockSampler = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        clockSampler.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500), leeway: .milliseconds(50))
        clockSampler.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.withLock { _ = self.renderedFrame() }
        }
        clockSampler.resume()
        defer { clockSampler.cancel() }
        #if DEBUG
        let engineStarted = ProcessInfo.processInfo.systemUptime
        func ms(_ interval: Double) -> Int { Int((interval * 1000).rounded()) }
        log.notice("First PCM seek=\(self.startSeconds) openMs=\(ms(opened-timingStart)) connectMs=\(ms(connected-opened)) decodeMs=\(ms(decoded-connected)) engineMs=\(ms(engineStarted-decoded))")
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
                                           incoming: (incoming?.file, nextDecoder.length))
                log.notice("ready item=\(nextIndex + 1) prefixFrames=\(cut-head.audible.lowerBound) specBytes=\(incoming?.specBytes ?? 0) overlap=\(mix) boundary=\(boundary)")
                try wait(until: boundary + 1)
                lock.withLock {
                    if let successor {
                        anchor = successor
                        self.successor = nil
                        let promoted = tracks[anchor.index].fileKey
                        pinLeases = pinLeases.filter { $0.key == promoted }
                    }
                }
                signalChange(false)
                source?.cancelAndDrain()
                lock.withLock { sources.removeAll { $0 === source } }
                ordinal = nextIndex + 1
                report("Playing track \(ordinal)")
                if let incoming {
                    // The player consumes the runway independently of this lookup and its first new range.
                    incoming.promote()
                    if forceRefresh, !head.final {
                        let recording = lock.withLock { tracks[ordinal-1] }
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

    private func open(_ track: IndexedTrack, ordinal: Int, input: Int, speculative: Bool, admitted: MediaLocation? = nil, successorWindow: MediaRanges.SuccessorWindow? = nil, awaitDemand: (() throws -> Void)? = nil) throws -> (MediaRanges?, MP3RangeDecoder) {
        let suffix = PlaybackStore.recordingSuffix(track.title ?? track.path?.last ?? "")
        let hint: AudioFileTypeID = suffix == "mp3" || suffix.isEmpty ? kAudioFileMP3Type : 0
        if let file = lease(for: track.fileKey) { return (nil, try file.decoder(fallback: hint)) }
        if let pinStore {
            do {
                let file = try pinStore.localSuffixes.withLock { suffixes -> LocalMP3? in
                    let url = pinStore.pinURL(track.fileKey, suffix: suffixes[track.fileKey] ?? "")
                    // Hold the name stable until the descriptor is open. A streaming seek
                    // keeps its admitted version when a newer pin has arrived.
                    guard admitted == nil || (try? PinReceipt.read(from: url))?.version == admitted?.etag else { return nil }
                    return try LocalMP3(url)
                }
                if let file {
                    let decoder = try file.decoder(fallback: hint)
                    lock.withLock { pinLeases[track.fileKey] = file }
                    return (nil, decoder)
                }
            } catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
                // A cache miss falls through to the existing streaming reader.
            }
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
        if media.size == 0 { throw UnreadableRecording() }
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
        }, diagnostic: { [diagnostics] event in diagnostics?.record("CDN item=\(ordinal) \(event)") }, awaitDemand: awaitDemand,
            renew: { [unowned self] rejected in try self.resolve(track, .replace(rejected)) })
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
        return (source, try MP3RangeDecoder(bytes: media.size, knownLength: knownLength, typeHint: hint, read: source.read))
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
        guard n > 0 || position > 0 else { throw UnreadableRecording() }
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

/// The open descriptor keeps pinned bytes readable through the last decoder read, even after unlink.
private final class LocalMP3 {
    private let lock = NSLock()
    private let file: FileHandle
    let size: Int64
    let suffix: String

    init(_ url: URL) throws {
        suffix = url.pathExtension
        file = try FileHandle(forReadingFrom: url)
        size = try Int64(file.seekToEnd())
    }

    deinit { try? file.close() }

    /// A lease carries the on-disk format hint through seeks and queue renames.
    func decoder(fallback: AudioFileTypeID) throws -> MP3RangeDecoder {
        let hint = suffix.isEmpty ? fallback : (suffix == "mp3" ? kAudioFileMP3Type : 0)
        return try MP3RangeDecoder(bytes: size, typeHint: hint, read: read)
    }

    func read(_ offset: Int64, _ count: Int) throws -> Data {
        try lock.withLock {
            try file.seek(toOffset: UInt64(offset))
            return try file.read(upToCount: count) ?? Data()
        }
    }
}
