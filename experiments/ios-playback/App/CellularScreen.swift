#if CELLULAR_PROBE
import SwiftUI
import WebKit
import MediaPlayer

/// The native run survives destroying the page, suspending JavaScript and locking the device.
@MainActor final class CellularController: ObservableObject {
    @Published var status = "Ready"
    @Published var pageVisible = true
    private let worker = DispatchQueue(label: "me.unto.oneplay.cellular-decoder")
    private var run: CellularRun?
    var webScript = false
    var startOnAttach = false
    var unattended = false
    var runAllControls = false
    var testingWeb: Bool { webScript && run?.mode == "web" }
    var reattachOnAdvance = false
    private var remaining = [String]()
    private var remote: Any?
    private var identity = UUID()
    let traceURL = URL.documentsDirectory.appendingPathComponent("cellular.log")

    init() {
        let command = MPRemoteCommandCenter.shared().nextTrackCommand
        command.isEnabled = true
        remote = command.addTarget { [weak self] _ in
            Task { @MainActor in
                guard let self, let run = self.run, let item = run.snapshot()["occurrence"] as? Int else { return }
                self.log("system Next")
                _ = run.request(item: item, seconds: nil)
            }
            return .success
        }
    }

    nonisolated private static let writes = NSLock()
    nonisolated static func write(_ url: URL, _ message: String) {
        writes.withLock {
            do {
                let line = String(format: "%.6f ", ProcessInfo.processInfo.systemUptime) + message + "\n"
                if !FileManager.default.fileExists(atPath: url.path) {
                    try Data().write(to: url, options: .completeFileProtectionUntilFirstUserAuthentication)
                }
                let f = try FileHandle(forWritingTo: url)
                defer { try? f.close() }
                try f.seekToEnd()
                try f.write(contentsOf: Data(line.utf8))
            } catch { NSLog("Probe trace error %ld", (error as NSError).code) }
        }
    }

    func log(_ message: String) { Self.write(traceURL, message) }

    func start(_ mode: String) {
        stop()
        if mode == "suite" {
            remaining = ["ten","join03","short"]
            launch("five")
        } else if mode == "web" && runAllControls {
            remaining = ["cancel","raceBefore","raceAfter","album"]
            launch(mode)
        } else { launch(mode) }
    }

    private func launch(_ mode: String) {
        let token = UUID(), url = traceURL
        identity = token
        let trial = CellularRun(mode, muted: unattended) { line in Self.write(url, "\(token) \(line)") }
        run = trial
        log("\(token) start \(mode)")
        status = "Preparing " + mode
        worker.async { [weak self] in
            let result: String
            do { try trial.play(); result = "Finished " + mode }
            catch is CancellationError { result = "Stopped" }
            catch { result = "Failed: " + error.localizedDescription }
            Self.write(url, "\(token) \(result)")
            Task { @MainActor [weak self] in
                guard let self, self.identity == token else { return }
                if result.hasPrefix("Finished"), !self.remaining.isEmpty {
                    self.launch(self.remaining.removeFirst())
                    return
                }
                self.run = nil
                self.status = result
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            }
        }
    }

    func stop() {
        identity = UUID()
        remaining = []
        run?.cancel()
        run = nil
        status = "Ready"
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func skipLong() { run?.skipLongPreparation() }
    func snapshot() -> [String: Any] { run?.snapshot() ?? ["occurrence":-1, "seconds":0, "run":""] }

    func seek(_ item: Int, _ seconds: Double, _ token: String) -> Bool {
        guard seconds.isFinite, (0...7200).contains(seconds), let run, run.id.uuidString == token else { return false }
        return run.request(item: item, seconds: seconds)
    }

    func refresh(viewIsActive: Bool) {
        guard let run, let item = run.snapshot()["occurrence"] as? Int, item >= 0,
              let seconds = run.snapshot()["seconds"] as? Double else { return }
        if viewIsActive && reattachOnAdvance && item >= 2 {
            reattachOnAdvance = false
            pageVisible = true
        }
        let track = run.mode == "album" ? 1+item : run.mode == "join03" ? 3+item : 2+item
        status = String(format: "Playing [%02d] · %.1f s", track, seconds)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle:String(format:"The Wall [%02d]",track),
            MPMediaItemPropertyArtist:"Pink Floyd", MPNowPlayingInfoPropertyElapsedPlaybackTime:seconds,
            MPNowPlayingInfoPropertyPlaybackRate:1
        ]
    }
}

