import AVFoundation
import UIKit
import WebKit

/// Owns the one admitted page. Losing WebKit cancels its requests while the
/// playback session can still renew URLs independently of the page.
@MainActor final class LibraryController: UIViewController, WKScriptMessageHandlerWithReply {
    private let shell = BundledShell()
    private let deviceTheme = URL.applicationSupportDirectory.appendingPathComponent("DeviceTheme")
    private let personalStore: WKWebsiteDataStore
    private lazy var demoWebStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "C6D91655-F0E0-494C-B400-AE4269C6E8E7")!)
    private let demo: DemoLibrary
    private static let demoSelection = "DemoLibrarySelected"
    private var demoActive = false
    private var demoEvidence = "no-evidence"
    private var demoChooserAttempt: String?
    private var demoOpenFailed = false
    private var focusDemoTree = false
    private var focusProviderChooser = false
    private var changingProfile = false
    private var profileBound = false
    private var bindingProfile: Task<Void, Error>?
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
    private var foregroundStartSession: String?
    private var staged: (id: String, count: Int, tracks: [IndexedTrack])?
    private var showingAudioRanges = false
    #if DEBUG
    var beforePlayReplySampleForTesting: (() async -> Void)?
    #endif
    /// Both library themes draw a blue header beneath the system status icons.
    override var preferredStatusBarStyle: UIStatusBarStyle { webView == nil ? .default : .lightContent }

    private(set) var webView: WKWebView? {
        didSet { setNeedsStatusBarAppearanceUpdate() }
    }

    init(account: NativeAccount? = nil, store: WKWebsiteDataStore? = nil, player: NativePlayback? = nil,
         pinConfiguration: URLSessionConfiguration? = nil, demo: DemoLibrary? = nil, demoStore: WKWebsiteDataStore? = nil) {
        self.pins = OfflinePins(configuration: pinConfiguration ?? (account == nil ? .background(withIdentifier: OfflinePins.identifier) : .ephemeral))
        self.player = player
        self.account = account
        self.personalStore = store ?? WKWebsiteDataStore(forIdentifier: UUID(uuidString: "83178CEF-278A-4625-9E7C-C7526D5AF452")!)
        self.demo = demo ?? DemoLibrary()
        super.init(nibName: nil, bundle: nil)
        if let demoStore { self.demoWebStore = demoStore }
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
                configurePlayer(account)
                pins.lookup = { [weak self] drive, item, lookup in
                    guard let self else { throw NativeAccountError.cancelled }
                    return try await self.lookupMedia(drive, item, lookup: lookup)
                }
                pins.playerHolds = { [weak self] key in self?.player?.holdsPin(key) == true }
                pins.allowsSource = { [weak self] root in
                    guard let self, !demoActive || root == DemoMusicCatalog.source else { return false }
                    return player?.allowsPinSource(root) == true
                }
                pins.allowsMediaKey = { [weak self] key in
                    guard let self else { return false }
                    if !demoActive { return true }
                    let prefix = DemoMusicCatalog.source + ":"
                    return key.hasPrefix(prefix) && demo.catalog?.recordings[String(key.dropFirst(prefix.count))] != nil
                }
                pins.onChange = { [weak self] in
                    guard let self else { return }
                    let limited = ["evidence:not-online", "evidence:signed-out"].contains(currentEvidence(account))
                    if player?.setOfflineAvailability(limited ? pins.completeKeys : nil) == true { systemPlayback?.publishNowPlaying() }
                    if UIApplication.shared.applicationState == .active {
                        webView?.evaluateJavaScript("window.dispatchEvent(new Event('oneplay-pins'))", completionHandler: nil)
                    }
                }
                account.diagnostics.onPending = { [weak self] in self?.signalPendingDiagnostics() }
                account.onMediaRequestChange = { [weak self] in self?.signalPlayerChange(debugOnly: true) }
                account.onEvidenceChange = { [weak self] evidence in
                    guard let self, !demoActive else { return }
                    publishEvidence(evidence)
                }
                account.onNetworkPathChange = { [weak self] in
                    guard let self else { return }
                    player?.cancelWiFiReadsIfMetered()
                    if demoActive && account.routeIsOffline { setDemoEvidence("evidence:not-online") }
                    else if demoActive && demoEvidence == "evidence:not-online" {
                        setDemoEvidence("no-evidence")
                        resumeDemoCatalogInBackground(account)
                    }
                }
                if account.cleanupPending { try await finishCleanup(account) }
                demoActive = account.snapshot["driveID"] is NSNull && UserDefaults.standard.bool(forKey: Self.demoSelection)
                if demoActive {
                    demoEvidence = account.routeIsOffline ? "evidence:not-online" : "no-evidence"
                    do { _ = try demo.loadCatalog() }
                    catch { account.diagnostics.record("Demo catalog read deferred") }
                }
                do { try await bindSelectedProfile(account) }
                catch {
                    guard demoActive else { throw error }
                    abandonDemoBinding(account)
                }
                await pins.connectSession()
                if demoActive && !account.routeIsOffline { resumeDemoCatalogInBackground(account) }
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

    /// A profile owns one player, while WebKit replacement keeps that player live.
    private func configurePlayer(_ account: NativeAccount) {
        player = player ?? NativePlayback(diagnostics: account.diagnostics,
            pool: MediaPool(unmeteredWiFi: account.unmeteredWiFi)) { [weak self] drive, item, lookup, wifiOnly in
            guard let self else { throw NativeAccountError.cancelled }
            return try await self.lookupMedia(drive, item, lookup: lookup, wifiOnly: wifiOnly)
        }
        player?.onChange = { [weak self] debugOnly in self?.signalPlayerChange(debugOnly: debugOnly) }
        if let player {
            systemPlayback = SystemPlayback(player: player) { [weak self] in self?.signalPlayerChange(debugOnly: false) }
            systemPlayback?.publishNowPlaying()
        }
    }

    private func currentEvidence(_ account: NativeAccount) -> String {
        demoActive ? demoEvidence : (account.snapshot["evidence"] as? String ?? "no-evidence")
    }

    private func publishEvidence(_ evidence: String, publicMedia: Bool? = nil) {
        pins.updateEvidence(evidence, publicMedia: publicMedia)
        webView?.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent('oneplay-evidence', {detail:evidence}))",
            arguments: ["evidence": evidence], in: nil, in: .page, completionHandler: nil)
    }

    private func setDemoEvidence(_ next: String) {
        guard demoEvidence != next else { return }
        demoEvidence = next
        publishEvidence(next)
    }

    private func lookupMedia(_ drive: String, _ item: String, lookup: MediaLookup, wifiOnly: Bool = false) async throws -> MediaLocation {
        // The previous player and pin generation have drained before this flag opens.
        guard let account, profileBound else { throw NativeAccountError.cancelled }
        if demoActive {
            guard drive == DemoMusicCatalog.source else { throw NativeAccountError.missingRecording }
            // A seek within an admitted occurrence keeps its immutable revision across catalog refreshes.
            if case let .reuse(admitted) = lookup, let admitted, admitted.immutable, !admitted.isRejected, !admitted.accessDenied {
                return admitted
            }
            guard let media = demo.catalog?.recordings[item] else { throw NativeAccountError.missingRecording }
            return MediaLocation(url: media.url, etag: media.blob, size: media.size, immutable: true)
        }
        return try await account.media(driveID: drive, itemID: item, lookup: lookup, wifiOnly: wifiOnly)
    }

    /// A pairing can arrive between two WebKit documents. Bind the shared store once.
    private func bindSelectedProfile(_ account: NativeAccount) async throws {
        if profileBound { return }
        if let bindingProfile { return try await bindingProfile.value }
        let binding = Task<Void, Error> {
            pins.updateEvidence("no-evidence", publicMedia: false)
            let storage = try demoActive ? demo.openStore() : account.openPlaybackStore()
            if let storage, let player {
                try await Task.detached { try player.restoreIfNeeded(from: storage) }.value
                try await pins.bind(storage)
                profileBound = true
            }
            publishEvidence(currentEvidence(account), publicMedia: demoActive)
            systemPlayback?.publishNowPlaying()
        }
        bindingProfile = binding
        defer { bindingProfile = nil }
        try await binding.value
    }

    /// A background URLSession wake can recover eligible pins before WebKit exists.
    private func resumeDemoCatalogInBackground(_ account: NativeAccount) {
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await refreshDemoSnapshot(account) }
            catch { account.diagnostics.record("Background demo refresh deferred") }
        }
    }

    private func refreshDemoSnapshot(_ account: NativeAccount) async throws -> DemoMusicCatalog {
        guard demoActive, !changingProfile, let residence = player else { throw NativeAccountError.cancelled }
        let next = try await demo.refresh()
        guard player === residence, demoActive, !changingProfile else { throw NativeAccountError.cancelled }
        do { try pins.reconcile() }
        catch { account.diagnostics.record("Could not reconcile pins after demo refresh") }
        return next
    }

    /// Storage failure leaves saved Demo files in place and returns to the neutral chooser.
    private func abandonDemoBinding(_ account: NativeAccount) {
        account.diagnostics.record("Could not bind demo storage")
        demo.cancelRefresh()
        profileBound = false
        pins.closeAdmission()
        systemPlayback = nil
        player = nil
        demoActive = false
        demoOpenFailed = true
        focusDemoTree = false
        UserDefaults.standard.removeObject(forKey: Self.demoSelection)
        configurePlayer(account)
    }

    /// Retire the old workspace before asynchronous checkpoint and store handoff work.
    private func switchProfile(toDemo: Bool, account: NativeAccount) {
        guard !changingProfile else { return }
        changingProfile = true
        UserDefaults.standard.set(toDemo, forKey: Self.demoSelection)
        profileBound = false
        // Clearing old pin inventory must not change the retiring playback cursor.
        let retiringPlayer = player
        player = nil
        systemPlayback = nil
        pins.closeAdmission()
        let previousPage = webView
        detachPage()
        if demoActive {
            demo.cancelRefresh()
            retiringPlayer?.parkAndCheckpointForProfileSwitch()
        }
        Task {
            do {
                if demoActive { try await retiringPlayer?.waitForCheckpointWrites() }
            } catch { account.diagnostics.record("Demo checkpoint deferred during profile switch") }
            if let previousPage {
                do { try await shell.retireDocument(in: previousPage) }
                catch { account.diagnostics.record("Old workspace document could not finish retirement") }
            }
            await pins.unbindAndCancel()
            do { try await retiringPlayer?.stopAndDrain() }
            catch { account.diagnostics.record("Old workspace playback cleanup deferred") }
            demoActive = toDemo
            demoEvidence = account.routeIsOffline ? "evidence:not-online" : "no-evidence"
            configurePlayer(account)
            do {
                try await bindSelectedProfile(account)
                changingProfile = false
                if demoActive && !account.routeIsOffline { resumeDemoCatalogInBackground(account) }
                loadPage()
            } catch {
                changingProfile = false
                if toDemo {
                    abandonDemoBinding(account)
                    loadPage()
                } else {
                    account.diagnostics.record("Could not bind workspace storage")
                    showUnavailable()
                }
            }
        }
    }

    /// Open only the isolated catalog from the neutral chooser. No media or UI state is admitted yet.
    private func chooseDemo(_ attempt: String, focus: Bool, page: WKWebView, account: NativeAccount) async throws {
        guard demoChooserAttempt == attempt, account.snapshot["driveID"] is NSNull else {
            throw NativeAccountError.cancelled
        }
        defer { if demoChooserAttempt == attempt { demoChooserAttempt = nil } }
        let confirmedCacheMiss: Bool
        do { confirmedCacheMiss = try demo.loadCatalog() == nil }
        catch {
            if account.routeIsOffline { throw error }
            account.diagnostics.record("Demo catalog could not be read")
            confirmedCacheMiss = false
        }
        if demo.catalog == nil {
            if account.routeIsOffline { throw NativeAccountError.unavailableOffline }
            do { _ = try await demo.refresh() }
            catch {
                guard demoChooserAttempt == attempt else { throw NativeAccountError.cancelled }
                if confirmedCacheMiss && account.routeIsOffline { throw NativeAccountError.unavailableOffline }
                throw error
            }
        }
        guard demoChooserAttempt == attempt, page === webView, account.snapshot["driveID"] is NSNull else {
            throw NativeAccountError.cancelled
        }
        focusDemoTree = focus
        switchProfile(toDemo: true, account: account)
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
        guard let player, let account, profileBound else { return }
        page.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('oneplay-playback', {detail:sample}))",
                                 arguments: ["sample": playbackSample(player, account)], in: nil, in: .page, completionHandler: nil)
    }

    /// Replies and pushed transitions share one sequence so a delayed command reply cannot rewind the drawer.
    private func playbackSample(_ player: NativePlayback, _ account: NativeAccount, includeDenied: Bool = false) -> [String: Any] {
        let lookups = showingAudioRanges && !demoActive ? Array(account.mediaRequests.values) : nil
        playbackSequence += 1
        var snapshot = player.snapshot(lookups: lookups, pinSizes: lookups == nil ? [:] : pins.sizes, includeDenied: includeDenied)
        // A push can beat its command reply. Origin belongs to the session admitted by this document.
        if let foregroundStartSession, snapshot["session"] as? String == foregroundStartSession {
            snapshot["foregroundStart"] = true
        }
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
        await personalStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    private func finishCleanup(_ account: NativeAccount) async throws {
        try await account.finishCleanup {
            // The sign-out marker owns the theme until its independent device file is durable.
            if let theme = account.cleanupTheme {
                try Data(theme.utf8).write(to: self.deviceTheme, options: .atomic)
            }
            UserDefaults.standard.removeObject(forKey: Self.demoSelection)
            self.profileBound = false
            await self.pins.unbindAndCancel()
            try await self.player?.stopAndDrain()
            await self.clearLibraryStore()
        }
    }

    func loadPage() {
        guard webView == nil, let account, !account.cleanupPending, !changingProfile else { return }
        pinRevision = -1
        subscription = UUID().uuidString
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = demoActive ? demoWebStore : personalStore
        configuration.setURLSchemeHandler(shell, forURLScheme: "oneplay")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "oneplay")
        // On a clean store the next account inherits only the device's chosen theme.
        if let theme = try? String(contentsOf: deviceTheme, encoding: .utf8), ["light", "dark", "auto"].contains(theme) {
            let script = "localStorage.setItem('oneplay_music_theme','\(theme)')"
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
        if demoChooserAttempt != nil {
            demoChooserAttempt = nil
            demo.cancelRefresh()
        }
        staged = nil
        pinParts = nil
        inventoryParts = nil
        selectionIntent = nil
        foregroundStartSession = nil
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

    private func handlePins(_ args: [String: Any]) throws -> Any {
        guard profileBound, let action = args["action"] as? String else { throw NativeAccountError.unbound }
        switch action {
        case "snapshot":
            let reply = pins.snapshot(after: args["after"] as? Int)
            guard let files = reply["files"] as? [String: Int], let unavailable = reply["unavailable"] as? [String: String],
                  files.count + unavailable.count > 512, let revision = reply["revision"] as? Int else { return reply }
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
                let data = pinParts!.data
                pinParts = nil
                guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String:Any]] else { throw NativeAccountError.invalidRequest }
                if demoActive {
                    for row in rows {
                        guard let groups = row["sources"] as? [String:[String:String]],
                              groups.allSatisfy({ root, keys in root == DemoMusicCatalog.source && keys.keys.allSatisfy(pins.allowsMediaKey) })
                        else { throw NativeAccountError.invalidRequest }
                    }
                }
                try pins.apply(owners: rows)
                pinRevision = revision
            }
        case "quota": try pins.setQuota(args["quota"] as? Int)
        default: throw NativeAccountError.invalidRequest
        }
        return true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let frame = message.frameInfo
        guard let account, !account.cleanupPending, !changingProfile, let page = webView, message.webView === page,
              page.url == BundledShell.page, frame.isMainFrame, frame.request.url == BundledShell.page,
              frame.securityOrigin.protocol == "oneplay", frame.securityOrigin.host == "app",
              frame.securityOrigin.port == 0, let args = message.body as? [String: Any], let op = args["op"] as? String
        else { replyHandler(nil, "untrustedPage"); return }

        // Close admission in this delegate turn, before any queued operation can start.
        if op == "signOut" {
            if demoActive {
                focusProviderChooser = true
                replyHandler(true, nil)
                switchProfile(toDemo: false, account: account)
                return
            }
            do {
                pins.closeAdmission()
                try account.beginSignOut(theme: args["theme"] as? String)
                focusProviderChooser = true
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

        if op == "demoCancelOpen" {
            if let attempt = demoChooserAttempt, attempt == args["attempt"] as? String {
                demoChooserAttempt = nil
                demo.cancelRefresh()
            }
            replyHandler(true, nil)
            return
        }
        let openingAttempt: String?
        if op == "demoOpen" {
            guard let attempt = args["attempt"] as? String, UUID(uuidString: attempt) != nil,
                  !demoActive, !profileBound, account.snapshot["driveID"] is NSNull else {
                replyHandler(nil, "invalidRequest")
                return
            }
            // Connect may cancel this message before its async work begins.
            if demoChooserAttempt != attempt { demo.cancelRefresh() }
            demoChooserAttempt = attempt
            openingAttempt = attempt
        } else { openingAttempt = nil }
        Task<Void, Never> {
            guard page === webView, !account.cleanupPending, !changingProfile else { replyHandler(nil, "detached"); return }
            do {
                let reply: Any
                switch op {
                case "state":
                    if !demoActive && account.snapshot["driveID"] is String { try await bindSelectedProfile(account) }
                    var state = account.snapshot
                    if demoActive {
                        state = ["driveID": NSNull(), "workspace": "demo", "evidence": demoEvidence,
                                 "focusDemoTree": focusDemoTree]
                        focusDemoTree = false
                    } else {
                        if demoOpenFailed {
                            state["demoOpenFailed"] = true
                            demoOpenFailed = false
                        }
                        if focusProviderChooser {
                            state["focusProviderChooser"] = true
                            focusProviderChooser = false
                        }
                    }
                    #if DEBUG
                    state["debugPlayback"] = !demoActive
                    #endif
                    reply = state
                case "signIn":
                    guard !demoActive else { throw NativeAccountError.invalidRequest }
                    var state = try await account.signIn(presenting: self)
                    if !account.cleanupPending {
                        do { try await bindSelectedProfile(account) }
                        catch {
                            guard page === webView, !account.cleanupPending else { throw NativeAccountError.cancelled }
                            // Pairing committed. Recovery belongs to the library opening screen.
                            account.diagnostics.record("Could not open OneDrive storage after sign-in")
                            replyHandler(nil, "libraryOpeningFailed")
                            return
                        }
                    }
                    guard page === webView, !account.cleanupPending else { throw NativeAccountError.cancelled }
                    #if DEBUG
                    state["debugPlayback"] = true
                    #endif
                    reply = state
                case "demoOpen":
                    guard let attempt = openingAttempt else { throw NativeAccountError.invalidRequest }
                    try await chooseDemo(attempt, focus: args["focus"] as? Bool == true, page: page, account: account)
                    reply = true
                case "demoCatalog":
                    guard demoActive else { throw NativeAccountError.invalidRequest }
                    let snapshot: DemoMusicCatalog?
                    if args["refresh"] as? Bool == true {
                        snapshot = try await refreshDemoSnapshot(account)
                    } else { snapshot = try demo.loadCatalog() }
                    if let snapshot { reply = try JSONSerialization.jsonObject(with: snapshot.data) }
                    else { reply = NSNull() }
                case "demoCredits":
                    guard demoActive, let url = demo.catalog?.credits else { throw NativeAccountError.invalidRequest }
                    reply = await UIApplication.shared.open(url)
                case "deviceTheme":
                    guard let theme = args["theme"] as? String, ["light", "dark", "auto"].contains(theme) else {
                        throw NativeAccountError.invalidRequest
                    }
                    try Data(theme.utf8).write(to: deviceTheme, options: .atomic)
                    reply = true
                case "debugRequireInteractiveReconnect":
                    guard !demoActive else { throw NativeAccountError.invalidRequest }
                    try account.requireInteractiveReconnectForDebug()
                    reply = true
                case "pins":
                    reply = try handlePins(args)
                case "diagnostics":
                    reply = try account.diagnostics.entries(after: (args["after"] as? String).flatMap(UUID.init(uuidString:)))
                case "playback":
                    guard args["version"] as? Int == 1, let player, profileBound,
                          let action = args["action"] as? String else { throw NativeAccountError.invalidRequest }
                    var applied: Bool?
                    var acceptedPlay: NativePlayback.PlayAdmission?
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
                        guard !demoActive else { throw NativeAccountError.invalidRequest }
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
                        // A new catalog can commit between queue chunks. Admit only against the current snapshot.
                        if demoActive {
                            guard let catalog = demo.catalog, tracks.allSatisfy({ $0.driveId == DemoMusicCatalog.source
                                && $0.sourceRootKey == DemoMusicCatalog.source && catalog.recordings[$0.itemId] != nil })
                            else { throw NativeAccountError.invalidRequest }
                        }
                        let favorite = args["favorite"] as? String
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
                            let mode = (args["mode"] as? String).flatMap(QueueMode.init(rawValue:))
                            acceptedPlay = try player.start(tracks: tracks, startIndex: index, delaySeconds: 0, nearEnd: false, forceRefresh: false,
                                             folder: folder, folderKey: folderKey, selected: args["selected"] as? Bool == true, timer: args["timer"] as? String, initialMode: mode, favorite: favorite, legacyPosition: legacy)
                            if let acceptedPlay { foregroundStartSession = acceptedPlay.session }
                        } else {
                            guard let session = args["session"] as? String, let revision = args["revision"] as? Int else { throw NativeAccountError.invalidRequest }
                            player.revise(session: session, revision: revision, folder: folder, tracks: tracks, favorite: favorite)
                        }
                    default:
                        guard let item = args["item"] as? String else { throw NativeAccountError.invalidRequest }
                        let command = try player.applyFromPage(action, item: item, seconds: args["seconds"] as? Double)
                        applied = command.applied
                        acceptedPlay = command.play
                    }
                    // Queue and access updates share this bridge. Only the drawer sets its subscription.
                    if let showing = args["debugRanges"] as? Bool { showingAudioRanges = showing }
                    if ["start", "revise", "fence", "seek", "skip", "pause", "cycleMode", "next", "previous", "access", "timer", "play"].contains(action) {
                        player.handleOutputChange(.parkPaused)
                        systemPlayback?.publishNowPlaying()
                        // The accepted mode is returned to its favorite immediately. Its ordinary
                        // checkpoint writer persists the playing session independently.
                        if action != "cycleMode" { try await player.waitForCheckpointWrites() }
                    }
                    #if DEBUG
                    if acceptedPlay != nil { await beforePlayReplySampleForTesting?() }
                    #endif
                    var sample = playbackSample(player, account, includeDenied: action == "readAccess")
                    if let applied { sample["applied"] = applied }
                    if let acceptedPlay { sample["acceptedPlay"] = acceptedPlay.bridgeValue }
                    if staleProof { sample["staleProof"] = true }
                    if action == "intent" { sample["base"] = player.sessionID }
                    reply = sample
                case "request":
                    guard !demoActive else { throw NativeAccountError.invalidRequest }
                    reply = try await account.request(message: args)
                case "chunk", "abort":
                    guard !demoActive else { throw NativeAccountError.invalidRequest }
                    guard let id = args["id"] as? String else { replyHandler(nil, "invalidRequest"); return }
                    if op == "chunk" { reply = try account.readChunk(id: id) }
                    else { account.abort(id: id); reply = true }
                #if DEBUG
                case "playIndexed":
                    guard !demoActive, let player, profileBound,
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
