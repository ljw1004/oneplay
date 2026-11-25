import WebKit

/// The manifest maps public request URLs directly to build-selected files.
/// No component of a request is ever appended to a filesystem path.
@MainActor final class BundledShell: NSObject, WKURLSchemeHandler, WKNavigationDelegate {
    static let page = URL(string: "oneplay://app/music/index.html")!
    let files: [URL: URL]
    private static let blank = URL(string: "about:blank")!
    private var retirement: (page: WKWebView, navigation: WKNavigation, done: CheckedContinuation<Void, Error>)?
    private weak var admittedPage: WKWebView?
    var onReplacePage: (() -> Void)?

    override init() {
        let root = Bundle.main.bundleURL.appendingPathComponent("Web", isDirectory: true)
        let manifest = try? String(contentsOf: root.appendingPathComponent("manifest.txt"), encoding: .utf8)
        files = Dictionary(uniqueKeysWithValues: (manifest ?? "").split(separator: "\n").map {
            let path = String($0)
            return (Self.page.deletingLastPathComponent().appendingPathComponent(path), root.appendingPathComponent(path))
        })
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == "GET", let url = task.request.url,
              let file = files[url], let mime = [
                "html": "text/html", "css": "text/css", "js": "text/javascript",
                "png": "image/png", "json": "application/manifest+json"
              ][file.pathExtension] else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        do {
            let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: bytes.count,
                                        textEncodingName: mime == "image/png" ? nil : "utf-8"))
            task.didReceive(bytes)
            task.didFinish()
        } catch {
            task.didFailWithError(URLError(.fileDoesNotExist))
        }
    }

    // Every read finishes synchronously before WebKit can dispatch a cancellation.
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if retirement?.page === webView {
            decisionHandler(action.targetFrame?.isMainFrame == true && action.request.url == Self.blank ? .allow : .cancel)
            return
        }
        guard action.targetFrame?.isMainFrame == true, action.sourceFrame.isMainFrame,
              action.request.url == Self.page else { decisionHandler(.cancel); return }
        // Give each document its own view and request lifetime, including same-URL reloads.
        if admittedPage === webView {
            decisionHandler(.cancel)
            onReplacePage?()
        } else {
            admittedPage = webView
            decisionHandler(.allow)
        }
    }

    /// A retained WKWebView can still run timers after removal from UIKit. A committed blank
    /// navigation (or process termination) ends the old document before its store can be reused.
    func retireDocument(in page: WKWebView) async throws {
        page.navigationDelegate = self
        defer { page.navigationDelegate = nil }
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            guard let navigation = page.load(URLRequest(url: Self.blank)) else {
                done.resume(throwing: URLError(.cannotLoadFromNetwork))
                return
            }
            retirement = (page, navigation, done)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard let retiring = retirement, retiring.page === webView, retiring.navigation === navigation else { return }
        retirement = nil
        retiring.done.resume()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let retiring = retirement, retiring.page === webView, retiring.navigation === navigation else { return }
        retirement = nil
        retiring.done.resume(throwing: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let retiring = retirement, retiring.page === webView {
            retirement = nil
            retiring.done.resume()
        } else if admittedPage === webView {
            onReplacePage?()
        }
    }
}
