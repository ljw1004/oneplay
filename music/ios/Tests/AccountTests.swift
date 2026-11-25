import XCTest
import WebKit
import AVFoundation
@testable import OnePlayMusic

@MainActor private final class TestIdentity: NativeIdentity {
    var home = "listener"
    var needsInteraction = false
    var beforeSilent: (() async -> Void)?
    var forceCount = 0
    var removed = 0

    func acquireSilent(home: String, force: Bool) async throws -> IdentityGrant {
        await beforeSilent?()
        if needsInteraction { throw NativeAccountError.interactionRequired }
        if force { forceCount += 1 }
        return IdentityGrant(homeID: self.home, accessToken: force ? "fresh" : "original")
    }

    func acquireInteractive(home: String?, presenting: UIViewController) async throws -> IdentityGrant {
        IdentityGrant(homeID: self.home, accessToken: "interactive")
    }

    func cancelInteractive() {}
    func removePrivateAccounts() throws { removed += 1 }
}

@MainActor final class AccountTests: XCTestCase {
    private var dir: URL!
    private var record: URL { dir.appendingPathComponent("binding") }

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try FileManager.default.removeItem(at: dir)
    }

    private func pair() throws {
        try AccountRecord(homeID: "listener", driveID: "library", cleanupPending: false).save(to: record)
    }

    /// A temporary unlinked file has the same lifetime as a completed URLSession download.
    private func response(_ request: URLRequest, status: Int = 200, data: Data) throws -> (HTTPURLResponse, FileHandle) {
        let file = dir.appendingPathComponent(UUID().uuidString)
        try data.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/2", headerFields: ["X-Test": "kept"])!,
                try FileHandle(forReadingFrom: file))
    }

    private let drive = Data(#"{"id":"library"}"#.utf8)
    private let batch = "https://graph.microsoft.com/v1.0/$batch"

    func testOfflineColdStartAndBothInterruptedCleanupPoints() async throws {
        try pair()
        let id = TestIdentity()
        let open = { [self] in
            try NativeAccount(recordFile: record, identity: id) { _ in
                XCTFail("Opening cached state and cleanup must take no network path")
                throw NativeAccountError.unavailable
            }
        }
        let first = try open()
        XCTAssertEqual(first.snapshot["driveID"] as? String, "library")
        try first.beginSignOut(theme: "dark")
        let afterMarker = try open()
        XCTAssertTrue(afterMarker.cleanupPending)
        XCTAssertEqual(afterMarker.cleanupTheme, "dark")
        XCTAssertFalse(afterMarker.snapshot["driveID"] is String)
        do {
            try await afterMarker.finishCleanup { throw NativeAccountError.unavailable }
            XCTFail("Interrupted cleanup must keep the marker")
        } catch NativeAccountError.unavailable {}
        let midway = try open()
        XCTAssertTrue(midway.cleanupPending)
        XCTAssertEqual(midway.cleanupTheme, "dark")
        try await midway.finishCleanup {}
        XCTAssertEqual(id.removed, 1)
        let clean = try open()
        XCTAssertFalse(clean.cleanupPending)
        XCTAssertFalse(clean.snapshot["driveID"] is String)
    }

    func testDiagnosticsReplayOnLaunchAndPullOnWake() async throws {
        let open = { [self] in try NativeAccount(recordFile: record, identity: TestIdentity()) { _ in throw URLError(.notConnectedToInternet) } }
        try open().diagnostics.record("Before launch")
        let account = try open()
        let controller = LibraryController(account: account, store: .nonPersistent())
        controller.loadViewIfNeeded()
        defer { controller.detachPage() }
        let page = try await readyPage(in: controller)
        // Use actual DOM updates as the completion signal, including when the pull won the race.
        func displayed(_ message: String, in page: WKWebView) async throws -> String {
            try await page.callAsyncJavaScript("""
                const el = document.querySelector('#native-log');
                if (!el.textContent.includes(message)) await new Promise((resolve,reject) => {
                    const observer = new MutationObserver(() => {
                        if (el.textContent.includes(message)) { clearTimeout(timer); observer.disconnect(); resolve(); }
                    });
                    const timer = setTimeout(() => { observer.disconnect(); reject(Error('No diagnostic event')); }, 5000);
                    observer.observe(el,{childList:true,subtree:true});
                });
                return el.textContent;
                """, arguments: ["message": message], in: nil, contentWorld: .page) as? String ?? ""
        }
        _ = try await displayed("Before launch", in: page)
        let first = try XCTUnwrap((try account.diagnostics.entries().last?["id"] as? String).flatMap(UUID.init(uuidString:)))
        account.diagnostics.record("While awake")
        _ = try await displayed("While awake", in: page)
        XCTAssertEqual(try account.diagnostics.entries(after: first).compactMap { $0["message"] as? String }, ["While awake"])
        account.diagnostics.onPending = nil
        account.diagnostics.record("Missed signal")
        controller.signalPendingDiagnostics()
        let resumed = try await displayed("Missed signal", in: page)
        XCTAssertEqual(resumed.components(separatedBy: "While awake").count, 2)
        page.reload()
        let replacement = try await readyPage(in: controller, excluding: page)
        let restored = try await displayed("Missed signal", in: replacement)
        XCTAssertEqual(restored, resumed)
        try account.diagnostics.clear()
        XCTAssertTrue(try open().diagnostics.entries().isEmpty)
    }

    func testWrongAccountAndChangedDriveDenyBeforeWrite() async throws {
        try pair()
        let id = TestIdentity()
        var network = 0
        let account = try NativeAccount(recordFile: record, identity: id) { [self] req in
            network += 1
            XCTAssertEqual(req.url?.path, "/v1.0/me/drive")
            return try response(req, data: Data(#"{"id":"some-other-drive"}"#.utf8))
        }
        let reply = try await account.request(message: ["url": batch, "id": UUID().uuidString, "method": "POST"])
        XCTAssertEqual(reply["status"] as? Int, 401)
        XCTAssertEqual(network, 1)
        id.needsInteraction = true
        id.home = "another-listener"
        do {
            _ = try await account.signIn(presenting: UIViewController())
            XCTFail("Different MSAL home ID cannot open the paired library")
        } catch NativeAccountError.wrongAccount {}
        XCTAssertEqual(network, 1)
        XCTAssertEqual(account.snapshot["driveID"] as? String, "library")
    }

    func testForceReplayHeadersStatusAndScopeOfBatchContentGrants() async throws {
        try pair()
        let id = TestIdentity()
        var requests: [URLRequest] = []
        let location = "https://content.example.test/object?ticket=disposable"
        let nested = "https://content.example.test/user-written?ticket=private"
        let account = try NativeAccount(recordFile: record, identity: id) { [self] req in
            requests.append(req)
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            if req.url?.host == "content.example.test" {
                XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
                XCTAssertNil(req.value(forHTTPHeaderField: "Cookie"))
                return try response(req, status: 204, data: Data())
            }
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Prefer"), "redeemSharingLink")
            XCTAssertEqual(req.httpBody, Data("test".utf8))
            XCTAssertEqual(req.cachePolicy, .reloadIgnoringLocalCacheData)
            if req.value(forHTTPHeaderField: "Authorization") == "Bearer original" {
                return try response(req, status: 401, data: Data())
            }
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer fresh")
            let body = ["responses": [
                ["id": "first", "status": 302, "headers": ["location": location]],
                ["id": "second", "status": 200, "body": ["status": 302, "headers": ["Location": nested]]]
            ]]
            return try response(req, data: JSONSerialization.data(withJSONObject: body))
        }
        let reply = try await account.request(message: ["url": batch, "id": UUID().uuidString, "method": "POST",
            "body": "test", "cache": "no-store", "headers": ["Prefer": "redeemSharingLink"]])
        XCTAssertEqual(reply["status"] as? Int, 200)
        XCTAssertEqual((reply["headers"] as? [String: String])?["X-Test"], "kept")
        XCTAssertEqual(id.forceCount, 1)
        let messages = try account.diagnostics.entries().compactMap { $0["message"] as? String }
        XCTAssertTrue(messages.contains { $0.contains("Graph HTTP 401") })
        XCTAssertTrue(messages.contains { $0.contains("MSAL silent forced ok") })
        XCTAssertTrue(messages.contains { $0.contains("401 replay HTTP 200") })
        XCTAssertFalse(messages.joined().contains("Bearer") || messages.joined().contains(location))
        let follow = try await account.request(message: ["url": location, "id": UUID().uuidString, "follow": true])
        XCTAssertEqual(follow["status"] as? Int, 204)
        XCTAssertEqual(follow["body"] as? String, "")
        let duplicate = try await account.request(message: ["url": location, "id": UUID().uuidString, "follow": true])
        XCTAssertEqual(duplicate["status"] as? Int, 204)
        account.detachView()
        for denied in [location, nested] {
            do {
                _ = try await account.request(message: ["url": denied, "id": UUID().uuidString, "follow": true])
                XCTFail("Only the original view can use a Graph-issued redirect")
            } catch NativeAccountError.invalidRequest {}
        }
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1.0/me/drive" }.compactMap {
            $0.value(forHTTPHeaderField: "Authorization")
        }, ["Bearer original", "Bearer fresh"])
    }

    /// The same MSAL home ID can supply a new grant. Before replaying a failed write, Graph must
    /// confirm its drive. A mismatch also closes both already-issued and still-arriving content.
    func testChangedDriveAt401ReplayRevokesFollowAndChunks() async throws {
        try pair()
        let location = "https://content.example.test/pending"
        let held = expectation(description: "Content follow started")
        var release: CheckedContinuation<Void, Never>?
        var writes: [String] = []
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            let bearer = req.value(forHTTPHeaderField: "Authorization")
            switch req.url?.lastPathComponent {
            case "drive":
                return try response(req, data: bearer == "Bearer original" ? drive : Data(#"{"id":"other-drive"}"#.utf8))
            case "$batch":
                return try response(req, data: JSONSerialization.data(withJSONObject: [
                    "responses": [["status": 302, "headers": ["Location": location]]]
                ]))
            case "large":
                return try response(req, data: Data(repeating: 9, count: GraphTransport.chunkSize + 1))
            case "pending":
                await withCheckedContinuation { release = $0; held.fulfill() }
                return try response(req, data: Data("stale content".utf8))
            default:
                XCTAssertEqual(req.httpMethod, "PUT")
                writes.append(bearer ?? "missing")
                return try response(req, status: bearer == "Bearer original" ? 401 : 200, data: Data())
            }
        }
        _ = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        let id = UUID().uuidString
        let large = try await account.request(message: ["url": "https://graph.microsoft.com/v1.0/me/drive/items/large", "id": id])
        XCTAssertEqual(large["chunked"] as? Bool, true)
        let follow = Task { try await account.request(message: ["url": location, "follow": true, "id": UUID().uuidString]) }
        await fulfillment(of: [held], timeout: 2)
        let write = try await account.request(message: ["url": "https://graph.microsoft.com/v1.0/me/drive/items/favorites",
                                                       "method": "PUT", "body": "[]", "id": UUID().uuidString])
        release?.resume()
        let late = try await follow.value
        XCTAssertEqual(writes, ["Bearer original"])
        for result in [write, late] {
            XCTAssertEqual(result["status"] as? Int, 401)
            XCTAssertEqual((result["headers"] as? [String: String])?["X-OnePlay-Account-Error"], "wrongAccount")
            XCTAssertEqual(result["body"] as? String, "")
        }
        XCTAssertThrowsError(try account.readChunk(id: id))
    }

    func testChunkAcknowledgementsAndDetachReleaseLargeIndex() async throws {
        try pair()
        let fixture = try JSONSerialization.data(withJSONObject: (0..<30_000).map { ["id": $0, "name": "Track 💿 \($0)"] })
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            try response(req, data: req.url?.path == "/v1.0/me/drive" ? drive : fixture)
        }
        let url = "https://graph.microsoft.com/v1.0/me/drive/items/library/content"
        let id = UUID().uuidString
        let reply = try await account.request(message: ["url": url, "id": id])
        XCTAssertEqual(reply["chunked"] as? Bool, true)
        XCTAssertNil(reply["body"])
        var recovered = Data()
        while true {
            let chunk = try account.readChunk(id: id)
            let data = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(chunk["body"] as? String)))
            XCTAssertLessThanOrEqual(data.count, 256 * 1024)
            recovered.append(data)
            if chunk["done"] as? Bool == true { break }
        }
        XCTAssertEqual(recovered, fixture)
        XCTAssertThrowsError(try account.readChunk(id: id))
        _ = try await account.request(message: ["url": url, "id": id])
        account.updateNetworkPath(offline: false, interfaces: [.wifi])
        account.updateNetworkPath(offline: false, interfaces: [.cellular])
        XCTAssertThrowsError(try account.readChunk(id: id))
        _ = try await account.request(message: ["url": url, "id": id])
        account.detachView()
        XCTAssertThrowsError(try account.readChunk(id: id))
    }

    func testTimeoutAbortDuringBackoffAndNoRetry() async throws {
        try pair()
        let called = expectation(description: "First 429")
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            switch req.url?.lastPathComponent {
            case "drive": return try response(req, data: drive)
            case "slow":
                try await Task.sleep(for: .seconds(10))
                return try response(req, data: Data())
            case "retry": called.fulfill()
            default: break
            }
            return try response(req, status: 429, data: Data())
        }
        let base = "https://graph.microsoft.com/v1.0/me/drive/items/"
        let timeout = try await account.request(message: ["url": base + "slow", "id": UUID().uuidString, "timeoutMs": 20])
        XCTAssertEqual(timeout["status"] as? Int, 504)
        let throttled = try await account.request(message: ["url": base + "noRetry", "id": UUID().uuidString, "retryOn429": false])
        XCTAssertEqual(throttled["status"] as? Int, 429)
        let id = UUID().uuidString
        let task = Task { try await account.request(message: ["url": base + "retry", "id": id, "retryOn429": true]) }
        await fulfillment(of: [called], timeout: 2)
        account.abort(id: id)
        do { _ = try await task.value; XCTFail("Abort must interrupt the 2 second backoff") }
        catch { XCTAssertEqual(NativeAccountError.classify(error), .cancelled) }
    }

    func testChangedAccountDetailsLatchAndBlockSubsequentWrite() async throws {
        try pair()
        var reads = 0
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            reads += 1
            XCTAssertEqual(req.httpMethod, "GET")
            return try response(req, data: reads == 1 ? drive : Data(#"{"id":"different-drive"}"#.utf8))
        }
        let mismatch = try await account.request(message: ["url": "https://graph.microsoft.com/v1.0/me/drive?$select=id,owner",
                                                            "id": UUID().uuidString])
        XCTAssertEqual(mismatch["status"] as? Int, 401)
        XCTAssertEqual((mismatch["headers"] as? [String: String])?["X-OnePlay-Account-Error"], "wrongAccount")
        let write = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        XCTAssertEqual(write["status"] as? Int, 401)
        XCTAssertEqual(reads, 2)
    }

    func testLateContentTimeoutKeepsAccountChallenge() async throws {
        try pair()
        let id = TestIdentity()
        let started = expectation(description: "Content GET entered URLSession")
        var release: CheckedContinuation<Void, Never>?
        let location = "https://cdn.example.test/file"
        let account = try NativeAccount(recordFile: record, identity: id) { [self] req in
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            if req.url?.host == "cdn.example.test" {
                await withCheckedContinuation { release = $0; started.fulfill() }
                throw URLError(.timedOut)
            }
            return try response(req, data: JSONSerialization.data(withJSONObject: [
                "responses": [["status": 302, "headers": ["Location": location]]]
            ]))
        }
        _ = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        let content = Task { try await account.request(message: ["url": location, "follow": true, "id": UUID().uuidString]) }
        await fulfillment(of: [started], timeout: 2)
        id.needsInteraction = true
        let challenged = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        XCTAssertEqual(challenged["status"] as? Int, 401)
        release?.resume()
        let expired = try await content.value
        XCTAssertEqual(expired["status"] as? Int, 504)
        XCTAssertEqual(account.snapshot["evidence"] as? String, "evidence:signed-out")
    }

    func testOlderSuccessfulGraphReadCannotClearNewAccountChallenge() async throws {
        try pair()
        let id = TestIdentity()
        let held = expectation(description: "An authorized Graph read is in flight")
        var release: CheckedContinuation<Void, Never>?
        let account = try NativeAccount(recordFile: record, identity: id) { [self] req in
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            await withCheckedContinuation { release = $0; held.fulfill() }
            return try response(req, data: Data())
        }
        let older = Task { try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString]) }
        await fulfillment(of: [held], timeout: 2)
        id.needsInteraction = true
        let challenge = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        XCTAssertEqual(challenge["status"] as? Int, 401)
        release?.resume()
        let stale = try await older.value
        XCTAssertNotEqual(stale["status"] as? Int, 200)
        XCTAssertEqual(account.snapshot["evidence"] as? String, "evidence:signed-out")
    }

    /// A duplicate satisfied callback on cellular must leave a verified sign-in eligible to commit.
    func testCellularPathRepeatDuringInteractiveDriveVerification() async throws {
        let started = expectation(description: "Drive verification started")
        var finish: CheckedContinuation<Void, Never>?
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] request in
            await withCheckedContinuation { finish = $0; started.fulfill() }
            return try response(request, data: drive)
        }
        account.updateNetworkPath(offline: false, interfaces: [.cellular])
        let signingIn = Task { try await account.signIn(presenting: UIViewController()) }
        await fulfillment(of: [started], timeout: 3)
        account.updateNetworkPath(offline: false, interfaces: [.cellular])
        finish?.resume()
        let state = try await signingIn.value
        XCTAssertEqual(state["driveID"] as? String, "library")
        XCTAssertTrue(FileManager.default.fileExists(atPath: record.path))
    }

    func testHeldProbeAndTokenCannotAdmitWritesAfterRouteChange() async throws {
        for holdProbe in [true, false] {
            try pair()
            let id = TestIdentity()
            let held = expectation(description: "Operation paused")
            var release: CheckedContinuation<Void, Never>?
            let pause = { await withCheckedContinuation { release = $0; held.fulfill() } }
            if !holdProbe { id.beforeSilent = pause }
            let account = try NativeAccount(recordFile: record, identity: id) { [self] req in
                XCTAssertEqual(req.url?.path, "/v1.0/me/drive")
                if holdProbe { await pause() }
                return try response(req, data: drive)
            }
            let write = Task { try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString]) }
            await fulfillment(of: [held], timeout: 2)
            account.updateNetworkPath(offline: false, interfaces: [.wifi])
            account.updateNetworkPath(offline: false, interfaces: [.cellular])
            release?.resume()
            let aborted = try await write.value
            XCTAssertEqual(aborted["status"] as? Int, 503)
        }
    }

    func testPlayerCancellationLeavesSilentRenewalToDrainAtLogout() async throws {
        try pair()
        let id = TestIdentity()
        let held = expectation(description: "MSAL callback pending")
        var release: CheckedContinuation<Void, Never>?
        id.beforeSilent = { await withCheckedContinuation { release = $0; held.fulfill() } }
        let account = try NativeAccount(recordFile: record, identity: id) { _ in
            XCTFail("A cancelled player must never send Graph a request")
            throw CancellationError()
        }
        let stopped = expectation(description: "Decoder worker released before the SDK completes")
        let player = Task {
            do { _ = try await account.media(driveID: "library", itemID: "track", forceRefresh: true); XCTFail("Expected cancellation") }
            catch { XCTAssertEqual(NativeAccountError.classify(error), .cancelled) }
            stopped.fulfill()
        }
        await fulfillment(of: [held], timeout: 2)
        player.cancel()
        await fulfillment(of: [stopped], timeout: 1)
        try account.beginSignOut()
        let teardown = expectation(description: "Private web store cleared")
        let cleanup = Task { try await account.finishCleanup { teardown.fulfill() } }
        await fulfillment(of: [teardown], timeout: 1)
        XCTAssertEqual(id.removed, 0)
        release?.resume()
        try await cleanup.value
        XCTAssertEqual(id.removed, 1)
    }

    #if DEBUG
    /// Run the shipping JS chunk adapter while the shipping MP3 decoder and render node are playing.
    /// ScaleTone.mp3 is seven seconds of generated 440 Hz PCM at low volume, encoded at 32 kbps.
    func testWebKitReads30kIndexDuringPlaybackAndDropsUnreadChunksOnReload() async throws {
        let children = Dictionary(uniqueKeysWithValues: (0..<30_000).map { ("Music 💿 \($0).mp3", ["id": String($0)]) })
        let fixture = try JSONSerialization.data(withJSONObject: ["kind": "MusicData", "count": 30_000,
                                                                   "folder": ["id": "album", "children": children]])
        func downloadChecks(_ event: String) -> (started: XCTestExpectation, cancelled: XCTestExpectation) {
            (started: expectation(description: "Graph request started before " + event),
             cancelled: expectation(description: "Graph request cancelled by " + event))
        }
        let reload = downloadChecks("reload"), signOut = downloadChecks("sign-out")
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            switch req.url?.path {
            case "/v1.0/me/drive": return try response(req, data: drive)
            case "/v1.0/me/drive/items/large-index/content": return try response(req, data: fixture)
            case "/v1.0/me/drive/items/reload", "/v1.0/me/drive/items/signout":
                let pending = req.url?.lastPathComponent == "reload" ? reload : signOut
                pending.started.fulfill()
                do { try await Task.sleep(for: .seconds(30)) }
                catch is CancellationError { pending.cancelled.fulfill(); throw CancellationError() }
                XCTFail("Retiring the page left a document-owned download running")
                return try response(req, data: Data())
            default: return try response(req, status: 404, data: Data())
            }
        }
        let capture = dir.appendingPathComponent("scale.caf")
        let player = NativePlayback(captureURL: capture) { _, _, _ in throw NativeAccountError.invalidRequest }
        let controller = LibraryController(account: account, store: .nonPersistent(), player: player)
        let host = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        host.addChild(controller)
        host.view.addSubview(controller.view)
        controller.didMove(toParent: host)
        defer {
            controller.detachPage()
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
        }
        let page = try await readyPage(in: controller)
        _ = try await page.callAsyncJavaScript("return await window.webkit.messageHandlers.oneplay.postMessage({op:'signIn'})",
                                               arguments: [:], in: nil, contentWorld: .page)
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        try player.startLocalFiles([file], nearEnd: true)
        addTeardownBlock { try await player.stopAndDrain() }
        let warm = ContinuousClock.now + .seconds(8)
        while player.status == "Preparing playback", ContinuousClock.now < warm { try await Task.sleep(for: .milliseconds(30)) }
        XCTAssertTrue(player.status.hasPrefix("Playing"), player.status)
        let response = try await page.callAsyncJavaScript("""
            const {createNativeLibrary} = await import('oneplay://app/music/dist/native-library.js');
            const bridge = window.webkit.messageHandlers.oneplay;
            let chunks = 0;
            const start = performance.now();
            const response = await createNativeLibrary({postMessage(m) {
                if (m.op === 'chunk') chunks++;
                return bridge.postMessage(m);
            }}).fetch('https://graph.microsoft.com/v1.0/me/drive/items/large-index/content', false);
            const index = await response.json();
            const ms = performance.now()-start;
            const {dbPut} = await import('oneplay://app/music/dist/db.js');
            await dbPut('index:library',index);
            localStorage.setItem('account_info',JSON.stringify({driveId:'library',displayName:'Fixture'}));
            return {rows:Object.keys(index.folder.children).length,last:index.folder.children['Music 💿 29999.mp3'].id,chunks,ms};
            """, arguments: [:], in: nil, contentWorld: .page)
        let result = try XCTUnwrap(response as? [String: Any])
        XCTAssertEqual(result["rows"] as? Int, 30_000)
        XCTAssertEqual(result["last"] as? String, "29999")
        let chunks = try XCTUnwrap(result["chunks"] as? Int)
        XCTAssertEqual(chunks, (fixture.count + GraphTransport.chunkSize - 1) / GraphTransport.chunkSize)
        XCTAssertTrue(player.status.hasPrefix("Playing"), player.status)
        let end = ContinuousClock.now + .seconds(10)
        while !player.status.hasPrefix("Finished"), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(player.status, "Finished 1 track(s)")
        let recording = try AVAudioFile(forReading: capture)
        let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: recording.processingFormat, frameCapacity: AVAudioFrameCount(recording.length)))
        try recording.read(into: pcm)
        let samples = UnsafeBufferPointer(start: try XCTUnwrap(pcm.floatChannelData)[0], count: Int(pcm.frameLength))
        let first = try XCTUnwrap(samples.firstIndex { abs($0) > 0.0001 })
        let last = try XCTUnwrap(samples.lastIndex { abs($0) > 0.0001 })
        var quiet = 0, longest = 0
        for sample in samples[first...last] {
            quiet = abs(sample) < 0.00001 ? quiet + 1 : 0
            longest = max(quiet, longest)
        }
        XCTAssertGreaterThan(Double(last-first)/recording.processingFormat.sampleRate, 6.8)
        XCTAssertLessThan(longest, 88) // A 2 ms interruption in the generated tone is detectable at this threshold.
        print("30k WebKit index: \(fixture.count) bytes; \(chunks) acknowledged chunks; \(result["ms"] ?? "?") ms; native tone \(last-first) frames; longest internal silence \(longest) frames")

        // Leave most of a second response unread. The replacement document must be unable to take
        // the old file handle, and must be able to reuse the ID for its own request.
        let id = UUID().uuidString
        let args: [String: Any] = ["id": id, "url": "https://graph.microsoft.com/v1.0/me/drive/items/large-index/content"]
        let pending = try await page.callAsyncJavaScript("""
            const b = window.webkit.messageHandlers.oneplay;
            const response = await b.postMessage({op:'request',id,url});
            const first = await b.postMessage({op:'chunk',id});
            return response.chunked && !first.done && first.body.length > 0;
            """, arguments: args, in: nil, contentWorld: .page)
        XCTAssertEqual(pending as? Bool, true)
        // Keep both outgoing views alive in Swift and give each document a repeating store write.
        let writer = """
            window.fixtureWriter = setInterval(() => localStorage.setItem('retiredWriter','running'), 10);
            localStorage.setItem('retiredWriter','running');
            true
            """
        _ = try await page.evaluateJavaScript(writer)
        func startHeldDownload(in page: WKWebView, event: String) async throws {
            _ = try await page.callAsyncJavaScript("""
                window.webkit.messageHandlers.oneplay.postMessage({op:'request',id:crypto.randomUUID(),
                    url:'https://graph.microsoft.com/v1.0/me/drive/items/'+event}).catch(()=>{});
                return true;
                """, arguments: ["event":event], in: nil, contentWorld: .page)
        }
        try await startHeldDownload(in: page, event: "reload")
        await fulfillment(of: [reload.started], timeout: 3)
        page.reload()
        await fulfillment(of: [reload.cancelled], timeout: 3)
        let replacement = try await readyPage(in: controller, excluding: page)
        let resultAfterReload = try await replacement.callAsyncJavaScript("""
            const b = window.webkit.messageHandlers.oneplay;
            let error = null;
            try { await b.postMessage({op:'chunk',id}); } catch (e) { error = e.message; }
            const fresh = await b.postMessage({op:'request',id,url});
            await b.postMessage({op:'abort',id});
            return {error, fresh:fresh.chunked};
            """, arguments: args, in: nil, contentWorld: .page)
        let after = try XCTUnwrap(resultAfterReload as? [String: Any])
        XCTAssertEqual(after["error"] as? String, "invalidRequest")
        XCTAssertEqual(after["fresh"] as? Bool, true)
        _ = try await replacement.evaluateJavaScript(writer)
        try await startHeldDownload(in: replacement, event: "signout")
        await fulfillment(of: [signOut.started], timeout: 3)
        _ = try await replacement.evaluateJavaScript("window.webkit.messageHandlers.oneplay.postMessage({op:'signOut'}).catch(()=>{}); true")
        await fulfillment(of: [signOut.cancelled], timeout: 3)
        let signedOut = try await readyPage(in: controller, excluding: replacement)
        for retained in [page, replacement] {
            let retired = try await retained.evaluateJavaScript("location.href === 'about:blank' && typeof window.fixtureWriter === 'undefined'")
            XCTAssertEqual(retired as? Bool, true, "The old document is still alive after sign-out")
        }
        let clean = try await signedOut.callAsyncJavaScript("""
            const state = await window.webkit.messageHandlers.oneplay.postMessage({op:'state'});
            const {dbGet} = await import('oneplay://app/music/dist/db.js');
            return {unbound:!state.driveID, writersCleared:!localStorage.getItem('retiredWriter'),
                    indexCleared:!await dbGet('index:library')};
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(clean as? [String: Bool], ["unbound":true, "writersCleared":true, "indexCleared":true])
        XCTAssertFalse(FileManager.default.fileExists(atPath: capture.path))
    }
    #endif

    func testPersistFirstSignInTimeAcrossSilentReconnect() async throws {
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] request in
            try response(request, data: drive)
        }
        let before = Date()
        let first = try await account.signIn(presenting: UIViewController())
        XCTAssertEqual(first["driveID"] as? String, "library")
        let readBinding = { [self] in try JSONDecoder().decode(AccountRecord.self, from: Data(contentsOf: record)) }
        let dayOne = try XCTUnwrap(try readBinding().firstSignIn)
        XCTAssertGreaterThanOrEqual(dayOne, before)
        _ = try await account.signIn(presenting: UIViewController())
        XCTAssertEqual(try readBinding().firstSignIn, dayOne)
    }

    func testRedirectsStripCredentialsOnOriginChange() {
        let graph = URL(string: batch)!
        var original = URLRequest(url: graph)
        original.setValue("Bearer test-only", forHTTPHeaderField: "Authorization")
        let transport = GraphTransport()
        let task = URLSession.shared.dataTask(with: original)
        defer { task.cancel() }
        let redirect = HTTPURLResponse(url: graph, statusCode: 302, httpVersion: "HTTP/2", headerFields: nil)!
        let foreign = URL(string: "https://content.example.test/object")!
        var proposed = original
        proposed.url = foreign
        proposed.setValue("test-private", forHTTPHeaderField: "X-Secret")
        transport.urlSession(.shared, task: task, willPerformHTTPRedirection: redirect, newRequest: proposed) { request in
            XCTAssertEqual(request?.url, foreign)
            XCTAssertNil(request?.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request?.value(forHTTPHeaderField: "X-Secret"))
            XCTAssertNil(request?.httpBody)
        }
        proposed.httpMethod = "POST"
        proposed.httpBody = Data("test-private".utf8)
        transport.urlSession(.shared, task: task, willPerformHTTPRedirection: redirect, newRequest: proposed) { request in
            XCTAssertNil(request)
        }
    }

    func testGraphOriginBoundary() {
        XCTAssertTrue(GraphTransport.isGraph(URL(string: batch)!))
        for malformed in ["https://graph.microsoft.com@other.test/v1.0/me", "http://graph.microsoft.com/v1.0/me",
                          "https://graph.microsoft.com:444/v1.0/me", "https://graph.microsoft.com/v1.0/%2e%2e/beta/me",
                          "https://graph.microsoft.com/beta/me", "https://graph.microsoft.com/v1.00/me"] {
            XCTAssertFalse(GraphTransport.isGraph(URL(string: malformed)!))
        }
    }
}
