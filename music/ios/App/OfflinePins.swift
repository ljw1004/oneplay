import Foundation
import AudioToolbox

/// One owner's last complete membership survives a cold launch with only part of the library loaded.
struct PinOwner: Codable, Equatable {
    var sources: [String: Set<String>]
    var retained: Set<String>
    var paused: Bool
}

private struct PinManifest: Codable, Equatable {
    var binding = UUID()
    var fenced = false
    var revision = 0
    var quota = 1 << 30
    var owners = [String: PinOwner]()
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
    // At most two daemon task IDs are durable. A late body from a cancelled task cannot win a re-pin.
    private var tickets = [String: Int]()
    private var missing = Set<String>()
    private var eligible = Set<String>()
    private(set) var sizes = [String: Int]()
    private var leased = [String: Int]()
    var playerHolds: (String) -> Bool = { _ in false }
    private var opening: Task<(PinManifest, [String: Int]), Error>?
    private var accountGeneration = 0
    private var total = 0
    private var failures = [String: String]()
    private var retryCount = [String: Int]()
    private var delayed = [String: Task<Void, Never>]()
    private var renew = Set<String>()
    private var lastError: String? { failures.count == missing.count ? failures.values.first : nil }
    private var attached = false
    private var evidence = "no-evidence"
    private var revision = 0
    private var deltas = [(revision: Int, key: String)]()
    var onChange: (() -> Void)?
    var onFinishEvents: (() -> Void)?
    var allowsSource: (String) -> Bool = { _ in true }
    var lookup: ((String, String, MediaLookup) async throws -> MediaLocation)?
    var completeKeys: Set<String> { Set(sizes.keys) }

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
        let (saved, inventory) = try await task.value
        guard generation == accountGeneration else { throw NativeAccountError.cancelled }
        guard storage == nil else { return }
        storage = store
        manifest = saved
        sizes = inventory
        tickets = try store.read([String: Int].self, "pin-transfers") ?? [:]
        total = sizes.values.reduce(0, +)
        try reconcile()
    }

    nonisolated private static func restore(_ store: PlaybackStore) throws -> (PinManifest, [String: Int]) {
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
        var inventory = [String: Int]()
        for url in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey]) {
            if let key = names[url.lastPathComponent], let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               size > 0, try PinReceipt.read(from: url)?.size == size {
                inventory[key] = size
            } else { try FileManager.default.removeItem(at: url) }
        }
        return (saved, inventory)
    }

    /// Close admission synchronously with the sign-out marker, before WebKit retirement yields.
    func closeAdmission() {
        accountGeneration += 1
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

    func updateEvidence(_ value: String) {
        guard value != evidence else { return }
        evidence = value
        if value == "evidence:signed-in" { resumePending() }
        changed()
    }

    /// The document supplies a complete list of pin owners only after favorite membership has loaded.
    /// A partial projection activates its known subset while retaining previous bytes for unresolved sources.
    func apply(owners rows: [[String: Any]]) throws {
        guard let storage else { throw NativeAccountError.unbound }
        var next = manifest
        next.fenced = false
        next.owners.removeAll()
        for row in rows {
            guard let id = row["id"] as? String, next.owners[id] == nil, let paused = row["paused"] as? Bool,
                  let complete = row["complete"] as? Bool, let groups = row["sources"] as? [String: [String]]
            else { throw NativeAccountError.invalidRequest }
            let sources = groups.mapValues(Set.init)
            var retained = complete ? Set<String>() : manifest.owners[id]?.retained ?? []
            for keys in sources.values { retained.formUnion(keys) }
            next.owners[id] = PinOwner(sources: sources, retained: retained, paused: paused)
        }
        if next != manifest {
            next.revision += 1
            try storage.save(next, "pins")
            manifest = next
            failures.removeAll()
        }
        try reconcile()
    }

    /// Recheck source access before scheduling and after every admitted policy change.
    func reconcile() throws {
        guard let storage else { return }
        var wanted = Set<String>(), retained = Set<String>()
        for owner in manifest.owners.values {
            retained.formUnion(owner.retained)
            for (root, keys) in owner.sources where !manifest.fenced && !owner.paused && allowsSource(root) { wanted.formUnion(keys) }
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
            if playerHolds(key) { leased[key] = size; sizes[key] = nil; continue }
            do { try FileManager.default.removeItem(at: storage.pinURL(key)) }
            catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile { }
            sizes[key] = nil
            total -= size
        }
        missing = wanted.subtracting(sizes.keys)
        releaseUnusedLeases()
        changed()
        pump()
    }

    /// Leased tracks leave the pin inventory immediately. Their bytes count toward quota until
    /// the audible or prepared decoder releases them. Re-pinning can reclaim the same file.
    func releaseUnusedLeases() {
        guard let storage, !leased.isEmpty else { return }
        for (key, size) in leased where !playerHolds(key) {
            do {
                try FileManager.default.removeItem(at: storage.pinURL(key))
            } catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
            } catch { continue }
            leased[key] = nil
            total -= size
            changed()
        }
        pump()
    }

    func control(_ action: String, quota: Int?) throws {
        guard let storage else { throw NativeAccountError.unbound }
        if action == "fence" {
            guard !manifest.fenced else { return }
            var next = manifest
            next.fenced = true
            next.revision += 1
            try storage.save(next, "pins")
            manifest = next
            try reconcile()
            return
        }
        if action == "quota" {
            guard let quota, [1,2,5,10].contains(quota) else { throw NativeAccountError.invalidRequest }
            var next = manifest
            next.quota = quota << 30
            try storage.save(next, "pins")
            manifest = next
        } else if action == "retry" { resumePending() }
        else { throw NativeAccountError.invalidRequest }
        changed()
        pump()
    }

    /// A gap or policy change requires a full inventory. Ordinary completions cross WebKit as bounded deltas.
    func snapshot(after: Int?) -> [String: Any] {
        var result: [String: Any] = ["revision": revision, "quota": manifest.quota, "total": total]
        result["error"] = lastError
        if let after, after <= revision, after == revision || after >= (deltas.first?.revision ?? revision + 1) - 1 {
            result["added"] = Dictionary(uniqueKeysWithValues: deltas.filter { $0.revision > after }.compactMap { d in sizes[d.key].map { (d.key, $0) } })
        } else {
            result["files"] = sizes
            result["missing"] = Array(missing)
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
        if transient && count < 4 {
            retryCount[key] = count + 1
            let seconds = max(minimumDelay, 1 << (count * 2))
            delayed[key] = Task {
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                delayed[key] = nil
                pump()
            }
        } else { failures[key] = message }
        changed()
        pump()
    }

    private func pump() {
        guard attached, storage != nil, evidence == "evidence:signed-in", total <= manifest.quota else { return }
        for key in missing where resolving[key] == nil && running[key] == nil && failures[key] == nil && delayed[key] == nil {
            if resolving.count + running.count >= 2 { break }
            startLookup(key, retry: renew.remove(key) != nil)
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
                guard evidence == "evidence:signed-in" else { resolving[key] = nil; return }
                let ticket = Ticket(binding: binding, key: key, size: media.size, version: media.etag, retry: retry)
                let description = String(decoding: try JSONEncoder().encode(ticket), as: UTF8.self)
                let task = session.downloadTask(with: media.url)
                task.taskDescription = description
                var admitted = tickets
                admitted[key] = task.taskIdentifier
                do { try storage?.save(admitted, "pin-transfers") }
                catch { task.cancel(); throw error }
                tickets = admitted
                running[key] = task
                resolving[key] = nil
                task.resume()
            } catch {
                guard !Task.isCancelled, manifest.binding == binding else { return }
                resolving[key] = nil
                failed(key, transient: NativeAccountError.classify(error) == .transient,
                       message: "Recording unavailable. Tap Resume to retry.")
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
        guard let ticket = ticket(for: task), let storage, eligible.contains(ticket.key), sizes[ticket.key] == nil,
              (!attached || running[ticket.key]?.taskIdentifier == task.taskIdentifier) else { return }
        let http = task.response as? HTTPURLResponse
        if let status = http?.statusCode, status != 200 {
            if [401,403,404].contains(status), !ticket.retry { renew.insert(ticket.key) }
            else {
                failed(ticket.key, transient: status == 408 || status == 429 || status >= 500,
                       message: "Download returned HTTP " + String(status) + ". Tap Resume to retry.",
                       minimumDelay: min(3600, Int(http?.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 0))
            }
            return
        }
        do {
            guard http?.statusCode == 200, http?.url.map(GraphTransport.isHTTPS) == true,
                  let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize, size == ticket.size else {
                throw NativeAccountError.unavailable
            }
            // Reject a successful HTML page, JSON error, or other same-length non-audio body.
            var audio: AudioFileID?
            guard AudioFileOpenURL(location as CFURL, .readPermission, 0, &audio) == noErr, let audio else {
                throw NativeAccountError.unavailable
            }
            AudioFileClose(audio)
            try PinReceipt(size: size, version: ticket.version).write(to: location)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: location.path)
            try FileManager.default.moveItem(at: location, to: storage.pinURL(ticket.key))
            sizes[ticket.key] = size
            total += size
            missing.remove(ticket.key)
            changed(ticket.key)
        } catch { failed(ticket.key, transient: false, message: "Download incomplete or unsupported. Tap Resume to retry.") }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let ticket = ticket(for: task), eligible.contains(ticket.key), !attached || running[ticket.key]?.taskIdentifier == task.taskIdentifier else { return }
        running[ticket.key] = nil
        tickets[ticket.key] = nil
        // Once the daemon has completed this ID it cannot deliver another body. The next admission
        // overwrites this tiny journal even if a cleanup write fails under disk pressure.
        try? storage?.save(tickets, "pin-transfers")
        if error != nil { failed(ticket.key, transient: true, message: "Download interrupted. Tap Resume to retry.") }
        pump()
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        onFinishEvents?()
    }
}
