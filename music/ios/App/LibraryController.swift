import UIKit
import UniformTypeIdentifiers
import WebKit

/// Owns the one admitted page. Losing WebKit cancels its requests while the
/// playback session can still renew URLs independently of the page.
@MainActor final class LibraryController: UIViewController, WKScriptMessageHandlerWithReply {
    private let shell = BundledShell()
    private let deviceTheme = URL.applicationSupportDirectory.appendingPathComponent("DeviceTheme")
    private let store: WKWebsiteDataStore
    private var account: NativeAccount?
    private(set) var player: NativePlayback?
    private var playbackSequence = 0
    #if DEBUG
    private var showingAudioRanges = false
    #endif
    #if DEBUG
    private var pickedFiles: CheckedContinuation<[URL], Error>?
    #endif
    private(set) var webView: WKWebView?

    init(account: NativeAccount? = nil, store: WKWebsiteDataStore? = nil, player: NativePlayback? = nil) {
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

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        shell.onReplacePage = { [weak self] in self?.retirePageAndReload() }
        Task { [self] in
            do {
                let account = try self.account ?? NativeAccount()
                self.account = account
                player = player ?? NativePlayback(diagnostics: account.diagnostics, pool: MediaPool(unmeteredWiFi: account.unmeteredWiFi)) { drive, item, request, wifiOnly in
                    try await account.media(driveID: drive, itemID: item, lookup: request, wifiOnly: wifiOnly)
                }
                player?.onChange = { [weak self] debugOnly in self?.signalPlayerChange(debugOnly: debugOnly) }
                #if DEBUG
                account.onMediaRequestChange = { [weak self] in self?.signalPlayerChange(debugOnly: true) }
                #endif
                account.diagnostics.onPending = { [weak self] in self?.signalPendingDiagnostics() }
                account.onNetworkPathChange = { [weak self] in self?.player?.cancelWiFiReadsIfMetered() }
                account.onEvidenceChange = { [weak self] evidence in
                    self?.webView?.callAsyncJavaScript(
                        "window.dispatchEvent(new CustomEvent('oneplay-evidence', {detail:evidence}))",
                        arguments: ["evidence": evidence], in: nil, in: .page, completionHandler: nil)
                }
                if account.cleanupPending {
                    try await finishCleanup(account)
                }
                loadPage()
            } catch {
                showUnavailable()
            }
        }
    }

    /// Best effort. JS also pulls on startup, so a suspended or replaced page can miss this signal.
    func signalPendingDiagnostics() {
        guard let page = webView, page.url == BundledShell.page else { return }
        page.evaluateJavaScript("window.dispatchEvent(new Event('oneplay-diagnostics'))", completionHandler: nil)
    }

    private func signalPlayerChange(debugOnly: Bool) {
        guard let page = webView, page.url == BundledShell.page, UIApplication.shared.applicationState == .active else { return }
        if debugOnly {
            #if DEBUG
            guard showingAudioRanges else { return }
            #else
            return
            #endif
        }
        guard let player, let account, account.snapshot["driveID"] is String else { return }
        page.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('oneplay-playback', {detail:sample}))",
                                 arguments: ["sample": playbackSample(player, account)], in: nil, in: .page, completionHandler: nil)
    }

    /// Replies and pushed transitions share one sequence so a delayed command reply cannot rewind the drawer.
    private func playbackSample(_ player: NativePlayback, _ account: NativeAccount) -> [String: Any] {
        var lookups: [IndexedTrack]?
        #if DEBUG
        if showingAudioRanges { lookups = Array(account.mediaRequests.values) }
        #endif
        playbackSequence += 1
        return ["sequence": playbackSequence, "snapshot": player.snapshot(lookups: lookups)]
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
            try await self.player?.stopAndDrain()
            await self.clearLibraryStore()
        }
    }

    func loadPage() {
        guard webView == nil, let account, !account.cleanupPending else { return }
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

    func detachPage() {
        #if DEBUG
        showingAudioRanges = false
        #endif
        #if DEBUG
        if pickedFiles != nil {
            pickedFiles?.resume(throwing: NativeAccountError.cancelled)
            pickedFiles = nil
            presentedViewController?.dismiss(animated: false)
        }
        #endif
        // beginSignOut already cancelled page-owned work when it committed the marker.
        if let account, !account.cleanupPending { account.detachView() }
        webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeAllUserScripts()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "oneplay", contentWorld: .page)
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
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
                try account.beginSignOut(theme: args["theme"] as? String)
                player?.stop()
                replyHandler(true, nil)
                retirePageAndReload()
            } catch {
                replyHandler(nil, "cleanupFailed")
                if account.cleanupPending {
                    player?.stop()
                    detachPage()
                    showUnavailable()
                }
            }
            return
        }

        Task {
            guard page === webView, !account.cleanupPending else { replyHandler(nil, "detached"); return }
            do {
                let reply: Any
                switch op {
                case "state", "signIn":
                    var state = op == "state" ? account.snapshot : try await account.signIn(presenting: self)
                    #if DEBUG
                    state["debugPlayback"] = true
                    #endif
                    reply = state
                case "diagnostics":
                    reply = try account.diagnostics.entries(after: (args["after"] as? String).flatMap(UUID.init(uuidString:)))
                case "playback":
                    guard args["version"] as? Int == 1, let player, account.snapshot["driveID"] is String,
                          let action = args["action"] as? String else { throw NativeAccountError.invalidRequest }
                    switch action {
                    case "snapshot": break
                    case "start":
                        guard let values = args["tracks"] as? [[String: Any]], let index = args["index"] as? Int
                        else { throw NativeAccountError.invalidRequest }
                        let tracks = try JSONDecoder().decode([IndexedTrack].self, from: JSONSerialization.data(withJSONObject: values))
                        guard tracks.allSatisfy({ ($0.path?.count ?? 0) >= 3 }) else { throw NativeAccountError.invalidRequest }
                        try player.start(tracks: tracks, startIndex: index, delaySeconds: 0, nearEnd: false, forceRefresh: false)
                    default:
                        guard let item = args["item"] as? String else { throw NativeAccountError.invalidRequest }
                        try player.apply(action, item: item, seconds: args["seconds"] as? Double)
                    }
                    #if DEBUG
                    showingAudioRanges = args["debugRanges"] as? Bool == true
                    #endif
                    reply = playbackSample(player, account)
                case "request":
                    reply = try await account.request(message: args)
                case "chunk", "abort":
                    guard let id = args["id"] as? String else { replyHandler(nil, "invalidRequest"); return }
                    if op == "chunk" { reply = try account.readChunk(id: id) }
                    else { account.abort(id: id); reply = true }
                #if DEBUG
                case "playLocal":
                    guard let player, let nearEnd = args["nearEnd"] as? Bool, presentedViewController == nil
                    else { replyHandler(nil, "invalidRequest"); return }
                    let files: [URL] = try await withCheckedThrowingContinuation { continuation in
                        pickedFiles = continuation
                        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.mp3], asCopy: false)
                        picker.allowsMultipleSelection = true
                        picker.delegate = self
                        present(picker, animated: true)
                    }
                    guard page === webView, !account.cleanupPending else { throw NativeAccountError.cancelled }
                    try player.startLocalFiles(files, nearEnd: nearEnd)
                    reply = true
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

#if DEBUG
extension LibraryController: UIDocumentPickerDelegate {
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickedFiles?.resume(throwing: NativeAccountError.cancelled)
        pickedFiles = nil
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickedFiles?.resume(returning: urls)
        pickedFiles = nil
    }
}
#endif
