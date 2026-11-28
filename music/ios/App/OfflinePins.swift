import Foundation
import OSLog

/// One owner's last complete membership survives a cold launch with only part of the library loaded.
struct PinOwner: Codable, Equatable {
    var sources: [String: Set<String>]
    var retained: Set<String>
    var paused: Bool
}

private struct PinManifest: Codable, Equatable {
    var binding = UUID()
    var quota = 1 << 30
    var owners = [String: PinOwner]()
    // Background transfers may finish before the page republishes the index on relaunch.
    var suffixes: [String:String]?
}

/// URLSession owns partial files. The account's audio directory contains only validated, atomically
/// published recordings. Unlinking an unpinned recording leaves existing decoder descriptors readable.
@MainActor final class OfflinePins: NSObject, @preconcurrency URLSessionDownloadDelegate {
    static let identifier = "me.unto.oneplay.music.pins"
    private struct Ticket: Codable {
        let binding: UUID
        let key: String
        let size: Int64
        let version: String
        let retry: Bool
    }
    private var manifest = PinManifest()
    private var storage: PlaybackStore?
    private let config: URLSessionConfiguration
    init(configuration: URLSessionConfiguration) { config = configuration }
    private var session: URLSession!
    private var resolving = [String: Task<Void, Never>]()
    private var running = [String: URLSessionDownloadTask]()
    // M17 background-session recovery admits only daemon task IDs saved under this account binding.
    private var tickets = [String: Int]()
    private var missing = Set<String>()
    private var eligible = Set<String>()
    private(set) var sizes = [String: Int]()
    private var leased = [String: Int]()
    private var cleanup: Task<Void,Never>?
    var playerHolds: (String) -> Bool = { _ in false }
    private var opening: Task<(PlaybackStore, PinManifest, [String: Int], [String: String]), Error>?
    private var accountGeneration = 0
    private var total = 0
    private var failures = [String: String]()
    private var retryCount = [String: Int]()
    private var delayed = [String: Task<Void, Never>]()
    private var renew = Set<String>()
    private var attached = false
    private var evidence = "no-evidence"
    private var revision = 0
    private var deltas = [(revision: Int, key: String)]()
    var onChange: (() -> Void)?
    var onFinishEvents: (() -> Void)?
    var allowsSource: (String) -> Bool = { _ in true }
    var allowsMediaKey: (String) -> Bool = { _ in true }
    private var publicMedia = false
    var lookup: ((String, String, MediaLookup) async throws -> MediaLocation)?
    var completeKeys: Set<String> { Set(sizes.keys) }
    // Cached public pins can let the transfer itself test an uncertain route.
    private var canTransfer: Bool { evidence == "evidence:signed-in" || (publicMedia && evidence == "no-evidence") }

    /// Session creation is delayed until the account and its inventory are ready to receive daemon callbacks.
    func connectSession() async {
        guard session == nil else { return }
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        for case let task as URLSessionDownloadTask in await session.allTasks {
            guard let ticket = ticket(for: task), eligible.contains(ticket.key), sizes[ticket.key] == nil,
                  running[ticket.key] == nil, task.state == .running || task.state == .suspended else { task.cancel(); continue }
            running[ticket.key] = task
            if task.state == .suspended { task.resume() }
        }
        attached = true
        pump()
    }

    /// A different installation of the same account gets a fresh binding after explicit sign-out.
    func bind(_ store: PlaybackStore) async throws {
        guard storage?.directory != store.directory else { return }
        let generation = accountGeneration
        let task = opening ?? Task.detached(priority: .utility) { try Self.restore(store) }
        opening = task
        defer { if generation == accountGeneration { opening = nil } }
        // All waiters adopt the first caller’s account store, which the player already bound.
        let (bound, saved, inventory, extensions) = try await task.value
        guard generation == accountGeneration else { throw NativeAccountError.cancelled }
        guard storage == nil else { return }
        storage = bound
        manifest = saved
        bound.localSuffixes.withLock { $0 = extensions }
        sizes = inventory
        tickets = try store.read([String: Int].self, "pin-transfers") ?? [:]
        total = sizes.values.reduce(0, +)
        try reconcile()
    }

