import XCTest
import WebKit
@testable import OnePlayMusic

/// Opt-in because this test opens the listener's installed library and starts audible playback.
@MainActor final class LivePlaybackTests: XCTestCase {
    func testAlbumAdvancesWithoutLibraryPage() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ONEPLAY_TEST_LIVE_ALBUM"] == "1")
        let controller = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        var page: WKWebView? = try await readyPage(in: controller)
        let player = try XCTUnwrap(controller.player)
        defer { player.stop() }
        // Open the real indexed album. The click takes the same path as tapping its file row.
        let chosen = try await page!.callAsyncJavaScript("""
            const tree = window._testTree;
            function find(folder, path) {
                for (const [name, item] of Object.entries(folder.children)) {
                    if (item.children) {
                        const found = find(item, [...path, name]);
                        if (found) return found;
                    } else if (/the thin ice\\.mp3$/i.test(name)) return [...path,name];
                }
            }
            for (const [key, root] of tree.getRoots()) {
                if (root.type !== 'onedrive') continue;
                const path = find(root.folder,['OnePlay Music',key]);
                if (!path) continue;
                tree.revealTrack(path);
                const row = [...document.querySelectorAll('#children .tree-row')].find(r => r.dataset.path === JSON.stringify(path));
                row.querySelector('.row-name').click();
                return path.at(-1);
            }
            throw Error('Test album unavailable');
            """, arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertTrue(chosen?.lowercased().contains("thin ice") == true)
        func waitForSnapshot(_ predicate: ([String: Any]) -> Bool) async throws -> [String: Any] {
            let deadline = ContinuousClock.now + .seconds(120)
            while ContinuousClock.now < deadline {
                let snapshot = player.snapshot
                if predicate(snapshot) { return snapshot }
                if snapshot["state"] as? String == "error" {
                    throw NSError(domain: "LivePlaybackTests", code: 1, userInfo: [NSLocalizedDescriptionKey: snapshot["message"] ?? "Failed"])
                }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw NSError(domain: "LivePlaybackTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected player state timed out"])
        }
        let first = try await waitForSnapshot { $0["state"] as? String == "playing" && ($0["position"] as? Double ?? 0) >= 1 }
        _ = try await page!.evaluateJavaScript("document.querySelector('.footer-playpause').click()")
        let held = try await waitForSnapshot { $0["state"] as? String == "paused" }
        let pausedAt = try XCTUnwrap(held["position"] as? Double)
        XCTAssertGreaterThan(pausedAt, 0.9)
        _ = try await page!.evaluateJavaScript("document.querySelector('.footer-gripper').click()")
        _ = try await page!.callAsyncJavaScript("""
            const skip = document.querySelector('.scrubber-edge-button.top');
            skip.click(); skip.click();
            """, arguments: [:], in: nil, contentWorld: .page)
        let skipped = try await waitForSnapshot { abs(($0["position"] as? Double ?? -100) - pausedAt - 60) < 0.2 }
        XCTAssertEqual(skipped["state"] as? String, "paused")
        _ = try await page!.evaluateJavaScript("document.querySelector('.footer-playpause').click()")
        _ = try await waitForSnapshot { $0["state"] as? String == "playing" && ($0["position"] as? Double ?? 0) > pausedAt + 60 }

        let duration = try XCTUnwrap(first["duration"] as? Double)
        XCTAssertGreaterThan(duration, 16)
        _ = try await page!.callAsyncJavaScript("""
            return await window.webkit.messageHandlers.oneplay.postMessage({op:'playback',version:1,action:'seek',item,seconds});
            """, arguments: ["item": first["item"]!, "seconds": duration - 16], in: nil, contentWorld: .page)
        let outgoing = try await waitForSnapshot { ($0["position"] as? Double ?? 0) >= duration - 16 && $0["state"] as? String == "playing" }
        weak let oldPage = page
        controller.detachPage()
        page = nil
        let incoming = try await waitForSnapshot {
            $0["item"] as? String != outgoing["item"] as? String && $0["state"] as? String == "playing" &&
                ($0["position"] as? Double ?? 0) >= 2
        }
        XCTAssertNil(oldPage)
        controller.loadPage()
        let attached = try await readyPage(in: controller)
        let title = try XCTUnwrap((incoming["path"] as? [String])?.last)
        XCTAssertTrue(title.contains("[03]") && title.contains("Another Brick"))
        let before = try XCTUnwrap(player.snapshot["position"] as? Double)
        let displayed = try await attached.callAsyncJavaScript("""
            const deadline = performance.now()+10000;
            while (document.querySelector('.footer-title')?.textContent !== title) {
                if(performance.now() > deadline) throw Error('Footer did not attach to the successor');
                await new Promise(resolve=>setTimeout(resolve,50));
            }
            document.querySelector('.footer-indicator').dispatchEvent(new MouseEvent('click',{bubbles:true}));
            document.querySelector('.footer-gripper').click();
            const expansion = document.querySelector('.expansion');
            await Promise.all(expansion.getAnimations().map(animation=>animation.finished));
            return {title:document.querySelector('.footer-title').textContent,
                    row:document.querySelector('#children .track-indicator')?.closest('.tree-row')?.querySelector('.row-name')?.textContent,
                    elapsed:document.querySelector('.scrubber-text span').textContent};
            """, arguments: ["title": title], in: nil, contentWorld: .page) as? [String: String]
        XCTAssertEqual(displayed?["row"], title)
        XCTAssertEqual(displayed?["title"], title)
        let clock = try XCTUnwrap(displayed?["elapsed"]?.components(separatedBy: " / ").first)
        let seconds = clock.split(separator: ":").compactMap { Double($0) }.reduce(0) { $0 * 60 + $1 }
        let after = try XCTUnwrap(player.snapshot["position"] as? Double)
        XCTAssertGreaterThanOrEqual(seconds, floor(before) - 1)
        XCTAssertLessThanOrEqual(seconds, ceil(after))
        print("Reattached after natural advance. Footer clock: \(displayed?["elapsed"] ?? "?"), native position: \(player.snapshot["position"] ?? "?")")
        let screen = try await attached.takeSnapshot(configuration: nil)
        let image = XCTAttachment(image: screen)
        image.name = "Shared footer after detached advance"
        image.lifetime = .keepAlways
        add(image)
    }
}
