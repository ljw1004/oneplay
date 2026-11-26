import AVFoundation
import UIKit
import WebKit

/// Owns the one admitted page. Losing WebKit cancels its requests while the
/// playback session can still renew URLs independently of the page.
@MainActor final class LibraryController: UIViewController, WKScriptMessageHandlerWithReply {
    private let shell = BundledShell()
    private let deviceTheme = URL.applicationSupportDirectory.appendingPathComponent("DeviceTheme")
    private let store: WKWebsiteDataStore
    private var account: NativeAccount?
    private(set) var player: NativePlayback?
    private var systemPlayback: SystemPlayback?
    let pins: OfflinePins
    private var pinRevision = -1
    private var pinParts: (revision: Int, data: Data)?
    private var inventoryParts: (revision: Int, data: Data)?
    private var playbackSequence = 0
    private var subscription = UUID().uuidString
    /// Only one document can stage a queue. Every append checks its build ID and offset.
    private var selectionIntent: String?
    private var staged: (id: String, count: Int, tracks: [IndexedTrack])?
    private var showingAudioRanges = false
    /// Both library themes draw a blue header beneath the system status icons.
    override var preferredStatusBarStyle: UIStatusBarStyle { webView == nil ? .default : .lightContent }

    private(set) var webView: WKWebView? {
        didSet { setNeedsStatusBarAppearanceUpdate() }
    }