    nonisolated private static func restore(_ store: PlaybackStore) throws -> (PlaybackStore, PinManifest, [String: Int], [String: String]) {
        var folder = store.pinDirectory
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var flags = URLResourceValues()
        flags.isExcludedFromBackup = true
        try folder.setResourceValues(flags)
        let saved = try store.read(PinManifest.self, "pins") ?? PinManifest()
        try store.save(saved, "pins")
        let retained = saved.owners.values.reduce(into: Set<String>()) { $0.formUnion($1.retained) }
        let names = Dictionary(uniqueKeysWithValues: retained.map { (PlaybackStore.pinName($0), $0) })
        var inventory = [String: Int](), extensions = [String: String]()
        for url in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey]) {
            if let key = names[url.deletingPathExtension().lastPathComponent], let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               try PinReceipt.read(from: url)?.size == size {
                inventory[key] = size
                extensions[key] = url.pathExtension
            } else { try FileManager.default.removeItem(at: url) }
        }
        return (store, saved, inventory, extensions)
    }

    /// Close admission synchronously with the sign-out marker, before WebKit retirement yields.
    func closeAdmission() {
        accountGeneration += 1
        cleanup?.cancel()
        cleanup = nil
        storage = nil
        leased.removeAll()
        manifest = PinManifest()
        for task in resolving.values { task.cancel() }
        resolving.removeAll()
        for task in running.values { task.cancel() }
        running.removeAll()
        tickets.removeAll()
        missing.removeAll()
        eligible.removeAll()
        sizes.removeAll()
        total = 0
        for timer in delayed.values { timer.cancel() }
        delayed.removeAll()
        retryCount.removeAll()
        renew.removeAll()
        failures.removeAll()
        changed()
    }

    func unbindAndCancel() async {
        closeAdmission()
        _ = await opening?.result
        opening = nil
        if session == nil { await connectSession() }
        for task in await session.allTasks { task.cancel() }
    }

    func updateEvidence(_ value: String, publicMedia: Bool? = nil) {
        let nextPolicy = publicMedia ?? self.publicMedia
        guard value != evidence || nextPolicy != self.publicMedia else { return }
        let wasAllowed = canTransfer
        evidence = value
        self.publicMedia = nextPolicy
        if !wasAllowed && canTransfer { resumePending() }
        changed()
    }

    /// The document supplies a complete list of pin owners only after favorite membership has loaded.
    /// A partial projection activates its known subset while retaining previous bytes for unresolved sources.
    func apply(owners rows: [[String: Any]]) throws {
        guard let storage else { throw NativeAccountError.unbound }
        var next = manifest
        next.owners.removeAll()
        next.suffixes = [:]
        for row in rows {
            guard let id = row["id"] as? String, next.owners[id] == nil, let paused = row["paused"] as? Bool,
                  let complete = row["complete"] as? Bool, let groups = row["sources"] as? [String: [String: String]]
            else { throw NativeAccountError.invalidRequest }
            for members in groups.values {
                for (key, name) in members where next.suffixes?[key] == nil {
                    next.suffixes?[key] = PlaybackStore.recordingSuffix(name)
                }
            }
            let sources = groups.mapValues { Set($0.keys) }
            var retained = complete ? Set<String>() : manifest.owners[id]?.retained ?? []
            for keys in sources.values { retained.formUnion(keys) }
            next.owners[id] = PinOwner(sources: sources, retained: retained, paused: paused)
        }
        if next != manifest {
            try storage.save(next, "pins")
            manifest = next
        }
        // Existing descriptors survive rename. Migrate the bounded offline inventory in
        // place, once per physical file. A failed rename leaves the old path playable.
        for (key, suffix) in next.suffixes ?? [:] {
            storage.localSuffixes.withLock { stored in
                guard let previous = stored[key], previous != suffix else { return }
                do {
                    try FileManager.default.moveItem(at: storage.pinURL(key, suffix: previous),
                                                     to: storage.pinURL(key, suffix: suffix))
                    stored[key] = suffix
                } catch {
                    Logger(subsystem: "me.unto.oneplay.music", category: "Offline").error("Could not rename a cached recording")
                }
            }
        }
        try reconcile()
    }

    /// Recheck source access before scheduling and after every admitted policy change.
    func reconcile() throws {
        guard let storage else { return }
        var wanted = Set<String>(), retained = Set<String>()
        for owner in manifest.owners.values {
            retained.formUnion(owner.retained)
            for (root, keys) in owner.sources where !owner.paused && allowsSource(root) { wanted.formUnion(keys.filter(allowsMediaKey)) }
        }
        for (key, timer) in delayed where !wanted.contains(key) { timer.cancel(); delayed[key] = nil }
        retryCount = retryCount.filter { wanted.contains($0.key) }
        failures = failures.filter { wanted.contains($0.key) }
        renew.formIntersection(wanted)
        eligible = wanted
        for (key, task) in resolving where !wanted.contains(key) { task.cancel(); resolving[key] = nil }
        for (key, task) in running where !wanted.contains(key) { task.cancel(); running[key] = nil }
        let current = tickets.filter { wanted.contains($0.key) }
        if current != tickets { tickets = current; try storage.save(current, "pin-transfers") }
        for (key, size) in leased where retained.contains(key) { sizes[key] = size; leased[key] = nil }
        for (key, size) in sizes where !retained.contains(key) {
            leased[key] = size
            sizes[key] = nil
        }
        missing = wanted.subtracting(sizes.keys)
        releaseUnusedLeases()
        changed()
        pump()
    }

    /// Unowned tracks leave the inventory immediately. Each short main-actor slice
    /// preserves files in use by the player. Their bytes count until unlink succeeds.
    private func unlinkReleasedBatch() -> Bool {
        guard let storage else { return false }
        let deadline = ContinuousClock.now + .milliseconds(4)
        let before = total
        defer { if total != before { changed(); pump() } }
        for (key, size) in leased where !playerHolds(key) {
            do { try storage.unlinkPin(key, suffix: storage.localSuffixes.withLock { $0[key] ?? "" }) }
            catch {
                // Keep the failed file accounted for. The next owner or player change retries it.
                Logger(subsystem: "me.unto.oneplay.music", category: "Offline").error("Could not remove an unowned recording")
                return false
            }
            leased[key] = nil
            storage.localSuffixes.withLock { $0[key] = nil }
            total -= size
            if .now >= deadline { return true }
        }
        return false
    }

    func releaseUnusedLeases() {
        guard cleanup == nil, !leased.isEmpty, unlinkReleasedBatch() else { return }
        let generation = accountGeneration
        cleanup = Task {
            defer { if generation == accountGeneration { cleanup = nil } }
            repeat { await Task.yield() } while !Task.isCancelled && unlinkReleasedBatch()
        }
    }

    func setQuota(_ quota: Int?) throws {
        guard let storage else { throw NativeAccountError.unbound }
        guard let quota, [1,2,5,10].contains(quota) else { throw NativeAccountError.invalidRequest }
        var next = manifest
        next.quota = quota << 30
        try storage.save(next, "pins")
        manifest = next
        changed()
        pump()
    }

    /// A gap or policy change requires a full inventory. Ordinary completions cross WebKit as bounded deltas.
    func snapshot(after: Int?) -> [String: Any] {
        var result: [String: Any] = ["revision": revision, "quota": manifest.quota, "total": total,
                                     "queuedCount": missing.count, "transferAllowed": canTransfer]
        if let after, after <= revision, after == revision || after >= (deltas.first?.revision ?? revision + 1) - 1 {
            result["added"] = Dictionary(uniqueKeysWithValues: deltas.filter { $0.revision > after }.compactMap { d in sizes[d.key].map { (d.key, $0) } })
        } else {
            result["files"] = sizes
            result["unavailable"] = failures
        }
        return result
    }

    private func changed(_ key: String? = nil) {
        revision += 1
        if let key {
            deltas.append((revision, key))
            if deltas.count > 128 { deltas.removeFirst() }
        } else { deltas.removeAll() }
        onChange?()
    }

    func resumePending() {
        for timer in delayed.values { timer.cancel() }
        delayed.removeAll()
        retryCount.removeAll()
        failures.removeAll()
        changed()
        pump()
    }

    /// A single missing or throttled recording cannot occupy a slot while other owners have work.
    private func failed(_ key: String, transient: Bool, message: String, minimumDelay: Int = 0) {
        guard eligible.contains(key) else { return }
        let count = retryCount[key] ?? 0
        if transient {
            // Keep trying while this recording is wanted, backing off to once an hour.
            retryCount[key] = min(count + 1, 6)
            let seconds = max(minimumDelay, min(3600, 1 << (count * 2)))
            if count > 0 { failures[key] = message + " Retrying automatically." }
            delayed[key] = Task {
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                delayed[key] = nil
                failures[key] = nil
                changed()
                pump()
            }
        } else { failures[key] = message }
        changed()
        pump()
    }

    private func pump() {
        guard attached, storage != nil, canTransfer, total <= manifest.quota else { return }
        for key in missing where resolving[key] == nil && running[key] == nil && failures[key] == nil && delayed[key] == nil {
            if resolving.count + running.count >= 2 { break }
            startLookup(key, retry: renew.contains(key))
        }
    }

    private func startLookup(_ key: String, retry: Bool) {
        let binding = manifest.binding
        resolving[key] = Task {
            do {
                let parts = key.split(separator: ":", maxSplits: 1)
                guard parts.count == 2, let lookup else { throw NativeAccountError.invalidRequest }
                let media = try await lookup(String(parts[0]), String(parts[1]), retry ? .fresh : .reuse())
                try Task.checkCancellation()
                guard manifest.binding == binding, eligible.contains(key), storage != nil else { return }
                guard canTransfer else { resolving[key] = nil; return }
                let ticket = Ticket(binding: binding, key: key, size: media.size, version: media.etag, retry: retry)
                let description = String(decoding: try JSONEncoder().encode(ticket), as: UTF8.self)
                let task = session.downloadTask(with: media.url)
                task.taskDescription = description
                var admitted = tickets
                admitted[key] = task.taskIdentifier
                do { try storage?.save(admitted, "pin-transfers") }
                catch {
                    task.cancel()
                    resolving[key] = nil
                    failedToSave(key, error: error)
                    return
                }
                tickets = admitted
                renew.remove(key)
                running[key] = task
                resolving[key] = nil
                task.resume()
            } catch {
                guard !Task.isCancelled, manifest.binding == binding else { return }
                resolving[key] = nil
                let cause = NativeAccountError.classify(error)
                let message: String
                switch cause {
                case .transient: message = publicMedia ? "Couldn’t reach the demo recording." : "Couldn’t reach OneDrive for this recording."
                case .forbidden, .missingRecording: message = publicMedia ? "This demo recording is unavailable." : "This recording is unavailable to this account on OneDrive."
                case .interactionRequired: message = "Sign in to OneDrive to download this recording."
                default: message = publicMedia ? "Couldn’t open the demo recording." : "OneDrive didn’t provide download details for this recording."
                }
                failed(key, transient: cause == .transient, message: message)
            }
        }
    }

    private func ticket(for task: URLSessionTask) -> Ticket? {
        guard storage != nil, let text = task.taskDescription,
              let ticket = try? JSONDecoder().decode(Ticket.self, from: Data(text.utf8)),
              ticket.binding == manifest.binding, tickets[ticket.key] == task.taskIdentifier else { return nil }
        return ticket
    }

    func urlSession(_ session: URLSession, downloadTask task: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let ticket = ticket(for: task), let storage, eligible.contains(ticket.key), sizes[ticket.key] == nil else { return }
        let http = task.response as? HTTPURLResponse
        if let status = http?.statusCode, status != 200 {
            if status == 206 {
                renew.insert(ticket.key)
                failed(ticket.key, transient: true, message: "The server sent only part of the recording.")
            } else if !publicMedia, [401,403,404].contains(status), !ticket.retry { renew.insert(ticket.key) }
            else {
                failed(ticket.key, transient: publicMedia ? status != 404 && status != 410 : status == 408 || status == 429 || status >= 500,
                       message: "Download returned HTTP " + String(status) + ".",
                       minimumDelay: min(3600, Int(http?.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 0))
            }
            return
        }
        guard http?.statusCode == 200, http?.url.map(GraphTransport.isHTTPS) == true else {
            failed(ticket.key, transient: false, message: "The download did not return a secure HTTP response.")
            return
        }
        do {
            guard let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
                throw CocoaError(.fileReadUnknown)
            }
            guard size == ticket.size else {
                // A short transfer or a changed recording needs current Graph metadata and a new URL.
                renew.insert(ticket.key)
                failed(ticket.key, transient: true, message: publicMedia ? "The demo download returned a different size." : "The downloaded size differs from OneDrive’s.")
                return
            }
            try PinReceipt(size: size, version: ticket.version).write(to: location)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: location.path)
            // A pre-upgrade transfer has no indexed suffix until the page reattaches.
            let suffix = manifest.suffixes?[ticket.key] ?? ""
            try FileManager.default.moveItem(at: location, to: storage.pinURL(ticket.key, suffix: suffix))
            storage.localSuffixes.withLock { $0[ticket.key] = suffix }
            sizes[ticket.key] = size
            total += size
            missing.remove(ticket.key)
            retryCount[ticket.key] = nil
            changed(ticket.key)
        } catch { failedToSave(ticket.key, error: error) }
    }

    private func failedToSave(_ key: String, error: Error) {
        let full = (error as? CocoaError)?.code == .fileWriteOutOfSpace || (error as? POSIXError)?.code == .ENOSPC
        failed(key, transient: !full, message: full
            ? "There isn’t enough free space on this device." : "Couldn’t save the recording on this device.")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let ticket = ticket(for: task), eligible.contains(ticket.key) else { return }
        running[ticket.key] = nil
        tickets[ticket.key] = nil
        // Once the daemon has completed this ID it cannot deliver another body. The next admission
        // overwrites this tiny journal even if a cleanup write fails under disk pressure.
        try? storage?.save(tickets, "pin-transfers")
        if let error, missing.contains(ticket.key), delayed[ticket.key] == nil, failures[ticket.key] == nil {
            if task.countOfBytesReceived > 0 && task.countOfBytesReceived < ticket.size { renew.insert(ticket.key) }
            if let urlError = error as? URLError, [.cannotCreateFile, .cannotOpenFile, .cannotWriteToFile, .cannotMoveFile].contains(urlError.code) {
                failedToSave(ticket.key, error: (error as NSError).userInfo[NSUnderlyingErrorKey] as? Error ?? error)
            } else { failed(ticket.key, transient: true, message: "The download was interrupted.") }
        }
        pump()
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        onFinishEvents?()
    }
}
