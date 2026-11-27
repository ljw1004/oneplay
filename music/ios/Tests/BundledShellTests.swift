import XCTest
import WebKit
@testable import OnePlayMusic

/// A cold WebContent process can start after XCTest. Check the rendered page
/// and report its actual terminal state if WebKit or application startup fails.
@MainActor func readyPage(in controller: LibraryController, excluding old: WKWebView? = nil,
                          timeout: Duration = .seconds(20), allowEmptyOffline: Bool = false) async throws -> WKWebView {
    let deadline = ContinuousClock.now + timeout
    let ready = "!!document.querySelector('.signin-btn') || document.getElementById('tree-container')?.hidden === false"
        + (allowEmptyOffline ? " || !!document.querySelector('.startup-error[data-offline]')" : "")
    while ContinuousClock.now < deadline {
        if let page = controller.webView, page !== old,
           (try? await page.evaluateJavaScript(ready)) as? Bool == true { return page }
        try await Task.sleep(for: .milliseconds(50))
    }
    let status = try? await controller.webView?.evaluateJavaScript("document.getElementById('status')?.innerText ?? document.readyState")
    let reason = "Expected a ready shell. Replaced=\(controller.webView !== old), status=\(String(describing: status))"
    throw NSError(domain: "BundledShellTests", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
}


/// Exercise the installed app, its real scheme handler, and WebKit's reply API.
/// Prior markers let two independently launched builds demonstrate an in-place upgrade.
@MainActor final class BundledShellTests: XCTestCase {
    func testInstalledShellAndStores() async throws {
        let app = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
        let page = try await readyPage(in: app.library, allowEmptyOffline: true)
        XCTAssertEqual(page.url, BundledShell.page)
        let modules = BundledShell().files.keys.filter { $0.pathExtension == "js" }.map(\.absoluteString)
        let result = try await page.callAsyncJavaScript("""
            await Promise.all(modules.map(url => import(url)));
            const bridge = window.webkit.messageHandlers.oneplay;
            const state = await bridge.postMessage({op:'state'});
            const iframe = document.body.appendChild(document.createElement('iframe'));
            let denied;
            try { await iframe.contentWindow.webkit.messageHandlers.oneplay.postMessage({op:'state'}); denied = false; }
            catch { denied = true; }
            iframe.remove();
            const images = await Promise.all(['favicon','appicon','bigicon'].map(async name => {
                const image = new Image(); image.src = './assets/'+name+'.png'; await image.decode(); return image.naturalWidth;
            }));
            const ls = localStorage.getItem('m17-shell-build');
            const db = await new Promise((resolve,reject) => {
                const q = indexedDB.open('m17-shell-gate',1);
                q.onupgradeneeded = () => q.result.createObjectStore('checks');
                q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
            });
            const idb = await new Promise((resolve,reject) => {
                const tx = db.transaction('checks','readwrite'), store = tx.objectStore('checks');
                const old = store.get('build'); store.put(build,'build');
                tx.oncomplete = () => resolve(old.result ?? null); tx.onabort = () => reject(tx.error);
            });
            db.close(); localStorage.setItem('m17-shell-build',build);
            return {origin:location.origin,uuid:crypto.randomUUID(), evidence:state.evidence,
                    images, denied, styles:[...document.styleSheets].map(s => s.cssRules.length), ls, idb};
            """, arguments: ["modules": modules, "build": Bundle.main.infoDictionary!["CFBundleVersion"]!], in: nil, contentWorld: .page)
        let values = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(values["origin"] as? String, "oneplay://app")
        XCTAssertNotNil(UUID(uuidString: values["uuid"] as? String ?? ""))
        XCTAssertNotNil(values["evidence"] as? String)
        XCTAssertEqual(values["denied"] as? Bool, true)
        XCTAssertEqual((values["styles"] as? [Int])?.filter { $0 > 0 }.count, 2)
        XCTAssertEqual((values["images"] as? [Int])?.filter { $0 > 0 }.count, 3)
        XCTAssertEqual(values["ls"] as? String, values["idb"] as? String)
        if let expected = ProcessInfo.processInfo.environment["ONEPLAY_EXPECT_PREVIOUS_BUILD"] {
            XCTAssertEqual(values["ls"] as? String, expected, "Prior localStorage build marker")
            XCTAssertEqual(values["idb"] as? String, expected, "Prior IndexedDB build marker")
        }
        print("Shell: \(modules.count) modules; previous localStorage=\(values["ls"]!), IndexedDB=\(values["idb"]!)")
    }

    /// Same-URL reload must release page-owned requests and file handles along with the old document.
    func testReloadReplacesTheAdmittedView() async throws {
        let controller = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        let old = try await readyPage(in: controller, allowEmptyOffline: true)
        old.reload()
        _ = try await readyPage(in: controller, excluding: old, allowEmptyOffline: true)
    }

    func testManifestExcludesUntrustedURLs() {
        let shell = BundledShell()
        XCTAssertNotNil(shell.files[BundledShell.page])
        for address in ["oneplay://app:9/music/index.html", "oneplay://other/music/index.html",
                        "oneplay://app/music/../Info.plist", "oneplay://app/music/dist/index.js.map",
                        "oneplay://app/music/index.html?other", "oneplay://app/music/sw.js"] {
            XCTAssertNil(shell.files[URL(string: address)!])
        }
    }
}