struct CellularScreen: View {
    @ObservedObject var probe: CellularController
    @Environment(\.scenePhase) private var phase
    var body: some View {
        List {
            Section("Bundled test page") {
                Toggle("Attach page", isOn: $probe.pageVisible)
                CellularPage(probe: probe, attached: probe.pageVisible).frame(height: probe.pageVisible ? 136 : 1)
            }
            Section("Cellular MP3 playback") {
                Text(probe.status)
                ForEach([("suite","Run all four listening trials"),("five","[02] → [03] · 5 s renewal"),("ten","[02] → [03] · 10 s renewal"),("join03","[03] → [04] · 10 s renewal"),
                         ("short","Short-prefix stall control"),("advance","[02] → [03] → [04]"),("album","Full tracks [01]–[10]"),
                         ("cancel","Cancel two-hour MP3 on first data"),("raceBefore","Edit 100 ms before join"),("raceAfter","Edit 100 ms after join")], id: \.0) { mode, name in
                    Button(name) { probe.start(mode) }
                }
                Button("Skip two-hour preparation") { probe.skipLong() }
                Button("Stop") { probe.stop() }
            }
        }.navigationTitle("Cellular probe")
        .onChange(of: phase) { _, value in probe.log("scene \(value)") }
        .onReceive(Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()) { _ in probe.refresh(viewIsActive: phase == .active) }
    }
}

private struct CellularPage: UIViewRepresentable {
    let probe: CellularController
    let attached: Bool
    func makeCoordinator() -> Bridge { Bridge(probe) }
    func makeUIView(context: Context) -> UIView { UIView() }

    /// A List can retain offscreen rows. Explicitly release the WKWebView when detaching the test page.
    func updateUIView(_ host: UIView, context: Context) {
        if let existing = host.subviews.first as? WKWebView {
            if !attached {
                existing.stopLoading()
                existing.configuration.userContentController.removeScriptMessageHandler(forName: "native", contentWorld: .page)
                existing.removeFromSuperview()
                probe.log("web detached view=\(ObjectIdentifier(existing))")
            }
            return
        }
        guard attached else { return }
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(context.coordinator, forURLScheme: "oneplay")
        cfg.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "native")
        let view = WKWebView(frame: host.bounds, configuration: cfg)
        view.autoresizingMask = [.flexibleWidth,.flexibleHeight]
        host.addSubview(view)
        view.load(URLRequest(url: URL(string:"oneplay://app/cellular")!))
    }

    @MainActor final class Bridge: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply {
        let probe: CellularController
        init(_ probe: CellularController) { self.probe = probe }
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url, url.absoluteString == "oneplay://app/cellular" else {
                task.didFailWithError(URLError(.unsupportedURL)); return
            }
            let html = """
            <meta name="viewport" content="width=device-width,initial-scale=1"><button id="play">Play [02] → [04]</button>
            <p><input id="scrub" type="range" min="0" max="15" step=".1" aria-label="Seek"></p><output></output>
            <script>
            const call = data => webkit.messageHandlers.native.postMessage(data)
            let state, drag
            async function refresh(action) {
              state = await call({action})
              document.querySelector('output').textContent = state.occurrence < 0 ? 'Ready' :
                state.title + ' · ' + state.fileSeconds.toFixed(1) + ' s'
            }
            play.onclick = () => refresh('play')
            scrub.onpointerdown = () => { drag = state }
            scrub.onchange = async () => {
              if (drag) await call({action:'seek', ...drag, seconds:Number(scrub.value)})
              drag = null
              await refresh('snapshot')
            }
            async function startPage() {
              await refresh('attach')
              await call({action:'display', text:document.querySelector('output').textContent})
              if (state.scripted) play.click()
              let step = 0
              setInterval(async () => {
                await refresh('snapshot')
                if (state.test && state.occurrence === 0 && state.seconds > 1 && step === 0) {
                  step++
                  scrub.dispatchEvent(new PointerEvent('pointerdown'))
                  scrub.value = 3
                  scrub.dispatchEvent(new Event('change'))
                } else if (state.test && state.occurrence === 0 && state.seconds > 4 && step === 1) {
                  step++
                  scrub.dispatchEvent(new PointerEvent('pointerdown'))
                } else if (state.test && state.occurrence === 1 && step === 2) {
                  step++
                  scrub.value = 8
                  await scrub.onchange()

                }
              }, 250)
            }
            startPage()
            </script>
            """
            let data = Data(html.utf8)
            task.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data); task.didFinish()
        }
        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping (Any?, String?) -> Void) {
            guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.absoluteString == "oneplay://app/cellular",
                  let body = message.body as? [String:Any], let action = body["action"] as? String else { replyHandler(nil,"Invalid message"); return }
            switch action {
            case "attach": probe.log("web attached snapshot=\(probe.snapshot())")
            case "snapshot": break
            case "play": probe.start(probe.webScript ? "web" : "advance")
            case "display":
                if let text = body["text"] as? String { probe.log("web readout " + text) }
            case "seek":
                if let item = body["occurrence"] as? Int, let s = body["seconds"] as? Double, let token = body["run"] as? String {
                    let applied = probe.seek(item,s,token)
                    replyHandler(applied,nil)
                    if !applied && probe.testingWeb {
                        probe.reattachOnAdvance = true
                        probe.pageVisible = false
                        probe.log("web detach requested after stale seek")
                    }
                    return
                }
            default: replyHandler(nil,"Unknown action"); return
            }
            var state = probe.snapshot()
            state["scripted"] = action == "attach" && probe.startOnAttach
            if action == "attach" { probe.startOnAttach = false }
            state["test"] = probe.testingWeb
            replyHandler(state,nil)
        }
    }
}
#endif
