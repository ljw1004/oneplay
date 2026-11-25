import Foundation
import MSAL
import Network
import UIKit
import OSLog

/// The only errors that may cross the page boundary. Underlying SDK and HTTP errors can contain signed URLs.
enum NativeAccountError: String, LocalizedError {
    case interactionRequired, cancelled, wrongAccount, unbound, invalidRequest, unavailable, cleanupPending, forbidden, transient
    var errorDescription: String? { rawValue }

    static func classify(_ error: Error) -> Self {
        if let known = error as? Self { return known }
        let ns = error as NSError
        if error is CancellationError || (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled) { return .cancelled }
        if let url = error as? URLError, [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                                           .dnsLookupFailed, .notConnectedToInternet, .dataNotAllowed].contains(url.code) { return .transient }
        if ns.domain == MSALErrorDomain {
            if let status = ns.userInfo[MSALHTTPResponseCodeKey] as? NSNumber,
               [408, 429].contains(status.intValue) || (500..<600).contains(status.intValue) { return .transient }
            if let cause = ns.userInfo[NSUnderlyingErrorKey] as? NSError, cause.domain == NSURLErrorDomain,
               classify(cause) == .transient { return .transient }
            switch ns.code {
            case MSALError.interactionRequired.rawValue: return .interactionRequired
            case MSALError.userCanceled.rawValue: return .cancelled
            default: break
            }
        }
        return .unavailable
    }
}

/// Persist the two identities together. A pending record forbids access to every account store until deletion finishes.
struct AccountRecord: Codable, Equatable {
    let homeID: String
    let driveID: String
    var cleanupPending: Bool
    var firstSignIn: Date? = nil
    var cleanupTheme: String? = nil