    init(account: NativeAccount? = nil, store: WKWebsiteDataStore? = nil, player: NativePlayback? = nil, pinConfiguration: URLSessionConfiguration? = nil) {
        self.pins = OfflinePins(configuration: pinConfiguration ?? (account == nil ? .background(withIdentifier: OfflinePins.identifier) : .ephemeral))
        self.player = player
        self.account = account
        self.store = store ?? WKWebsiteDataStore(forIdentifier: UUID(uuidString: "83178CEF-278A-4625-9E7C-C7526D5AF452")!)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("The library is created programmatically") }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        player?.releaseCachedAudio()
    }

    private var starting = false
    private var servicesReady = false
    private var startupFailed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        shell.onReplacePage = { [weak self] in self?.retirePageAndReload() }
        if servicesReady { loadPage() }
        else if startupFailed { showUnavailable() }
        else { startServices() }
    }

    /// A daemon wake can arrive without a scene. Restore the account and its effective source
    /// policy before adopting transfers. A later scene attaches to the same running services.
    func startServices() {
        guard !starting else { return }
        starting = true
        Task { [self] in
            do {
                let account = try self.account ?? NativeAccount()
                self.account = account
                player = player ?? NativePlayback(diagnostics: account.diagnostics, pool: MediaPool(unmeteredWiFi: account.unmeteredWiFi)) { drive, item, request, wifiOnly in
                    try await account.media(driveID: drive, itemID: item, lookup: request, wifiOnly: wifiOnly)
                }
                player?.onChange = { [weak self] debugOnly in self?.signalPlayerChange(debugOnly: debugOnly) }
                account.onMediaRequestChange = { [weak self] in self?.signalPlayerChange(debugOnly: true) }
                account.diagnostics.onPending = { [weak self] in self?.signalPendingDiagnostics() }
                account.onNetworkPathChange = { [weak self] in self?.player?.cancelWiFiReadsIfMetered() }
                pins.lookup = { drive, item, lookup in try await account.media(driveID: drive, itemID: item, lookup: lookup) }
                pins.playerHolds = { [weak self] key in self?.player?.holdsPin(key) == true }
                pins.allowsSource = { [weak self] root in self?.player?.allowsPinSource(root) == true }
                pins.onChange = { [weak self] in
                    guard let self else { return }
                    let limited = ["evidence:not-online", "evidence:signed-out"].contains(account.snapshot["evidence"] as? String ?? "")
                    if player?.setOfflineAvailability(limited ? pins.completeKeys : nil) == true { systemPlayback?.publishNowPlaying() }
                    if UIApplication.shared.applicationState == .active {
                        webView?.evaluateJavaScript("window.dispatchEvent(new Event('oneplay-pins'))", completionHandler: nil)
                    }
                }
                account.onEvidenceChange = { [weak self] evidence in
                    self?.pins.updateEvidence(evidence)
                    self?.webView?.callAsyncJavaScript(
                        "window.dispatchEvent(new CustomEvent('oneplay-evidence', {detail:evidence}))",
                        arguments: ["evidence": evidence], in: nil, in: .page, completionHandler: nil)
                }
                if account.cleanupPending {
                    try await finishCleanup(account)
                }
                if let storage = try account.openPlaybackStore(), let player {
                    try await Task.detached { try player.restoreIfNeeded(from: storage) }.value
                    try await pins.bind(storage)
                }
                pins.updateEvidence(account.snapshot["evidence"] as? String ?? "no-evidence")
                await pins.connectSession()
                if let player {
                    systemPlayback = SystemPlayback(player: player) { [weak self] in self?.signalPlayerChange(debugOnly: false) }
                    systemPlayback?.publishNowPlaying()
                }
                servicesReady = true
                if isViewLoaded { loadPage() }
            } catch {
                // Drain outstanding daemon events even when private storage cannot be opened.
                pins.closeAdmission()
                await pins.connectSession()
                startupFailed = true
                if isViewLoaded { showUnavailable() }
            }
        }
    }

    /// Best effort. JS also pulls on startup, so a suspended or replaced page can miss this signal.
    func signalPendingDiagnostics() {
        guard let page = webView, page.url == BundledShell.page else { return }
        page.evaluateJavaScript("window.dispatchEvent(new Event('oneplay-diagnostics'))", completionHandler: nil)
    }

    private func signalPlayerChange(debugOnly: Bool) {
        if !debugOnly {
            player?.handleOutputChange(.parkPaused)
            systemPlayback?.publishNowPlaying()
            pins.releaseUnusedLeases()
        }
        guard let page = webView, page.url == BundledShell.page, UIApplication.shared.applicationState == .active else { return }
        if debugOnly && !showingAudioRanges { return }
        guard let player, let account, account.snapshot["driveID"] is String else { return }
        page.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('oneplay-playback', {detail:sample}))",
                                 arguments: ["sample": playbackSample(player, account)], in: nil, in: .page, completionHandler: nil)
    }

    /// Replies and pushed transitions share one sequence so a delayed command reply cannot rewind the drawer.
    private func playbackSample(_ player: NativePlayback, _ account: NativeAccount, includeDenied: Bool = false) -> [String: Any] {
        let lookups = showingAudioRanges ? Array(account.mediaRequests.values) : nil
        playbackSequence += 1
        var snapshot = player.snapshot(lookups: lookups, pinSizes: lookups == nil ? [:] : pins.sizes, includeDenied: includeDenied)
        let denied = snapshot.removeValue(forKey: "denied")
        var reply: [String: Any] = ["sequence": playbackSequence, "subscription": subscription, "snapshot": snapshot]
        reply["denied"] = denied
        return reply
    }

    private func showUnavailable() {
        let message = UILabel()
        message.text = "OnePlay could not open the account store. Close the app and try again."
        message.numberOfLines = 0
        message.textAlignment = .center
        message.frame = view.safeAreaLayoutGuide.layoutFrame
        message.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(message)
    }

    private func clearLibraryStore() async {
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    private func finishCleanup(_ account: NativeAccount) async throws {
        try await account.finishCleanup {
            // The sign-out marker owns the theme until its independent device file is durable.
            if let theme = account.cleanupTheme {
                try Data(theme.utf8).write(to: self.deviceTheme, options: .atomic)
            }
            await self.pins.unbindAndCancel()
            try await self.player?.stopAndDrain()
            await self.clearLibraryStore()
        }
    }

    func loadPage() {
        guard webView == nil, let account, !account.cleanupPending else { return }
        pinRevision = -1
        subscription = UUID().uuidString
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.setURLSchemeHandler(shell, forURLScheme: "oneplay")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "oneplay")
        // On a clean store the next account inherits only the device's chosen theme.
        if let theme = try? String(contentsOf: deviceTheme, encoding: .utf8), ["light", "dark", "auto"].contains(theme) {
            let script = "if (!localStorage.getItem('oneplay_music_theme')) localStorage.setItem('oneplay_music_theme','\(theme)')"
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart,
                                                                            forMainFrameOnly: true))
        }
        let page = WKWebView(frame: view.bounds, configuration: configuration)
        page.autoresizingMask = [.flexibleHeight, .flexibleWidth]
        page.scrollView.contentInsetAdjustmentBehavior = .never
        page.navigationDelegate = shell
        webView = page
        view.addSubview(page)
        page.load(URLRequest(url: BundledShell.page))
    }

    /// Close bridge admission synchronously, then retire the old document before clearing or reopening its store.
    private func retirePageAndReload() {
        guard let page = webView else { return }
        detachPage()
        Task {
            do {
                try await shell.retireDocument(in: page)
                if let account, account.cleanupPending { try await finishCleanup(account) }
                loadPage()
            } catch { showUnavailable() }
        }
    }

    /// Bridge data is untrusted even when the sender is the bundled web document.
    private func decodeEntries(_ values: [[String: Any]]) throws -> [IndexedTrack] {
        let tracks = try JSONDecoder().decode([IndexedTrack].self, from: JSONSerialization.data(withJSONObject: values))
        guard tracks.allSatisfy({ ($0.path?.count ?? 0) >= 3 && !($0.key ?? "").isEmpty &&
            !($0.sourceRootKey ?? "").isEmpty && !$0.driveId.isEmpty && !$0.itemId.isEmpty }) else { throw NativeAccountError.invalidRequest }
        return tracks
    }

    func detachPage() {
        staged = nil
        pinParts = nil
        inventoryParts = nil
        selectionIntent = nil
        showingAudioRanges = false
        // beginSignOut already cancelled page-owned work when it committed the marker.
        if let account, !account.cleanupPending { account.detachView() }
        webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeAllUserScripts()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "oneplay", contentWorld: .page)
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
    }

    private func handlePins(_ args: [String: Any], account: NativeAccount) throws -> Any {
        guard account.snapshot["driveID"] is String, let action = args["action"] as? String else { throw NativeAccountError.unbound }
        switch action {
        case "snapshot":
            let reply = pins.snapshot(after: args["after"] as? Int)
            guard let files = reply["files"] as? [String: Int], let missing = reply["missing"] as? [String],
                  files.count + missing.count > 512, let revision = reply["revision"] as? Int else { return reply }
            let data = try JSONSerialization.data(withJSONObject: reply)
            inventoryParts = (revision, data)
            return ["revision": revision, "parts": (data.count + GraphTransport.chunkSize - 1) / GraphTransport.chunkSize]
        case "inventoryPart":
            guard let batch = inventoryParts, args["revision"] as? Int == batch.revision,
                  let i = args["index"] as? Int, i >= 0, i <= (batch.data.count - 1) / GraphTransport.chunkSize
            else { throw NativeAccountError.invalidRequest }
            let lo = i * GraphTransport.chunkSize, hi = min(lo + GraphTransport.chunkSize, batch.data.count)
            if hi == batch.data.count { inventoryParts = nil }
            return batch.data[lo..<hi].base64EncodedString()
        case "ownerPart":
            guard let revision = args["revision"] as? Int, revision > pinRevision,
                  let text = args["text"] as? String, text.utf8.count <= GraphTransport.chunkSize
            else { throw NativeAccountError.invalidRequest }
            if args["first"] as? Bool == true, revision >= (pinParts?.revision ?? -1) { pinParts = (revision, Data()) }
            guard pinParts?.revision == revision else { throw NativeAccountError.cancelled }
            pinParts!.data.append(contentsOf: text.utf8)
            if args["last"] as? Bool == true {
                defer { pinParts = nil }
                guard let owners = try JSONSerialization.jsonObject(with: pinParts!.data) as? [[String: Any]] else { throw NativeAccountError.invalidRequest }
                try pins.apply(owners: owners)
                pinRevision = revision
            }
        case "owners", "fence":
            guard let revision = args["revision"] as? Int else { throw NativeAccountError.invalidRequest }
            if revision > pinRevision {
                if action == "fence" { try pins.control(action, quota: nil) }
                else if let rows = args["owners"] as? [[String: Any]] { try pins.apply(owners: rows) }
                else { throw NativeAccountError.invalidRequest }
                pinRevision = revision
            }
        default: try pins.control(action, quota: args["quota"] as? Int)
        }
        return true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let frame = message.frameInfo
        guard let account, !account.cleanupPending, let page = webView, message.webView === page,
              page.url == BundledShell.page, frame.isMainFrame, frame.request.url == BundledShell.page,
              frame.securityOrigin.protocol == "oneplay", frame.securityOrigin.host == "app",
              frame.securityOrigin.port == 0, let args = message.body as? [String: Any], let op = args["op"] as? String
        else { replyHandler(nil, "untrustedPage"); return }

        // Close admission in this delegate turn, before any queued operation can start.
        if op == "signOut" {
            do {
                pins.closeAdmission()
                try account.beginSignOut(theme: args["theme"] as? String)
                player?.stop()
                systemPlayback?.publishNowPlaying()
                replyHandler(true, nil)
                retirePageAndReload()
            } catch {
                replyHandler(nil, "cleanupFailed")
                if account.cleanupPending {
                    player?.stop()
                    systemPlayback?.publishNowPlaying()
                    detachPage()
                    showUnavailable()
                }
            }
            return
        }

        Task<Void, Never> {
            guard page === webView, !account.cleanupPending else { replyHandler(nil, "detached"); return }
            do {
                let reply: Any
                switch op {
                case "state", "signIn":
                    var state = op == "state" ? account.snapshot : try await account.signIn(presenting: self)
                    // Cold startup loaded the existing account before admitting this page.
                    // A fresh interactive pairing has an empty store after sign-out cleanup.
                    guard page === webView, !account.cleanupPending else { throw NativeAccountError.cancelled }
                    if let storage = try account.openPlaybackStore() { try player?.restoreIfNeeded(from: storage); try await pins.bind(storage) }
                    #if DEBUG
                    state["debugPlayback"] = true
                    #endif
                    reply = state
                case "debugRequireInteractiveReconnect":
                    try account.requireInteractiveReconnectForDebug()
                    reply = true
                case "pins":
                    reply = try handlePins(args, account: account)
                case "diagnostics":
                    reply = try account.diagnostics.entries(after: (args["after"] as? String).flatMap(UUID.init(uuidString:)))
                case "playback":
                    guard args["version"] as? Int == 1, let player, account.snapshot["driveID"] is String,
                          let action = args["action"] as? String else { throw NativeAccountError.invalidRequest }
                    var applied: Bool?
                    var staleProof = false
                    switch action {
                    case "snapshot", "readAccess": break
                    case "importSpot":
                        guard let favorite = args["favorite"] as? String, let value = args["spot"] as? [String: Any] else { throw NativeAccountError.invalidRequest }
                        let spot = try JSONDecoder().decode(FavoriteSpot.self, from: JSONSerialization.data(withJSONObject: value))
                        guard spot.seconds.isFinite, spot.seconds >= 0, spot.path.dropFirst().first == "fav:" + favorite else { throw NativeAccountError.invalidRequest }
                        try player.importSpot(spot, favorite: favorite)
                    case "intent":
                        selectionIntent = args["intent"] as? String
                        staged = nil
                    case "cancelIntent":
                        if let id = args["intent"] as? String, selectionIntent == id {
                            selectionIntent = nil
                            staged = nil
                        }
                    case "fence":
                        guard let session = args["session"] as? String, let revision = args["revision"] as? Int else { throw NativeAccountError.invalidRequest }
                        player.fence(session: session, revision: revision)
                    case "access":
                        guard let expected = args["subscription"] as? String, let base = args["base"] as? Int,
                              let denied = args["denied"] as? [String], base >= 0 else { throw NativeAccountError.invalidRequest }
                        let allowed = args["allowed"] as? [String] ?? []
                        let proof = args["proof"] as? String
                        staleProof = (!denied.isEmpty || !allowed.isEmpty) && (proof == nil || proof != account.currentShareProof)
                        do {
                        applied = expected == subscription && !staleProof
                            ? try player.updateAccess(base: base, connected: (args["connected"] as? [String]).map(Set.init),
                                                      denied: Set(denied), allowed: Set(allowed),
                                                      disconnected: Set(args["disconnected"] as? [String] ?? []))
                            : false
                        } catch {
                            // A failed durable access write can already have revoked the source in memory.
                            try pins.reconcile()
                            throw error
                        }
                        if applied == true { try pins.reconcile() }
                    case "timer":
                        guard let setting = args["timer"] as? String else { throw NativeAccountError.invalidRequest }
                        try player.changeTimer(setting)
                    case "beginQueue":
                        guard let id = args["build"] as? String, let count = args["count"] as? Int, count > 0 else {
                            throw NativeAccountError.invalidRequest
                        }
                        staged = (id, count, [])
                        if let session = args["session"] as? String, let revision = args["revision"] as? Int {
                            player.fence(session: session, revision: revision)
                            systemPlayback?.publishNowPlaying()
                        }
                    case "queueChunk":
                        guard let id = args["build"] as? String, staged?.id == id,
                              let offset = args["offset"] as? Int, staged?.tracks.count == offset,
                              let values = args["tracks"] as? [[String: Any]], !values.isEmpty,
                              values.count <= 512, offset + values.count <= staged!.count else { throw NativeAccountError.invalidRequest }
                        staged!.tracks += try decodeEntries(values)
                    case "start", "revise":
                        guard let folder = args["folder"] as? [String], let folderKey = args["folderKey"] as? String,
                              !folderKey.isEmpty else { throw NativeAccountError.invalidRequest }
                        let tracks: [IndexedTrack]
                        if let build = args["build"] as? String {
                            guard let pending = staged, pending.id == build, pending.count == pending.tracks.count else { throw NativeAccountError.invalidRequest }
                            tracks = pending.tracks
                        } else {
                            guard let values = args["tracks"] as? [[String: Any]], values.count <= 512 else { throw NativeAccountError.invalidRequest }
                            tracks = try decodeEntries(values)
                        }
                        staged = nil
                        guard Set(tracks.compactMap(\.key)).count == tracks.count else { throw NativeAccountError.invalidRequest }
                        let favorite = args["favorite"] as? String
                        let mode = (args["mode"] as? String).flatMap(QueueMode.init(rawValue:))
                        guard favorite == nil || folder.dropFirst().first == "fav:" + favorite! else { throw NativeAccountError.invalidRequest }
                        if action == "start" {
                            let legacy = args["legacyPosition"] as? Double
                            let validIntent = legacy != nil ? selectionIntent == nil && legacy!.isFinite && legacy! >= 0
                                : selectionIntent != nil && args["intent"] as? String == selectionIntent
                            guard validIntent, player.sessionID == args["base"] as? String else {
                                replyHandler(playbackSample(player, account), nil)
                                return
                            }
                            guard let index = args["index"] as? Int else { throw NativeAccountError.invalidRequest }
                            try player.start(tracks: tracks, startIndex: index, delaySeconds: 0, nearEnd: false, forceRefresh: false,
                                             folder: folder, folderKey: folderKey, selected: args["selected"] as? Bool == true, timer: args["timer"] as? String, initialMode: mode, favorite: favorite, legacyPosition: legacy)
                        } else {
                            guard let session = args["session"] as? String, let revision = args["revision"] as? Int else { throw NativeAccountError.invalidRequest }
                            player.revise(session: session, revision: revision, folder: folder, tracks: tracks, favorite: favorite, configuredMode: mode)
                        }
                    default:
                        guard let item = args["item"] as? String else { throw NativeAccountError.invalidRequest }
                        try player.apply(action, item: item, seconds: args["seconds"] as? Double)
                    }
                    // Queue and access updates share this bridge. Only the drawer sets its subscription.
                    if let showing = args["debugRanges"] as? Bool { showingAudioRanges = showing }
                    if ["start", "revise", "fence", "seek", "skip", "pause", "cycleMode", "next", "previous", "access", "timer", "play"].contains(action) {
                        player.handleOutputChange(.parkPaused)
                        systemPlayback?.publishNowPlaying()
                        try await player.waitForCheckpointWrites()
                    }
                    var sample = playbackSample(player, account, includeDenied: action == "readAccess")
                    if let applied { sample["applied"] = applied }
                    if staleProof { sample["staleProof"] = true }
                    if action == "intent" { sample["base"] = player.sessionID }
                    reply = sample
                case "request":
                    reply = try await account.request(message: args)
                case "chunk", "abort":
                    guard let id = args["id"] as? String else { replyHandler(nil, "invalidRequest"); return }
                    if op == "chunk" { reply = try account.readChunk(id: id) }
                    else { account.abort(id: id); reply = true }
                #if DEBUG
                case "playIndexed":
                    guard let player, account.snapshot["driveID"] is String,
                          let tracks = args["tracks"] as? [[String: String]], (1...10).contains(tracks.count),
                          let delay = args["delaySeconds"] as? Int, [0, 5, 10].contains(delay),
                          let nearEnd = args["nearEnd"] as? Bool, let force = args["forceRefresh"] as? Bool
                    else { replyHandler(nil, "invalidRequest"); return }
                    let items = try JSONDecoder().decode([IndexedTrack].self, from: JSONSerialization.data(withJSONObject: tracks))
                    try player.start(tracks: items, delaySeconds: delay, nearEnd: nearEnd, forceRefresh: force)
                    reply = true
                case "stopPlayback": player?.stop(); reply = true
                case "playbackStatus": reply = player?.status ?? "Stopped"
                #endif
                default: replyHandler(nil, "invalidRequest"); return
                }
                guard page === webView, !account.cleanupPending else { replyHandler(nil, "detached"); return }
                replyHandler(reply, nil)
            } catch let error as NativeAccountError { replyHandler(nil, error.rawValue) }
            catch { replyHandler(nil, "failure") }
        }
    }
}
