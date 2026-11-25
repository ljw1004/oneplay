import SwiftUI
import WebKit

/// The page reads last launch's markers before writing the markers for this launch.
struct StorageProbe: UIViewRepresentable {
    let report: (String) -> Void
    func makeCoordinator() -> Handler { Handler(report: report) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "oneplay")
        config.userContentController.add(context.coordinator, name: "storage")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: URL(string: "oneplay://app/music/index.html")!))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Handler: NSObject, WKScriptMessageHandler, WKURLSchemeHandler, WKNavigationDelegate {
        let report: (String) -> Void
        init(report: @escaping (String) -> Void) { self.report = report }

        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url, url.host == "app",
                  ["/music/index.html", "/music/fixture.js"].contains(url.path) else {
                task.didFailWithError(URLError(.unsupportedURL)); return
            }
            do {
                let data = try Data(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Web/" + url.lastPathComponent))
                let mime = url.pathExtension == "js" ? "text/javascript" : "text/html"
                task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
                task.didReceive(data)
                task.didFinish()
            } catch { task.didFailWithError(error) }
        }
        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
        func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
            report(error.localizedDescription)
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let data = try? JSONSerialization.data(withJSONObject: message.body, options: [.sortedKeys]) else { return }
            report(String(decoding: data, as: UTF8.self))
        }
    }
}