    func save(to file: URL) throws {
        try JSONEncoder().encode(self).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// A replacement identifies the Graph grant that the CDN rejected, including after an HTTP redirect.
enum MediaLookup: Sendable {
    case reuse(MediaLocation? = nil), replace(MediaLocation), force
}

@MainActor final class NativeAccount {
    private let identity: NativeIdentity
    let diagnostics: NativeDiagnostics
    // Only the most recent signed resources are retained, exclusively in this account's memory.
    private var mediaLocations = [(drive: String, item: String, media: MediaLocation)]()
    private var previousExpiry: Date?
    private let recordFile: URL
    private var record: AccountRecord?
    var cleanupPending: Bool { record?.cleanupPending == true }
    var cleanupTheme: String? { cleanupPending ? record?.cleanupTheme : nil }
    private var generation = 0
    private enum DriveProof: Equatable { case unchecked, verified(token: String), mismatch }
    private var driveProof = DriveProof.unchecked
    private var proofGeneration = 0
    typealias DownloadFile = (URLRequest) async throws -> (HTTPURLResponse, FileHandle)
    private let downloadFile: DownloadFile
    private let path: NWPathMonitor?
    private var routeInterfaces: Set<NWInterface.InterfaceType>?
    private var offline = false
    private var evidence = "no-evidence"
    var onNetworkPathChange: (() -> Void)?
    #if DEBUG
    private(set) var mediaRequests = [UUID: IndexedTrack]()
    var onMediaRequestChange: (() -> Void)?
    #endif
    var onEvidenceChange: ((String) -> Void)?

    private var signInTask: Task<[String: Any], Error>?
    private var silentTask: Task<Void, Never>?
    private var tokenWaiters: [UUID: CheckedContinuation<(IdentityGrant, Bool), Error>] = [:]
    private var requests: [UUID: Task<[String: Any], Error>] = [:]
    private var chunks: [UUID: (file: FileHandle, remaining: UInt64)] = [:]
    private var follows: [String: Date] = [:]

    /// Network.framework provides the current path safely to the media worker on each cache miss.
    var unmeteredWiFi: @Sendable () -> Bool {
        { [path] in
            guard let route = path?.currentPath else { return false }
            return route.status == .satisfied && route.usesInterfaceType(.wifi) && !route.isExpensive && !route.isConstrained
        }
    }

    var snapshot: [String: Any] {
        ["driveID": (cleanupPending ? nil : record?.driveID) as Any? ?? NSNull(), "evidence": evidence]
    }

    convenience init() throws {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: true)
        try self.init(recordFile: directory.appendingPathComponent("OnePlayAccount.json"),
                      identity: EntraIdentity(), path: NWPathMonitor(), downloadFile: GraphTransport().download)
    }

    init(recordFile: URL, identity: NativeIdentity, path: NWPathMonitor? = nil, downloadFile: @escaping DownloadFile) throws {
        self.path = path
        diagnostics = NativeDiagnostics(file: recordFile.deletingLastPathComponent().appendingPathComponent("NativeDiagnostics.json"))
        self.recordFile = recordFile
        self.identity = identity
        self.downloadFile = downloadFile
        do { record = try JSONDecoder().decode(AccountRecord.self, from: Data(contentsOf: recordFile)) }
        catch CocoaError.fileReadNoSuchFile { record = nil }
        if let record, record.homeID.isEmpty || record.driveID.isEmpty { throw NativeAccountError.unavailable }
        path?.pathUpdateHandler = { [weak self] path in
            let down = path.status == .unsatisfied
            let interfaces = Set(path.availableInterfaces.map(\.type).filter(path.usesInterfaceType))
            Task { @MainActor in
                self?.updateNetworkPath(offline: down, interfaces: interfaces)
                self?.onNetworkPathChange?()
            }
        }
        path?.start(queue: DispatchQueue(label: "me.unto.oneplay.music.network-path"))
    }

    deinit { path?.cancel() }

    /// iOS can report the same cellular route again while a Graph request is in flight.
    /// Only losing connectivity or changing the active transport invalidates its drive proof.
    func updateNetworkPath(offline down: Bool, interfaces: Set<NWInterface.InterfaceType>) {
        let changedRoute = routeInterfaces.map { $0 != interfaces } ?? false
        routeInterfaces = interfaces
        guard down != offline || changedRoute else { return }
        offline = down
        invalidateDriveProof(driveProof == .mismatch ? .mismatch : .unchecked)
        setEvidence(down ? "evidence:not-online" : driveProof == .mismatch ? "evidence:signed-out" : "no-evidence")
    }

    /// Follows and spools belong to this page's confirmed account. Invalidation releases their capabilities
    /// synchronously; an in-flight operation must also check its generation before handing bytes to WebKit.
    private func invalidateDriveProof(_ next: DriveProof) {
        proofGeneration += 1
        driveProof = next
        if next == .mismatch { mediaLocations.removeAll() }
        follows.removeAll()
        chunks.removeAll()
    }

    private func checkProof(_ expected: Int) throws {
        guard driveProof != .mismatch else { throw NativeAccountError.wrongAccount }
        guard expected == proofGeneration else { throw NativeAccountError.transient }
    }

    private func setEvidence(_ value: String) {
        guard evidence != value else { return }
        evidence = value
        onEvidenceChange?(value)
    }

    /// Check both guards after every asynchronous admission decision and before exposing a result.
    private func checkAdmission(_ epoch: Int) throws {
        try Task.checkCancellation()
        guard !cleanupPending, generation == epoch else { throw NativeAccountError.cancelled }
    }

    /// One SDK call can serve several library and player requests. Each waiter can leave immediately.
    /// The callback itself may still write Keychain, so sign-out separately waits for silentTask.
    private func acquireSilent(home: String, force: Bool) async throws -> IdentityGrant {
        let epoch = generation
        try checkAdmission(epoch)
        let id = UUID()
        let (grant, wasForced): (IdentityGrant, Bool) = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiter in
                if Task.isCancelled { waiter.resume(throwing: CancellationError()); return }
                tokenWaiters[id] = waiter
                guard silentTask == nil else { return }
                silentTask = Task {
                    let outcome: Result<(IdentityGrant, Bool), Error>
                    let available = UIApplication.shared.isProtectedDataAvailable
                    let mode = force ? "forced" : "ordinary"
                    if force { diagnostics.record("MSAL silent forced start protectedData=\(available)") }
                    do {
                        let begin = ProcessInfo.processInfo.systemUptime
                        let grant = try await identity.acquireSilent(home: home, force: force)
                        Logger(subsystem: "me.unto.oneplay.music", category: "Playback").info("MSAL acquireSilent forced=\(force) durationMs=\(Int((ProcessInfo.processInfo.systemUptime-begin)*1000))")
                        // A later expiry distinguishes an ordinary renewal from a cache hit in this process.
                        let advanced = previousExpiry.flatMap { old in grant.expiresOn.map { $0 > old } } ?? false
                        if force || advanced || previousExpiry == nil {
                            diagnostics.record("MSAL silent \(mode) ok expiryAdvanced=\(advanced) expiresInSeconds=\(grant.expiresOn.map { String(Int($0.timeIntervalSinceNow)) } ?? "unknown") protectedData=\(available)->\(UIApplication.shared.isProtectedDataAvailable)")
                        }
                        previousExpiry = grant.expiresOn
                        outcome = .success((grant, force))
                    } catch {
                        diagnostics.record("MSAL silent \(mode) failed protectedData=\(available)->\(UIApplication.shared.isProtectedDataAvailable) \(Self.diagnosticError(error))")
                        outcome = .failure(error)
                    }
                    let subscribers = tokenWaiters.values
                    tokenWaiters.removeAll()
                    silentTask = nil
                    for subscriber in subscribers { subscriber.resume(with: outcome) }
                }
            }
        } onCancel: {
            Task { @MainActor in self.tokenWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError()) }
        }
        try checkAdmission(epoch)
        return force && !wasForced ? try await acquireSilent(home: home, force: true) : grant
    }

    /// Bind a drive using a fresh direct Graph response. No library write is admitted on the strength of a cached token alone.
    private func readDriveID(token: String, wifiOnly: Bool = false) async throws -> String {
        var request = URLRequest(url: URL(string: "https://graph.microsoft.com/v1.0/me/drive?$select=id")!,
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        if wifiOnly { request.requireUnmeteredWiFi() }
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (response, file) = try await download(request, timeoutMs: 30_000)
        let status = response.statusCode
        guard response.url.map(GraphTransport.isGraph) == true else { throw NativeAccountError.unavailable }
        if status == 401 { throw NativeAccountError.interactionRequired }
        if status == 408 || status == 429 || status >= 500 { throw NativeAccountError.transient }
        guard status == 200, let data = try file.readToEnd(),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String, !id.isEmpty else { throw NativeAccountError.unavailable }
        return id
    }

    /// SDK messages may contain credentials. Retain only numeric error codes and a bounded classification.
    private static func diagnosticError(_ error: Error) -> String {
        let ns = error as NSError
        let source = ns.domain == MSALErrorDomain ? "MSAL" : ns.domain == NSURLErrorDomain ? "network" : "native"
        let detail = (ns.userInfo[MSALInternalErrorCodeKey] as? NSNumber)?.stringValue ?? "-"
        let status = (ns.userInfo[MSALHTTPResponseCodeKey] as? NSNumber)?.stringValue ?? "-"
        let cause = (ns.userInfo[NSUnderlyingErrorKey] as? NSError)?.code
        return "result=\(NativeAccountError.classify(error).rawValue) source=\(source) code=\(ns.code) internal=\(detail) http=\(status) underlying=\(cause.map(String.init) ?? "-")"
    }

    /// A grant and its drive proof belong to the same account and path generation. Validate both after every callback.
    private func acquireVerifiedGrant(force: Bool, rejectedAuthorization: String? = nil, wifiOnly: Bool = false) async throws -> IdentityGrant {
        guard let record, !cleanupPending else { throw NativeAccountError.unbound }
        let epoch = generation
        let proof = proofGeneration
        try checkProof(proof)
        var grant = try await acquireSilent(home: record.homeID, force: force)
        if "Bearer " + grant.accessToken == rejectedAuthorization {
            // Another request may already have forced a replacement for this rejected bearer.
            grant = try await acquireSilent(home: record.homeID, force: true)
        }
        try checkProof(proof)
        guard grant.homeID == record.homeID else { throw NativeAccountError.wrongAccount }
        if driveProof != .verified(token: grant.accessToken) {
            let drive: String
            do { drive = try await readDriveID(token: grant.accessToken, wifiOnly: wifiOnly) }
            catch NativeAccountError.interactionRequired {
                diagnostics.record("Graph drive verification HTTP 401; forcing renewal")
                grant = try await acquireSilent(home: record.homeID, force: true)
                try checkProof(proof)
                guard grant.homeID == record.homeID else { throw NativeAccountError.wrongAccount }
                drive = try await readDriveID(token: grant.accessToken, wifiOnly: wifiOnly)
            }
            try checkAdmission(epoch)
            try checkProof(proof)
            try checkDriveMatch(drive)
            driveProof = .verified(token: grant.accessToken)
        }
        return grant
    }

    /// A contradiction fences queued writes and later responses until explicit reconnect.
    private func checkDriveMatch(_ id: String) throws {
        guard id == record?.driveID else {
            invalidateDriveProof(.mismatch)
            setEvidence("evidence:signed-out")
            throw NativeAccountError.wrongAccount
        }
    }

    /// The interactive sheet is reachable only from an explicit sign-in. A cached pairing tries silent acquisition first.
    func signIn(presenting presenter: UIViewController) async throws -> [String: Any] {
        guard !cleanupPending else { throw NativeAccountError.cleanupPending }
        if let signInTask { return try await signInTask.value }
        let expected = record
        let epoch = generation
        var stage = "resume"
        let task = Task { @MainActor in
            if expected != nil {
                invalidateDriveProof(.unchecked)
                let proof = proofGeneration
                do {
                    _ = try await acquireVerifiedGrant(force: false)
                    try checkProof(proof)
                    setEvidence("evidence:signed-in")
                    return snapshot
                } catch where NativeAccountError.classify(error) == .interactionRequired { }
            }
            try checkAdmission(epoch)
            stage = "microsoft"
            diagnostics.record("MSAL interactive start")
            let result = try await identity.acquireInteractive(home: expected?.homeID, presenting: presenter)
            try checkAdmission(epoch)
            guard expected == nil || expected?.homeID == result.homeID else { throw NativeAccountError.wrongAccount }
            let proof = proofGeneration
            stage = "drive"
            let drive = try await readDriveID(token: result.accessToken)
            stage = "verify-current-route"
            try checkAdmission(epoch)
            guard proof == proofGeneration else { throw NativeAccountError.transient }
            if expected != nil { try checkDriveMatch(drive) }
            let binding = AccountRecord(homeID: result.homeID, driveID: drive, cleanupPending: false,
                                        firstSignIn: expected?.firstSignIn ?? Date())
            stage = "save"
            try binding.save(to: recordFile)
            previousExpiry = result.expiresOn
            diagnostics.record("Sign-in paired successfully")
            record = binding
            driveProof = .verified(token: result.accessToken)
            setEvidence("evidence:signed-in")
            return snapshot
        }
        signInTask = task
        defer { signInTask = nil }
        do { return try await task.value }
        catch {
            let outcome = NativeAccountError.classify(error)
            if epoch == generation { diagnostics.record("Sign-in failed stage=\(stage) \(Self.diagnosticError(error))") }
            throw outcome
        }
    }

    /// Commit the marker before the first await. A failed write also keeps the running session closed.
    func beginSignOut(theme: String? = nil) throws {
        guard var binding = record else { throw NativeAccountError.unbound }
        generation += 1
        mediaLocations.removeAll()
        driveProof = .unchecked
        binding.cleanupPending = true
        if let theme, ["light", "dark", "auto"].contains(theme) { binding.cleanupTheme = theme }
        record = binding
        defer {
            detachView()
            setEvidence("evidence:signed-out")
        }
        try binding.save(to: recordFile)
    }

    /// Repeatable after a kill at any instruction. Drop the marker last, only after every private store was cleared.
    func finishCleanup(clearExternalState: () async throws -> Void) async throws {
        guard cleanupPending else { return }
        // Drain cancelled URLSession requests and their spool parsing before clearing the document's store.
        for request in Array(requests.values) { _ = await request.result }
        try await clearExternalState()
        _ = await signInTask?.result
        await silentTask?.value
        try identity.removePrivateAccounts()
        try diagnostics.clear()
        previousExpiry = nil
        try FileManager.default.removeItem(at: recordFile)
        record = nil
        setEvidence(offline ? "evidence:not-online" : "no-evidence")
    }

    /// Cancel operations of the departing page. Native playback has its own lifetime.
    func detachView() {
        if let signInTask {
            signInTask.cancel()
            identity.cancelInteractive()
        }
        for task in requests.values { task.cancel() }
        chunks.removeAll()
        follows.removeAll()
    }

    func abort(id: String) {
        guard let uuid = UUID(uuidString: id) else { return }
        requests[uuid]?.cancel()
        chunks[uuid] = nil
    }

    /// JS acknowledges each chunk by requesting its successor. The last read releases the unlinked spool.
    func readChunk(id: String) throws -> [String: Any] {
        guard !cleanupPending, let uuid = UUID(uuidString: id), let chunk = chunks[uuid] else { throw NativeAccountError.invalidRequest }
        do {
            let size = Int(min(UInt64(GraphTransport.chunkSize), chunk.remaining))
            let bytes = try chunk.file.read(upToCount: size) ?? Data()
            guard !bytes.isEmpty else { throw NativeAccountError.unavailable }
            let remaining = chunk.remaining - UInt64(bytes.count)
            chunks[uuid] = remaining == 0 ? nil : (chunk.file, remaining)
            return ["body": bytes.base64EncodedString(), "done": remaining == 0]
        } catch { chunks[uuid] = nil; throw error }
    }

    /// Actual responses are evidence. A denied shared item leaves the account signed in.
    private func observe(status: Int, authenticated: Bool, authFailure: Bool = false) {
        if authFailure {
            if driveProof != .mismatch { invalidateDriveProof(.unchecked) }
            setEvidence("evidence:signed-out")
        } else if evidence == "evidence:signed-out" && (!authenticated || status >= 500) {
            // An outstanding content grant or a network fault cannot prove that MSAL recovered.
            return
        } else if status < 500 {
            setEvidence("evidence:signed-in")
        } else {
            setEvidence(offline ? "evidence:not-online" : "no-evidence")
        }
    }

    /// One request policy for JS library work and the locked player. Retrying a 401 always keeps the same home account.
    private func fetchFile(_ request: URLRequest, graph: Bool, retry: Bool, forceRefresh: Bool = false,
                           timeoutMs: Int?, proof: Int, track: IndexedTrack? = nil) async throws -> (HTTPURLResponse, FileHandle) {
        let epoch = generation
        var force = forceRefresh
        var rejectedAuthorization: String?
        while true {
            try checkAdmission(epoch)
            try checkProof(proof)
            var current = request
            if graph {
                let grant = try await acquireVerifiedGrant(force: force, rejectedAuthorization: rejectedAuthorization, wifiOnly: !request.allowsCellularAccess)
                try checkAdmission(epoch)
                try checkProof(proof)
                current.setValue("Bearer " + grant.accessToken, forHTTPHeaderField: "Authorization")
                force = false
            }
            // Mark only the item metadata request. Token acquisition, retries and the audition hold have separate lifetimes.
            let (response, file): (HTTPURLResponse, FileHandle)
            do {
                #if DEBUG
                let id = UUID()
                if let track { mediaRequests[id] = track; onMediaRequestChange?() }
                defer { if track != nil { mediaRequests[id] = nil; onMediaRequestChange?() } }
                #endif
                (response, file) = try await download(current, timeoutMs: timeoutMs)
            }
            try checkAdmission(epoch)
            try checkProof(proof)
            let status = response.statusCode
            let rejected = graph && status == 401 && response.url.map(GraphTransport.isGraph) == true
            if rejectedAuthorization != nil { diagnostics.record("Graph 401 replay HTTP \(status)") }
            if rejected && rejectedAuthorization == nil {
                diagnostics.record("Graph HTTP 401; retrying with verified credentials")
                rejectedAuthorization = current.value(forHTTPHeaderField: "Authorization")
                continue
            }
            if retry && (status == 429 || status == 503) {
                observe(status: status, authenticated: graph && response.url.map(GraphTransport.isGraph) == true)
                try await Task.sleep(for: .seconds(status == 429 ? 2 : 10))
                continue
            }
            return (response, file)
        }
    }

    /// URLSession's native timeout is an inactivity limit. Also enforce the caller's elapsed deadline during streaming.
    private func download(_ request: URLRequest, timeoutMs: Int?) async throws -> (HTTPURLResponse, FileHandle) {
        guard let timeoutMs else { return try await downloadFile(request) }
        return try await withThrowingTaskGroup(of: (HTTPURLResponse, FileHandle).self) { group in
            group.addTask { [downloadFile] in try await downloadFile(request) }
            group.addTask {
                try await Task.sleep(for: .milliseconds(timeoutMs))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    /// Only this view can reuse a live batch Location. Two subrequests may legitimately name the same content.
    func request(message: [String: Any]) async throws -> [String: Any] {
        guard !cleanupPending, record != nil, let rawID = message["id"] as? String, let id = UUID(uuidString: rawID),
              requests[id] == nil, chunks[id] == nil, let rawURL = message["url"] as? String, let url = URL(string: rawURL)
        else { throw NativeAccountError.invalidRequest }
        let follow = message["follow"] as? Bool == true
        guard GraphTransport.isHTTPS(url),
              follow ? (follows[rawURL] ?? .distantPast) > Date() : GraphTransport.isGraph(url)
        else { throw NativeAccountError.invalidRequest }
        let method = (message["method"] as? String ?? "GET").uppercased()
        guard follow ? method == "GET" : ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(method)
        else { throw NativeAccountError.invalidRequest }
        let timeout = message["timeoutMs"] as? Int
        guard timeout.map({ $0 >= 0 }) ?? true else { throw NativeAccountError.invalidRequest }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if !follow {
            if message["cache"] as? String == "no-store" { request.cachePolicy = .reloadIgnoringLocalCacheData }
            let disallowed = ["authorization", "proxy-authorization", "cookie", "host", "content-length", "connection", "transfer-encoding"]
            for (key, value) in message["headers"] as? [String: String] ?? [:] {
                guard !disallowed.contains(key.lowercased()), !key.contains(where: \.isNewline),
                      !value.contains(where: \.isNewline) else { throw NativeAccountError.invalidRequest }
                request.setValue(value, forHTTPHeaderField: key)
            }
            if let body = message["body"] as? String { request.httpBody = Data(body.utf8) }
        }
        let retry = message["retryOn429"] as? Bool == true
        let epoch = generation
        let proof = proofGeneration
        let task = Task { @MainActor () throws -> [String: Any] in
            do {
                let (response, file) = try await fetchFile(request, graph: !follow, retry: retry, timeoutMs: timeout, proof: proof)
                try checkAdmission(epoch)
                try checkProof(proof)
                if !follow, method == "GET", url.path == "/v1.0/me/drive", response.statusCode == 200 {
                    // Shared sync fetches owner + ID after the admission probe. Verify the exact value entering its cache.
                    guard response.url.map(GraphTransport.isGraph) == true, let data = try file.readToEnd(),
                          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let drive = object["id"] as? String else { throw NativeAccountError.unavailable }
                    try checkDriveMatch(drive)
                    try file.seek(toOffset: 0)
                }
                if !follow, url.path == "/v1.0/$batch", method == "POST", response.statusCode == 200,
                   response.url.map(GraphTransport.isGraph) == true {
                    // Decode only the batch envelope, off the main actor. User data inside each body is opaque.
                    let locations = try await Task.detached { try GraphTransport.contentLocations(in: file) }.value
                    try checkAdmission(epoch)
                    try checkProof(proof)
                    let now = Date()
                    follows = follows.filter { $0.value > now }
                    for location in locations { follows[location] = now.addingTimeInterval(120) }
                }
                try checkAdmission(epoch)
                let size = try file.seekToEnd()
                try file.seek(toOffset: 0)
                var headers: [String: String] = [:]
                for (name, value) in response.allHeaderFields {
                    if let name = name as? String, !["set-cookie", "x-oneplay-account-error"].contains(name.lowercased()) {
                        headers[name] = String(describing: value)
                    }
                }
                let authenticated = !follow && response.url.map(GraphTransport.isGraph) == true
                let rejected = authenticated && response.statusCode == 401
                if rejected { headers["X-OnePlay-Account-Error"] = NativeAccountError.interactionRequired.rawValue }
                // URLSession exposes no wire reason phrase. A localized label outside HTTP's byte range would invalidate Response.
                let statusText = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
                var reply: [String: Any] = ["status": response.statusCode,
                    "statusText": statusText.utf8.allSatisfy { $0 < 128 } ? statusText : "", "headers": headers]
                observe(status: response.statusCode, authenticated: authenticated, authFailure: rejected)
                if size <= GraphTransport.chunkSize {
                    reply["body"] = (try file.readToEnd() ?? Data()).base64EncodedString()
                } else {
                    chunks[id] = (file, size)
                    reply["chunked"] = true
                }
                return reply
            } catch {
                try checkAdmission(epoch)
                let kind = NativeAccountError.classify(error)
                if kind == .cancelled { throw kind }
                let auth = kind == .interactionRequired || kind == .wrongAccount || kind == .unbound
                let timedOut = (error as? URLError)?.code == .timedOut
                let status = auth ? 401 : timedOut ? 504 : 503
                // An older request cannot change the evidence established by a newer account challenge.
                if proof == proofGeneration { observe(status: status, authenticated: false, authFailure: auth) }
                return ["status": status, "statusText": auth ? kind.rawValue : timedOut ? "Request timed out" : "Cannot make request",
                        "headers": auth ? ["X-OnePlay-Account-Error": kind.rawValue] : [:], "body": ""]
            }
        }
        requests[id] = task
        defer { requests[id] = nil }
        return try await task.value
    }

    /// Metadata, signed URL and version come from the same live Graph response. The player owns all media bytes.
    func media(driveID: String, itemID: String, lookup: MediaLookup = .reuse(), wifiOnly: Bool = false) async throws -> MediaLocation {
        let epoch = generation
        try checkAdmission(epoch)
        guard driveProof != .mismatch else { throw NativeAccountError.wrongAccount }
        guard record != nil else { throw NativeAccountError.unbound }
        let matches: ((drive: String, item: String, media: MediaLocation)) -> Bool = { $0.drive == driveID && $0.item == itemID }
        let index = mediaLocations.firstIndex(where: matches)
        let known = index.map { mediaLocations[$0].media }
        let forceRefresh: Bool
        switch lookup {
        case .reuse(let admitted):
            // An active reader can outlive the recent list. Even a rejected URL still identifies
            // its retained blocks; its first miss will come back through .replace.
            if let media = known ?? admitted, !media.accessDenied {
                if let index { mediaLocations.append(mediaLocations.remove(at: index)) }
                return media
            }
            forceRefresh = false
        case .replace(let rejected):
            if let known, known !== rejected, !known.isRejected { return known }
            forceRefresh = false
        case .force:
            forceRefresh = true
        }
        // Match the PWA lookup. Mixing ordinary fields into this $select can omit the download URL.
        let component = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard !driveID.isEmpty, !itemID.isEmpty,
              let drive = driveID.addingPercentEncoding(withAllowedCharacters: component),
              let item = itemID.addingPercentEncoding(withAllowedCharacters: component),
              let url = URL(string: "https://graph.microsoft.com/v1.0/drives/\(drive)/items/\(item)?$select=@microsoft.graph.downloadUrl")
        else { throw NativeAccountError.invalidRequest }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        if wifiOnly { request.requireUnmeteredWiFi() }
        let proof = proofGeneration
        do {
            let (response, file) = try await fetchFile(request, graph: true, retry: false, forceRefresh: forceRefresh, timeoutMs: 30_000, proof: proof, track: IndexedTrack(driveId: driveID, itemId: itemID))
            try checkAdmission(epoch)
            try checkProof(proof)
            guard response.url.map(GraphTransport.isGraph) == true else { throw NativeAccountError.unavailable }
            observe(status: response.statusCode, authenticated: true, authFailure: response.statusCode == 401)
            if response.statusCode == 408 || response.statusCode == 429 || response.statusCode >= 500 { throw NativeAccountError.transient }
            if [403, 404, 410].contains(response.statusCode) {
                // A seek or an early successor may still hold this grant after its worker retires.
                if case .replace(let rejected) = lookup { rejected.markAccessDenied() }
                known?.markAccessDenied()
                mediaLocations.first(where: matches)?.media.markAccessDenied()
                mediaLocations.removeAll(where: matches)
                throw NativeAccountError.forbidden
            }
            if response.statusCode == 401 { throw NativeAccountError.interactionRequired }
            guard response.statusCode == 200,
                  let data = try file.readToEnd(),
                  let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  fields["id"] as? String == itemID,
                  let tag = fields["eTag"] as? String, !tag.isEmpty,
                  let size = fields["size"] as? Int64, size > 0,
                  let raw = fields["@microsoft.graph.downloadUrl"] as? String, let location = URL(string: raw),
                  GraphTransport.isHTTPS(location) else { throw NativeAccountError.unavailable }
            let media = MediaLocation(url: location, etag: tag, size: size)
            mediaLocations.removeAll(where: matches)
            if mediaLocations.count >= 16 { mediaLocations.removeFirst() }
            mediaLocations.append((driveID, itemID, media))
            return media
        } catch {
            let kind = NativeAccountError.classify(error)
            if epoch == generation && proof == proofGeneration && kind == .interactionRequired { observe(status: 401, authenticated: false, authFailure: true) }
            throw kind
        }
    }
}
