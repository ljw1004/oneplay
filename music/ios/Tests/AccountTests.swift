import os
import XCTest
import WebKit
import AVFoundation
@testable import OnePlayMusic

@MainActor private final class TestIdentity: NativeIdentity {
    var home = "listener"
    var needsInteraction = false
    var ordinaryToken = "original"
    var beforeSilent: (() async -> Void)?
    var forceCount = 0
    var removed = 0

    func acquireSilent(home: String, force: Bool) async throws -> IdentityGrant {
        await beforeSilent?()
        if needsInteraction { throw NativeAccountError.interactionRequired }
        if force { forceCount += 1 }
        return IdentityGrant(homeID: self.home, accessToken: force ? "fresh" : ordinaryToken)
    }

    func acquireInteractive(home: String?, presenting: UIViewController) async throws -> IdentityGrant {
        IdentityGrant(homeID: self.home, accessToken: "interactive")
    }

    func cancelInteractive() {}
    func removePrivateAccounts() throws { removed += 1 }
}

/// A signed URL works until the fixture rejects it. Graph and CDN request counts are independent.
private final class TestAudioCDN: URLProtocol {
    static let fixture = OSAllocatedUnfairLock(initialState: (song: Data(), expired: false, paths: [String]()))
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "audio.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!
        let (song, denied) = Self.fixture.withLock {
            $0.paths.append(url.path)
            return ($0.song, $0.expired && url.path == "/B/2")
        }
        let limits = (request.value(forHTTPHeaderField: "Range") ?? "").dropFirst(6).split(separator: "-").compactMap { Int($0) }
        guard limits.count == 2, 0 <= limits[0], limits[0] <= limits[1], limits[1] < song.count else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let bytes = denied ? Data() : song.subdata(in: limits[0]..<limits[1]+1)
        let headers = ["Content-Length": String(bytes.count), "Content-Range": "bytes \(limits[0])-\(limits[1])/\(song.count)"]
        let reply = HTTPURLResponse(url: url, statusCode: denied ? 403 : 206, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
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

    /// Drive the actual favorite menu against the native transfer delegate, then replace WebKit
    /// without network and start the same favorite through the library's Play control.
    func testBundledPinActionBarAndOfflineReopen() async throws {
        let tone = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        let size = try Data(contentsOf: tone).count
        let cloud = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "SharedFolderPin", withExtension: "json")))
        var cloudReads = 0
        var graphOffline = false
        var releaseShareMedia: CheckedContinuation<Void, Never>?
        var holdShareMedia = true
        defer { releaseShareMedia?.resume() }
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            if graphOffline { throw URLError(.notConnectedToInternet) }
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            if req.url?.path.hasPrefix("/v1.0/shares/") == true {
                let result = req.url?.lastPathComponent == "driveItem"
                    ? #"{"id":"root","name":"Shared music","folder":{},"parentReference":{"driveId":"remote"}}"#
                    : #"{"id":"token"}"#
                return try response(req,data:Data(result.utf8))
            }
            if req.url?.path.hasSuffix("/favorites.json:/content") == true && req.httpMethod == "GET" {
                cloudReads += 1
                return try response(req, data: cloud)
            }
            if req.url?.path == "/v1.0/$batch" {
                let cached = #"{"responses":[{"id":"cache-root","status":200,"body":{"kind":"MusicData","schemaVersion":1,"size":20,"count":1,"folder":{"id":"root","children":{"Concert":{"id":"concert","children":{"Overture.mp3":{"id":"c"}}}}}}},{"id":"children-root","status":200,"body":{"value":[]}}]}"#
                return try response(req, data: Data(cached.utf8))
            }
            if req.url?.path == "/v1.0/drives/remote/items/root" {
                return try response(req, data: Data(#"{"id":"root","size":20,"folder":{}}"#.utf8))
            }
            if let id = req.url?.lastPathComponent, ["a", "b", "c"].contains(id) {
                if id == "c" && holdShareMedia { await withCheckedContinuation { releaseShareMedia = $0 } }
                let unreadable = id == "b"
                let media: [String: Any] = ["id": id, "size": unreadable ? 3 : size, "eTag": "v",
                    "@microsoft.graph.downloadUrl": unreadable ? "https://pin.test/not-audio" : "https://pin.test/tone"]
                return try response(req, data: JSONSerialization.data(withJSONObject: media))
            }
            return try response(req, status: 404, data: Data())
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let webStore = WKWebsiteDataStore.nonPersistent()
        var controller = LibraryController(account: account, store: webStore, pinConfiguration: config)
        let host = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        func attach() {
            host.addChild(controller)
            host.view.addSubview(controller.view)
            controller.didMove(toParent: host)
        }
        func detach() {
            controller.detachPage()
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
        }
        attach()
        defer { detach() }
        var page = try await readyPage(in: controller)
        _ = try await page.callAsyncJavaScript("""
            const {dbPut} = await import('./dist/db.js');
            localStorage.setItem('oneplay_music_debug_enabled', '1');
            localStorage.setItem('account_info', JSON.stringify({driveId:'library',displayName:'Listener'}));
            await dbPut('index:library',{kind:'MusicData',schemaVersion:1,count:2,size:20,folder:{id:'root',children:{Books:{id:'books',
                children:{Dune:{id:'dune',children:{'First.mp3':{id:'a'},'Second.mp3':{id:'b'}}}}}}}});
            await dbPut('shares',{version:1,updatedAt:1,shares:[{id:'connection',shareId:'token',rootKey:'share:token',
                driveId:'remote',rootItemId:'root',name:'Shared music',addedAt:1,updatedAt:1}]});
            await dbPut('index-share:token',{kind:'MusicData',schemaVersion:1,count:1,size:20,folder:{id:'root',children:{
                Concert:{id:'concert',children:{'Overture.mp3':{id:'c'}}}}}});
            await dbPut('favorites',{version:1,updatedAt:1,favorites:[]});
            """, arguments: [:], in: nil, contentWorld: .page)
        _ = try await account.signIn(presenting: controller)
        page.reload()
        page = try await readyPage(in: controller, excluding: page)
        // This exact document is a captured upload from the isolated PWA folder fixture.
        // The first native Graph pull restores the intent while this device has no shared file.
        let connection = try await page.callAsyncJavaScript("""
            const favorites = window._testFavorites;
            await favorites.pullFavoritesFromOneDrive();
            const pin = favorites.getFolderPins().find(pin => pin.sourceRootKey === 'share:token');
            await favorites.add({kind:'playlist',id:'reader',name:'Offline album',hasPrivatePlayback:false,members:[
                {driveId:'library',sourceRootKey:'library',itemId:'a',isFolder:false,path:['Books','Dune','First.mp3']}]});
            return pin?.connectionId;
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertGreaterThan(cloudReads, 0)
        XCTAssertEqual(connection as? String, "connection")
        XCTAssertFalse(controller.pins.completeKeys.contains("remote:c"))
        holdShareMedia = false
        releaseShareMedia?.resume()
        releaseShareMedia = nil
        func openDialog() async throws {
            _ = try await page.callAsyncJavaScript("""
                if (!window._testTree) throw new Error('Missing library: '+JSON.stringify(window.__ONEPLAY_MUSIC_LOGS?.slice(-18)));
                window._testTree.setSelectedPath(['OnePlay Music']);
                const row = [...document.querySelectorAll('.tree-row')].find(row => row.textContent.includes('Offline album'));
                if (!row) throw new Error('Missing favorite: ' + document.body.innerText.slice(0,600));
                row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
                const action = [...document.querySelectorAll('.action-dropdown button')].find(b => /available offline/i.test(b.textContent));
                action.click();
                """, arguments: [:], in: nil, contentWorld: .page)
        }
        try await openDialog()
        _ = try await page.evaluateJavaScript("document.querySelector('.modal .modal-cancel').click()")
        // A successful account request is native signed-in evidence, even when other sync routes are unavailable.
        _ = try await account.media(driveID: "library", itemID: "a")
        let storage = try XCTUnwrap(account.openPlaybackStore())
        struct Owners: Decodable { var owners: [String: PinOwner] }
        func waitForFiles(_ expected: Set<String>) async throws {
            let deadline = ContinuousClock.now + .seconds(8)
            while controller.pins.completeKeys != expected, .now < deadline { try await Task.sleep(for: .milliseconds(25)) }
            XCTAssertEqual(controller.pins.completeKeys, expected, "Native pin inventory: \(controller.pins.snapshot(after:nil))")
        }
        try await waitForFiles(["library:a", "remote:c"])
        // The album has one exclusive file. Its appearance proves the bundled folder
        // action installed a native owner independently of the already-downloaded playlist.
        func confirmFolderAction(parent: [String], child: String, action: String) async throws {
            _ = try await page.callAsyncJavaScript("""
                window._testTree.setSelectedPath(parent);
                const row = [...document.querySelectorAll('#children .tree-row')].find(r => r.querySelector('.row-name').textContent === child);
                const touch = {pointerType:'touch',pointerId:7,isPrimary:true,button:0,bubbles:true};
                row.dispatchEvent(new PointerEvent('pointerdown', touch));
                const holdDeadline = performance.now() + 3000;
                while (!document.body.classList.contains('select-mode')) {
                    if (performance.now() > holdDeadline) throw Error('Touch hold did not select ' + child);
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                document.dispatchEvent(new PointerEvent('pointerup', touch));
                if (!document.body.classList.contains('select-mode')) throw Error('Touch release cleared selection');
                const menu = [...document.querySelectorAll('.action-dropdown button')];
                const status = action === 'Make available offline' ? 'Make available offline' : 'Available offline…';
                if (menu.length !== 1 || menu[0].textContent !== status) throw Error('Unexpected folder status menu');
                menu[0].click();
                const modal = document.querySelector('.modal');
                const choices = [...modal.querySelectorAll('button')];
                choices.find(b => b.textContent.trim() === action).click();
                const deadline = performance.now() + 4000;
                while (modal.isConnected) {
                    if (performance.now() > deadline) throw Error(modal.innerText);
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                """, arguments: ["parent": parent, "child": child, "action": action], in: nil, contentWorld: .page)
        }
        let drive = ["OnePlay Music","library"]
        try await confirmFolderAction(parent: drive + ["Books"], child: "Dune", action: "Make available offline")
        _ = try await page.callAsyncJavaScript("""
            const row = [...document.querySelectorAll('#children .tree-row')].find(r => r.querySelector('.row-name').textContent === 'Dune');
            row.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'mouse',pointerId:1,isPrimary:true,button:2,bubbles:true}));
            row.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));
            document.querySelector('.action-dropdown button').click();
            const modal = document.querySelector('.modal'), deadline = performance.now() + 8000;
            while (!modal.querySelector('.offline-progress').textContent.includes('✓')) {
                if (performance.now() > deadline) throw Error(modal.innerText);
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            if (modal.querySelector('.offline-warning').textContent) throw Error(modal.innerText);
            """, arguments: [:], in: nil, contentWorld: .page)
        let complete = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        complete.name = "Both indexed recordings available offline"
        complete.lifetime = .keepAlways
        add(complete)
        _ = try await page.evaluateJavaScript("document.querySelector('.modal-close').click()")
        try await waitForFiles(["library:a", "library:b", "remote:c"])
        XCTAssertEqual(try Data(contentsOf: storage.pinURL("library:b", suffix: "mp3")), Data([1,2,3]))
        let partialCrumbs = try await page.callAsyncJavaScript("""
            return [...document.querySelectorAll('#breadcrumbs .offline-badge.partial')].map(badge => {
                const dots = [...badge.querySelector('path').getAttribute('d').matchAll(/M([\\d.]+) ([\\d.]+)h0/g)]
                    .map(([,x,y]) => [Number(x),Number(y)]);
                if (!dots.length || !dots.every(([x,y]) => dots.some(([a,b]) => a === 16-x && b === y)))
                    throw Error('The dotted arrow is asymmetric');
                return badge.closest('.tree-row').querySelector('.row-name').textContent;
            });
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(partialCrumbs as? [String], ["Books"])
        let albumCrumbs = try await page.callAsyncJavaScript("""
            window._testTree.setSelectedPath(['OnePlay Music','library','Books','Dune']);
            return [...document.querySelectorAll('#breadcrumbs .offline-badge')].map(badge =>
                [badge.closest('.tree-row').querySelector('.row-name').textContent,badge.classList.contains('partial')]);
            """, arguments:[:], in:nil, contentWorld:.page)
        let arrows = try XCTUnwrap(albumCrumbs as? [[Any]])
        XCTAssertEqual(arrows.count,1)
        XCTAssertEqual(arrows.first?.first as? String,"Dune")
        XCTAssertEqual(arrows.first?.last as? Bool,false)
        graphOffline = true
        account.updateNetworkPath(offline: true, interfaces: [])
        try await confirmFolderAction(parent: drive, child: "Books", action: "Make unavailable offline")
        try await waitForFiles(["library:a", "remote:c"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: storage.pinURL("library:b", suffix: "mp3").path))

        // This device still has the share and its pin, but has lost the cached listing.
        _ = try await page.callAsyncJavaScript("""
            const {dbDelete} = await import('./dist/db.js');
            await dbDelete('index-share:token');
            """, arguments: [:], in: nil, contentWorld: .page)
        detach()
        await controller.pins.unbindAndCancel()
        try await controller.player?.stopAndDrain()
        controller = LibraryController(account: account, store: webStore, pinConfiguration: config)
        attach()
        page = try await readyPage(in: controller)
        // Wait for the unresolved owner to reach Swift before checking the retained audio.
        let shareOwner = #"folder:["share:token","connection","concert"]"#
        let deadline = ContinuousClock.now + .seconds(6)
        var saved: PinOwner?
        repeat {
            saved = try storage.read(Owners.self, "pins")?.owners[shareOwner]
            if saved?.sources.isEmpty == true { break }
            try await Task.sleep(for: .milliseconds(25))
        } while .now < deadline
        XCTAssertEqual(saved?.sources, [:])
        XCTAssertEqual(saved?.retained, ["remote:c"])
        try await waitForFiles(["library:a", "remote:c"])
        XCTAssertEqual(try Data(contentsOf: storage.pinURL("remote:c", suffix: "mp3")), try Data(contentsOf: tone))
        try await openDialog()
        let ready = ContinuousClock.now + .seconds(3)
        var progress = ""
        repeat {
            progress = try await page.evaluateJavaScript("document.querySelector('.offline-progress').textContent") as? String ?? ""
            if progress.contains("✓") { break }
            try await Task.sleep(for: .milliseconds(25))
        } while .now < ready
        XCTAssertTrue(progress.contains("1 track") && progress.contains("✓"), progress)
        let shot = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        shot.name = "Native offline favorite after WebKit relaunch"
        shot.lifetime = .keepAlways
        add(shot)
        _ = try await page.callAsyncJavaScript("""
            document.querySelector('.modal-close').click();
            await window._testTree.onPlayClick(['OnePlay Music','fav:reader']);
            """, arguments: [:], in: nil, contentWorld: .page)
        let play = ContinuousClock.now + .seconds(5)
        while controller.player?.snapshot["state"] as? String != "playing", .now < play { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertEqual(controller.player?.snapshot["state"] as? String, "playing", controller.player?.status ?? "")
        _ = try await page.evaluateJavaScript("document.querySelector('.footer-gripper').click()")
        let rail = "document.querySelector('.audio-ranges > :nth-child(2) .audio-range-rail.offline')"
        let blue = ContinuousClock.now + .seconds(4)
        while try await page.evaluateJavaScript("!!" + rail) as? Bool != true, .now < blue {
            try await Task.sleep(for: .milliseconds(25))
        }
        let color = try await page.evaluateJavaScript("getComputedStyle(" + rail + ").backgroundColor") as? String
        XCTAssertEqual(color, "rgb(43, 101, 148)")
        let label = try await page.evaluateJavaScript(rail + ".getAttribute('aria-label')") as? String
        XCTAssertTrue(label?.contains("\(size) bytes available offline") == true)
        let ranges = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        ranges.name = "Expanded player with complete offline file"
        ranges.lifetime = .keepAlways
        add(ranges)
        // The share cannot enumerate its album without a listing.
        let blocked = try await page.callAsyncJavaScript("""
            window._testTree.setSelectedPath(['OnePlay Music']);
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline) {
                const share = [...document.querySelectorAll('#children .tree-row')].find(r => r.textContent.includes('Shared music'));
                if (share?.querySelector('.offline-badge.partial.paused')) return 'paused';
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            return [...document.querySelectorAll('#children .tree-row')].map(row => row.textContent+':'+row.querySelector('.offline-badge')?.className).join(', ') + ' ' + window._testAuth.getEvidence();
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(blocked as? String, "paused")
        XCTAssertEqual(controller.pins.completeKeys, ["library:a","remote:c"])

        graphOffline = false
        account.updateNetworkPath(offline: false, interfaces: [.wifi])
        _ = try await account.media(driveID:"library", itemID:"a", lookup:.fresh)
        // Disconnect and redeem the same link through Settings. The new UUID must
        // start without the previous album's badge or native owner, even though
        // the Graph response describes the identical physical album and recording.
        let replacement = try await page.callAsyncJavaScript("""
            async function confirm(selector) {
                const modal = document.querySelector('.modal');
                modal.querySelector(selector).click();
                const until = performance.now()+8000;
                while (modal.isConnected) {
                    if (performance.now()>until) throw Error(modal.innerText);
                    await new Promise(r=>setTimeout(r,20));
                }
            }
            window._testTree.onSettingsClick();
            document.querySelector('.settings-share-trash').click();
            await confirm('.modal-danger');
            document.querySelector('.settings-share-add').click();
            document.querySelector('.modal input').value='https://example.test/same-link';
            await confirm('.modal-confirm');
            document.querySelector('.settings-close').click();
            const share=window._testShares.getAll()[0], until=performance.now()+8000;
            while (!window._testTree.getRoots().get(share.rootKey)?.folder?.children.Concert) {
                if (performance.now()>until) throw Error('Reconnected album did not appear: '+JSON.stringify(window.__ONEPLAY_MUSIC_LOGS.slice(-20)));
                await new Promise(r=>setTimeout(r,20));
            }
            window._testTree.setSelectedPath(['OnePlay Music',share.rootKey]);
            const row=[...document.querySelectorAll('#children .tree-row')].find(r=>r.querySelector('.row-name').textContent==='Concert');
            if (!row || row.querySelector('.offline-badge') || window._testFavorites.getFolderPins().length)
                throw Error('The reconnected album inherited an offline setting');
            return [share.shareId,share.id];
            """, arguments:[:], in:nil, contentWorld:.page)
        let replacementIDs = try XCTUnwrap(replacement as? [String])
        XCTAssertEqual(replacementIDs.first,"token")
        XCTAssertNotEqual(replacementIDs.last,"connection")
        try await waitForFiles(["library:a"])
        XCTAssertEqual(Set(try XCTUnwrap(storage.read(Owners.self,"pins")).owners.keys),["keep","reader"])
        XCTAssertEqual(try Data(contentsOf:storage.pinURL("library:a", suffix: "mp3")),try Data(contentsOf:tone))
        XCTAssertFalse(FileManager.default.fileExists(atPath:storage.pinURL("remote:c", suffix: "mp3").path))
        // Remove the unrelated cross-device fixtures, leaving the playing playlist as
        // the sole native owner. Exercise its final removal through the visible dialog.
        graphOffline = true
        account.updateNetworkPath(offline:true, interfaces:[])
        _ = try await page.callAsyncJavaScript("""
            const favorites = window._testFavorites;
            await favorites.setOfflinePin('keep',undefined);
            await window._testTree.onPlayClick(['OnePlay Music','fav:reader']);
            """, arguments:[:], in:nil, contentWorld:.page)
        try await waitForFiles(["library:a"])
        XCTAssertEqual(Set(try XCTUnwrap(storage.read(Owners.self,"pins")).owners.keys), ["reader"])
        let player = try XCTUnwrap(controller.player)
        let playing = ContinuousClock.now + .seconds(6)
        while player.snapshot["state"] as? String != "playing", .now < playing { try await Task.sleep(for:.milliseconds(20)) }
        try await openDialog()
        XCTAssertEqual(player.snapshot["state"] as? String,"playing")
        XCTAssertTrue(player.holdsPin("library:a"))
        let unmarked = try await page.callAsyncJavaScript("""
            const modal = document.querySelector('.modal');
            const remove = [...modal.querySelectorAll('button')].find(button => !button.hidden && button.textContent === 'Make unavailable offline');
            remove.click();
            const deadline = performance.now()+6000;
            while (modal.isConnected) {
                if (performance.now()>deadline) throw Error(modal.innerText);
                await new Promise(r=>setTimeout(r,20));
            }
            const row = [...document.querySelectorAll('#children .tree-row')].find(r=>r.querySelector('.row-name').textContent==='Offline album');
            return !!row && !row.querySelector('.offline-badge') && !window._testFavorites.getAll().find(f=>f.id==='reader').offlinePin;
            """, arguments:[:], in:nil, contentWorld:.page)
        XCTAssertEqual(unmarked as? Bool,true)
        let committed = ContinuousClock.now + .seconds(4)
        while try storage.read(Owners.self,"pins")?.owners.isEmpty != true, .now < committed { try await Task.sleep(for:.milliseconds(20)) }
        let lastOwners = try XCTUnwrap(storage.read(Owners.self,"pins")).owners
        XCTAssertTrue(lastOwners.isEmpty, "Final native owners: \(lastOwners)")
        XCTAssertTrue(controller.pins.completeKeys.isEmpty, "Completed files after dialog removal: \(controller.pins.completeKeys)")
        let lastFile = storage.pinURL("library:a", suffix: "mp3")
        XCTAssertTrue(player.holdsPin("library:a"))
        XCTAssertTrue(FileManager.default.fileExists(atPath:lastFile.path))
        let end = ContinuousClock.now + .seconds(16)
        while FileManager.default.fileExists(atPath:lastFile.path), .now < end { try await Task.sleep(for:.milliseconds(25)) }
        // The now-unavailable playing occurrence can disappear from the visual
        // queue on completion. The native decoder still records its natural finish.
        XCTAssertTrue(player.status.contains("Finished"),player.status)
        XCTAssertFalse(FileManager.default.fileExists(atPath:lastFile.path))
        XCTAssertEqual(controller.pins.snapshot(after:nil)["total"] as? Int,0)
        try await controller.player?.stopAndDrain()
    }

    /// Observe the packaged WebKit shell while real native downloads complete and the listener navigates.
    func testBundled500TrackPinIn30kLibrary() async throws {
        let tone = try XCTUnwrap(Bundle(for: Self.self).url(forResource:"ScaleTone", withExtension:"mp3"))
        let size = try Data(contentsOf:tone).count
        var hold = true
        var pending = [CheckedContinuation<Void,Never>]()
        defer { for request in pending { request.resume() } }
        let account = try NativeAccount(recordFile:record, identity:TestIdentity()) { [self] req in
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data:drive) }
            if let id = req.url?.lastPathComponent, id == "probe" || id.hasPrefix("song-") {
                if hold && id != "probe" { await withCheckedContinuation { pending.append($0) } }
                let media: [String:Any] = ["id":id, "size":size, "eTag":"v", "@microsoft.graph.downloadUrl":"https://pin.test/tone"]
                return try response(req, data:JSONSerialization.data(withJSONObject:media))
            }
            return try response(req, status:404, data:Data())
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let controller = LibraryController(account:account, store:.nonPersistent(), pinConfiguration:config)
        let host = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        host.addChild(controller)
        host.view.addSubview(controller.view)
        controller.didMove(toParent:host)
        defer {
            controller.detachPage()
            controller.willMove(toParent:nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
        }
        var page = try await readyPage(in:controller)
        _ = try await page.callAsyncJavaScript("""
            const {dbPut} = await import('./dist/db.js');
            localStorage.setItem('account_info', JSON.stringify({driveId:'library',displayName:'Listener'}));
            const folders = {Archive:{id:'archive',children:{}},Collection:{id:'collection',children:{}}};
            for (let i=0; i<30000; i++) {
                const artist = 'Artist '+Math.floor(i/50);
                const parent = i>=500 ? folders.Archive : folders.Collection.children[artist] ??= {id:artist,children:{}};
                const album = i>=500 ? 50+Math.floor((i-500)/500) : Math.floor(i/10);
                const folder = parent.children['Album '+album] ??= {id:'album-'+album,children:{}};
                folder.children['Song '+i+'.mp3'] = {id:'song-'+i};
            }
            await dbPut('index:library',{kind:'MusicData',schemaVersion:1,count:30000,size:30000*size,folder:{id:'root',children:folders}});
            """, arguments:["size":size], in:nil, contentWorld:.page)
        _ = try await account.signIn(presenting:controller)
        page.reload()
        page = try await readyPage(in:controller, excluding:page)
        _ = try await account.media(driveID:"library",itemID:"probe")
        let commit = try await page.callAsyncJavaScript("""
            window._testTree.setSelectedPath(['OnePlay Music','library','Collection']);
            const pin = album => window._testFavorites.setFolderPinned({driveId:'library',sourceRootKey:'library',
                itemId:'album-'+album,path:['Collection','Artist '+Math.floor(album/5),'Album '+album],isFolder:true},true);
            for (let n=0; n<49; n++) await pin(n);
            const start = performance.now();
            await pin(49);
            const elapsed = performance.now()-start;
            let notifications = 0, last = performance.now(), maxGap = 0;
            window.addEventListener('oneplay-pins', () => notifications++);
            const timer = setInterval(() => {
                const now = performance.now();
                maxGap = Math.max(maxGap,now-last);
                last = now;
            },5);
            window.finishProgressSample = () => { clearInterval(timer); return {notifications,maxGap}; };
            return elapsed;
            """, arguments:[:], in:nil, contentWorld:.page)
        XCTAssertTrue(controller.pins.completeKeys.isEmpty)
        hold = false
        for request in pending { request.resume() }
        pending.removeAll()
        // Navigate while some, but not all, files are present on disk.
        let downloading = ContinuousClock.now + .seconds(30)
        while controller.pins.completeKeys.count < 10, .now < downloading { try await Task.sleep(for:.milliseconds(20)) }
        XCTAssertGreaterThanOrEqual(controller.pins.completeKeys.count,10)
        XCTAssertLessThan(controller.pins.completeKeys.count,500)
        let result = try await page.callAsyncJavaScript("""
            const row = (root,name) => [...document.querySelectorAll(root+' .tree-row')].find(r=>r.querySelector('.row-name').textContent===name);
            const tree = window._testTree;
            const start = performance.now();
            row('#children','Artist 0').querySelector('.row-name').click();
            if(tree.getSelectedPath().at(-1)!=='Artist 0' || !row('#children','Album 0')) throw Error('Artist navigation failed');
            row('#children','Album 0').querySelector('.row-name').click();
            if(tree.getSelectedPath().at(-1)!=='Album 0' || !row('#children','Song 0.mp3')) throw Error('Album navigation failed');
            const navMs = performance.now()-start;
            tree.setSelectedPath(['OnePlay Music','library','Collection']);
            const deadline = performance.now()+120000;
            while (document.querySelectorAll('#children .offline-badge.partial.complete').length!==10) {
                if (performance.now()>deadline) throw Error('Artist progress never settled: '+document.body.innerText.slice(0,600));
                await new Promise(resolve=>setTimeout(resolve,20));
            }
            return {...window.finishProgressSample(), navMs};
            """, arguments:[:], in:nil, contentWorld:.page)
        let metrics = try XCTUnwrap(result as? [String:Double])
        XCTAssertGreaterThan(metrics["notifications"] ?? 0, 1)
        XCTAssertEqual(controller.pins.completeKeys, Set((0..<500).map { "library:song-\($0)" }))
        print("50 albums, 500-of-30k native pin: last commit \(commit ?? "") ms; progress notifications and timer/navigation ms \(metrics); bytes \(500*size)")
        // The playlist independently retains one file. Removing Collection uses the same
        // committed action as its dialog; leave the tree visible to accept a navigation tap.
        _ = try await page.callAsyncJavaScript("""
            const favorites = window._testFavorites;
            await favorites.add({kind:'playlist',id:'survivor',name:'Survivor',hasPrivatePlayback:false,members:[
                {driveId:'library',sourceRootKey:'library',itemId:'song-0',isFolder:false,path:['Collection','Artist 0','Album 0','Song 0.mp3']}]});
            await favorites.setOfflinePin('survivor',{paused:false});
            window._testTree.setSelectedPath(['OnePlay Music','library']);
            """, arguments:[:], in:nil, contentWorld:.page)
        let mainActorGaps = Task { @MainActor in
            var last = ContinuousClock.now, longest = Duration.zero
            while !Task.isCancelled {
                do { try await Task.sleep(for:.milliseconds(1)) } catch { break }
                let now = ContinuousClock.now
                longest = max(longest,last.duration(to:now))
                last = now
            }
            return max(longest,last.duration(to:.now))
        }
        defer { mainActorGaps.cancel() }
        let cleanup = try await page.callAsyncJavaScript("""
            const tree = window._testTree, start = performance.now();
            let last = start, maxGap = 0;
            const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap,now-last); last = now; };
            const timer = setInterval(tick,1);
            try {
                const removing = window._testFavorites.setFolderPinned({driveId:'library',sourceRootKey:'library',
                    itemId:'collection',path:['Collection'],isFolder:true},false,tree.getRoots()).then(()=>performance.now()-start);
                await new Promise(resolve=>setTimeout(resolve,0));
                const navAt = performance.now();
                const row = [...document.querySelectorAll('#children .row-name')].find(r=>r.textContent==='Collection');
                row.click();
                if(tree.getSelectedPath().at(-1)!=='Collection') throw Error('Folder navigation failed');
                document.querySelector('.row-icon-search').click();
                document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
                if (tree.isSearchModeOpen() || tree.getSelectedPath().at(-1)!=='Collection') throw Error('Escape did not return to the current folder');
                const navMs = performance.now()-navAt, localSaveMs = await removing;
                const {createNativeLibrary} = await import('./dist/native-library.js');
                const native = createNativeLibrary(window.webkit.messageHandlers.oneplay);
                let after = null;
                while (performance.now()-start<15000) {
                    const inventory = await native.pins('snapshot',{after});
                    if (inventory.total === trackBytes) break;
                    after = inventory.revision;
                    await new Promise(resolve=>setTimeout(resolve,20));
                }
                tick();
                return {navMs, localSaveMs, cleanupMs:performance.now()-start, maxGap};
            } finally { clearInterval(timer); }
            """, arguments:["trackBytes":size], in:nil, contentWorld:.page)
        mainActorGaps.cancel()
        let mainGap = await mainActorGaps.value
        let cleanupMetrics = try XCTUnwrap(cleanup as? [String:Double])
        XCTAssertEqual(controller.pins.completeKeys, ["library:song-0"])
        XCTAssertEqual(controller.pins.snapshot(after:nil)["total"] as? Int,size)
        let store = try XCTUnwrap(account.openPlaybackStore())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:store.pinDirectory.path),[PlaybackStore.pinName("library:song-0") + ".mp3"])
        print("Bulk unpin 499/500: main-actor timer max \(mainGap); bundled JS ms \(cleanupMetrics)")
        account.updateNetworkPath(offline:true,interfaces:[])
        _ = try await page.callAsyncJavaScript("""
            window._testTree.setSelectedPath(['OnePlay Music']);
            await window._testTree.onPlayClick(['OnePlay Music','fav:survivor']);
            """, arguments:[:], in:nil, contentWorld:.page)
        let player = try XCTUnwrap(controller.player)
        let playing = ContinuousClock.now + .seconds(8)
        while (player.snapshot["position"] as? Double ?? 0)<0.05, .now<playing { try await Task.sleep(for:.milliseconds(15)) }
        XCTAssertGreaterThanOrEqual(player.snapshot["position"] as? Double ?? 0,0.05,player.status)
        XCTAssertTrue(player.holdsPin("library:song-0"))
        try await player.stopAndDrain()
        await controller.pins.unbindAndCancel()
    }

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
        let privateStore = try XCTUnwrap(first.openPlaybackStore())
        try privateStore.save("private position", "position")
        try first.beginSignOut(theme: "dark")
        let afterMarker = try open()
        XCTAssertTrue(afterMarker.cleanupPending)
        XCTAssertNil(try afterMarker.openPlaybackStore())
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
        XCTAssertFalse(FileManager.default.fileExists(atPath: privateStore.directory.path))
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

    /// The bundled debug tap fences Graph and keeps the pairing until Settings verifies interactive recovery.
    func testSettingsExpireRequiresInteractiveReconnect() async throws {
        let identity = TestIdentity()
        var interactiveVerifications = 0
        let account = try NativeAccount(recordFile: record, identity: identity) { [self] req in
            if req.url?.path == "/v1.0/me/drive" {
                if req.value(forHTTPHeaderField: "Authorization") == "Bearer interactive" { interactiveVerifications += 1 }
                return try response(req, data: drive)
            }
            return try response(req, status: 404, data: Data())
        }
        let controller = LibraryController(account: account, store: .nonPersistent())
        controller.loadViewIfNeeded()
        defer { controller.detachPage() }
        var page = try await readyPage(in: controller)
        _ = try await page.callAsyncJavaScript("""
            const {dbPut} = await import('./dist/db.js');
            localStorage.setItem('oneplay_music_debug_enabled', '1');
            localStorage.setItem('account_info', JSON.stringify({driveId:'library',displayName:'Listener'}));
            await dbPut('index:library',{kind:'MusicData',count:1,size:20,folder:{id:'root',children:{'First.mp3':{id:'a'}}}});
            """, arguments: [:], in: nil, contentWorld: .page)
        _ = try await account.signIn(presenting: controller)
        page.reload()
        page = try await readyPage(in: controller, excluding: page)
        func waitForEvidence(_ value: String, badge: String = "") async throws {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                let visibleState = try await page.evaluateJavaScript("""
                    [window._testAuth?.getEvidence(), document.querySelector('.app-root .crumb-end > [role=img]')?.textContent].join('|')
                    """)
                if visibleState as? String == "\(value)|\(badge)" { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("Expected \(value) with breadcrumb badge '\(badge)'")
        }

        try await waitForEvidence("evidence:signed-in")
        _ = try await page.evaluateJavaScript("document.querySelector('.app-root .row-icon-settings').click()")
        _ = try await page.evaluateJavaScript("""
            [...document.querySelectorAll('#settings-container button')].find(button => button.textContent === 'Expire').click()
            """)
        try await waitForEvidence("evidence:signed-out", badge: "🔒")
        XCTAssertNil(account.currentShareProof)
        let blocked = try await account.request(message: ["url": batch, "method": "POST", "id": UUID().uuidString])
        XCTAssertEqual(blocked["status"] as? Int, 401)
        XCTAssertEqual((blocked["headers"] as? [String: String])?["X-OnePlay-Account-Error"], "interactionRequired")
        account.updateNetworkPath(offline: true, interfaces: [])
        try await waitForEvidence("evidence:not-online", badge: "🚫")
        account.updateNetworkPath(offline: false, interfaces: [.wifi])
        try await waitForEvidence("evidence:signed-out", badge: "🔒")

        identity.home = "different-account"
        do {
            _ = try await account.signIn(presenting: controller)
            XCTFail("A different account must not clear the challenge")
        } catch NativeAccountError.wrongAccount {}
        XCTAssertEqual(account.snapshot["evidence"] as? String, "evidence:signed-out")
        identity.home = "listener"
        let canReconnect = try await page.evaluateJavaScript("!!document.querySelector('#settings-container:not([hidden]) .settings-pill-reconnect')")
        XCTAssertEqual(canReconnect as? Bool, true)
        let shot = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        shot.name = "Debug expiry - native Reconnect"; shot.lifetime = .keepAlways
        add(shot)
        let verifiedBefore = interactiveVerifications
        _ = try await page.evaluateJavaScript("document.querySelector('.settings-pill-reconnect').click()")
        try await waitForEvidence("evidence:signed-in")
        XCTAssertGreaterThan(interactiveVerifications, verifiedBefore)
        XCTAssertEqual(account.snapshot["driveID"] as? String, "library")
        XCTAssertEqual(identity.removed, 0)
        XCTAssertNotNil(account.currentShareProof)
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

    /// A share 403 carries proof only while its account remains verified. A later renewal
    /// challenge invalidates even a response JS has already received and has yet to publish.
    func testShareProbeProofExpiresOnAccountRenewalFailure() async throws {
        try pair()
        let identity = TestIdentity()
        let inFlight = expectation(description: "Share probe reached Graph on the first grant")
        var finish: CheckedContinuation<Void, Never>?
        let account = try NativeAccount(recordFile: record, identity: identity) { [self] req in
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            if req.url?.lastPathComponent == "held" {
                await withCheckedContinuation { finish = $0; inFlight.fulfill() }
            }
            if req.url?.lastPathComponent == "renew" {
                return try response(req, status: req.value(forHTTPHeaderField: "Authorization") == "Bearer original" ? 401 : 200, data: Data())
            }
            return try response(req, status: 403, data: Data())
        }
        let item = "https://graph.microsoft.com/v1.0/drives/shared/items/root"
        let denied = try await account.request(message: ["url": item, "id": UUID().uuidString])
        let oldProof = try XCTUnwrap((denied["headers"] as? [String: String])?["X-OnePlay-Account-Proof"])
        XCTAssertEqual(denied["status"] as? Int, 403)
        XCTAssertEqual(oldProof, account.currentShareProof)
        identity.needsInteraction = true
        let challenge = try await account.request(message: ["url": item, "id": UUID().uuidString])
        XCTAssertEqual(challenge["status"] as? Int, 401)
        XCTAssertNil((challenge["headers"] as? [String: String])?["X-OnePlay-Account-Proof"])
        XCTAssertNil(account.currentShareProof)
        identity.needsInteraction = false
        let fresh = try await account.request(message: ["url": item, "id": UUID().uuidString])
        let newProof = try XCTUnwrap((fresh["headers"] as? [String: String])?["X-OnePlay-Account-Proof"])
        XCTAssertNotEqual(oldProof, newProof)
        XCTAssertEqual(newProof, account.currentShareProof)

        let late = Task { try await account.request(message: ["url": item + "/held", "id": UUID().uuidString]) }
        await fulfillment(of: [inFlight], timeout: 3)
        let renewal = try await account.request(message: ["url": item + "/renew", "id": UUID().uuidString])
        XCTAssertEqual(renewal["status"] as? Int, 200)
        XCTAssertNotEqual(account.currentShareProof, newProof)
        finish?.resume()
        let completed = try await late.value
        XCTAssertEqual(completed["status"] as? Int, 403)
        XCTAssertNil((completed["headers"] as? [String: String])?["X-OnePlay-Account-Proof"], "An older Graph transaction cannot borrow the renewed grant's proof")
    }

    /// The second 401 of a replay can arrive after a different request verified a new grant.
    func testLateShareReplayCannotSignOutNewGrant() async throws {
        try pair()
        let identity = TestIdentity()
        let replay = expectation(description: "Retiring bearer is awaiting its replay")
        var finish: CheckedContinuation<Void, Never>?
        let account = try NativeAccount(recordFile: record, identity: identity) { [self] request in
            if request.url?.lastPathComponent == "held" {
                if request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh" {
                    await withCheckedContinuation { finish = $0; replay.fulfill() }
                }
                return try response(request, status: 401, data: Data())
            }
            return try response(request, data: drive)
        }
        let root = "https://graph.microsoft.com/v1.0/drives/shared/items/"
        let held = Task { try await account.request(message: ["url": root + "held", "id": UUID().uuidString]) }
        await fulfillment(of: [replay], timeout: 3)
        identity.ordinaryToken = "newer"
        let current = try await account.request(message: ["url": root + "current", "id": UUID().uuidString])
        let proof = try XCTUnwrap((current["headers"] as? [String: String])?["X-OnePlay-Account-Proof"])
        finish?.resume()
        do { _ = try await held.value; XCTFail("The old bearer cannot publish an account challenge") }
        catch NativeAccountError.cancelled {}
        XCTAssertEqual(account.currentShareProof, proof)
        XCTAssertEqual(account.snapshot["evidence"] as? String, "evidence:signed-in")
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

    /// Start cold on cellular, tap +30, then exercise warm seeks and manual Next with a filled cache.
    /// Hold the successor metadata GET so the actual bundled UI can distinguish it from a range fetch.
    func testWarmSeeksAndPreparedNextInDrawer() async throws {
        let wifi = OSAllocatedUnfairLock(initialState: false)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TestAudioCDN.self]
        let pool = MediaPool(configuration: configuration, unmeteredWiFi: { wifi.withLock { $0 } })
        let frame = Data([0xff, 0xfb, 0x90, 0x00]) + Data(repeating: 0, count: 413) // 128 kbps MPEG-1 Layer III
        var song = frame
        // Give Core Audio the length at open so it can leave most of this three-minute fixture unread.
        var info = Data("Info".utf8)
        for value in [3, 6900, 6901 * frame.count] { // Flags, MPEG frame count, compressed bytes
            withUnsafeBytes(of: UInt32(value).bigEndian) { info.append(contentsOf: $0) }
        }
        song.replaceSubrange(36..<36+info.count, with: info)
        for _ in 0..<6900 { song.append(frame) }
        let size = song.count
        TestAudioCDN.fixture.withLock { [song] in $0 = (song, false, []) }
        defer { TestAudioCDN.fixture.withLock { $0 = (Data(), false, []) } }
        var calls = [String]()
        var holdLookups = true
        var waiters = [CheckedContinuation<Void, Never>]()
        func releaseLookups() {
            holdLookups = false
            waiters.forEach { $0.resume() }
            waiters.removeAll()
        }
        let pending = expectation(description: "Cellular requested the successor URL during current playback")
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] request in
            if request.url?.path == "/v1.0/me/drive" { return try response(request, data: drive) }
            let item = request.url?.lastPathComponent ?? ""
            guard ["A", "B", "C", "D"].contains(item) else { return try response(request, status: 404, data: Data()) }
            calls.append(item)
            if item != "A" {
                let isEarly = calls.count == 2
                XCTAssertTrue(request.allowsCellularAccess)
                if holdLookups {
                    await withCheckedContinuation { waiters.append($0); if isEarly { pending.fulfill() } }
                    try Task.checkCancellation()
                }
            }
            let body: [String: Any] = ["id": item, "size": size, "eTag": "v1", "@microsoft.graph.downloadUrl": "https://audio.test/\(item)/\(calls.count)"]
            return try response(request, data: JSONSerialization.data(withJSONObject: body))
        }
        let tracks = ["A","B"].map { IndexedTrack(driveId: "library", itemId: $0, path: ["Music", "Album", $0]) }
        func fillCache(_ track: IndexedTrack) {
            let file = MediaPool.File(drive: track.driveId, item: track.itemId, version: "v1", size: Int64(size))
            for offset in stride(from: 0, to: size, by: MediaRanges.block) {
                pool.store(song.subdata(in: offset..<min(offset + MediaRanges.block, size)), for: file, at: Int64(offset))
            }
        }
        let player = NativePlayback(pool: pool) { drive, item, request, wifiOnly in
            try await account.media(driveID: drive, itemID: item, lookup: request, wifiOnly: wifiOnly)
        }
        let controller = LibraryController(account: account, store: .nonPersistent(), player: player)
        let host = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        host.addChild(controller)
        host.view.addSubview(controller.view)
        controller.didMove(toParent: host)
        defer {
            releaseLookups()
            player.stop()
            controller.detachPage()
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
        }
        let page = try await readyPage(in: controller)
        _ = try await account.signIn(presenting: controller)
        // Use the installed drawer and native reply bridge with a synthetic queue and no library sync.
        _ = try await page.callAsyncJavaScript("""
            const {createNativeLibrary} = await import('./dist/native-library.js');
            const {attachNativePlayback} = await import('./dist/native-playback.js');
            const native = createNativeLibrary(window.webkit.messageHandlers.oneplay);
            await native.loadAccountState('state');
            // Release omits the developer audition capability. The user's Debug switch still shows the rails.
            delete native.state.debugPlayback;
            document.getElementById('status').hidden = true;
            window.followedRows = [];
            const drawer = attachNativePlayback(native,document.getElementById('footer'),
                (info, advanced) => { if (advanced) window.followedRows.push(info.track.at(-1)); },()=>{},()=>{});
            if (!document.querySelector('.audio-ranges').hidden) throw Error('Debug is off initially');
            drawer.setDebugEnabled(true);
            window.spinnerSeen = false;
            const wheel = document.querySelector('.scrubber-text');
            new MutationObserver(changes => {
                if (wheel.classList.contains('loading') || changes.some(c => c.oldValue?.split(' ').includes('loading')))
                    window.spinnerSeen = true;
            }).observe(wheel, {attributes:true, attributeFilter:['class'], attributeOldValue:true});
            window.addEventListener('oneplay-playback', e => {
                if (e.detail.snapshot.state === 'playing') {
                    window.readyPosition = e.detail.snapshot.position;
                    window.readyTrack = e.detail.snapshot.path.at(-1);
                }
            });
            """, arguments: [:], in: nil, contentWorld: .page)
        func waitForUI(_ predicate: String) async throws {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                if try await page.evaluateJavaScript(predicate) as? Bool == true { return }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTFail("Missing UI state: " + predicate + ", player: " + player.status)
        }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        try await waitForUI("document.querySelector('.footer-title')?.textContent === 'A'")
        _ = try await page.evaluateJavaScript("document.querySelector('.footer-gripper').click()")
        try await waitForUI("!!document.querySelector('.audio-range-rail .marker')")
        let item = try XCTUnwrap(player.snapshot["item"] as? String)
        await fulfillment(of: [pending], timeout: 5)
        try await waitForUI("!!document.querySelector('.audio-ranges > :last-child .lookup')")
        let keepsBars = try await page.callAsyncJavaScript("""
            const reply = await window.webkit.messageHandlers.oneplay.postMessage({op:'playback', version:1, action:'snapshot'});
            return reply.snapshot.bars?.length === 3;
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(keepsBars as? Bool, true)
        _ = try await page.callAsyncJavaScript("await Promise.all(document.querySelector('.expansion').getAnimations().map(a => a.finished))",
                                               arguments: [:], in: nil, contentWorld: .page)
        let screen = try await page.takeSnapshot(configuration: nil)
        let image = XCTAttachment(image: screen)
        image.name = "Expanded player during successor Graph lookup"
        image.lifetime = .keepAlways
        add(image)
        try player.apply("pause", item: item, seconds: nil)
        releaseLookups()
        try await waitForUI("!document.querySelector('.audio-ranges .lookup')")
        XCTAssertFalse(TestAudioCDN.fixture.withLock { $0.paths.contains("/B/2") })
        try player.apply("play", item: item, seconds: nil)
        // A 128 kbps file needs ~560 kB through +30 and the first four seconds of resumed PCM.
        // Both the current cellular runway and the manual Next opening fill from the network.
        try await waitForUI("parseFloat(document.querySelector('.audio-ranges > :nth-child(2) .cached')?.style.width) >= 24")
        try await waitForUI("parseFloat(document.querySelector('.audio-ranges > :last-child .cached')?.style.width) >= 9")
        let cachedOpening = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        cachedOpening.name = "Opening of Next cached during metered playback"
        cachedOpening.lifetime = .keepAlways
        add(cachedOpening)
        XCTAssertTrue(TestAudioCDN.fixture.withLock { $0.paths.contains("/B/2") })
        _ = try await page.evaluateJavaScript("window.spinnerSeen = false")
        let beforeSkip = try XCTUnwrap(player.snapshot["position"] as? Double)
        _ = try await page.evaluateJavaScript("document.querySelector('.scrubber-edge-button.top').click()")
        try await waitForUI("Math.abs(window.readyPosition - \(beforeSkip + 30)) < 1 && !document.querySelector('.scrubber-text.loading')")
        let afterSkip = try XCTUnwrap(player.snapshot["position"] as? Double)
        _ = try await page.evaluateJavaScript("document.querySelector('.scrubber-edge-button.bottom').click()")
        try await waitForUI("Math.abs(window.readyPosition - \(afterSkip - 15)) < 1")
        fillCache(tracks[0])
        try await waitForUI("!document.querySelector('.audio-range-rail .fetching')")
        let requestsBeforeWarmSeeks = TestAudioCDN.fixture.withLock { $0.paths }
        for target in [10, 120, 15] {
            let began = ContinuousClock.now
            _ = try await page.callAsyncJavaScript("""
                window.readyPosition = -1;
                return await window.webkit.messageHandlers.oneplay.postMessage({op:'playback', version:1, action:'seek', item, seconds:target, debugRanges:true});
                """, arguments: ["item": item, "target": target], in: nil, contentWorld: .page)
            let time = String(format: "%d:%02d", target / 60, target % 60)
            try await waitForUI("Math.abs(window.readyPosition - \(target)) < 0.8 && document.querySelector('.scrubber-text:not(.loading) span')?.textContent.startsWith('\(time) /')")
            XCTAssertEqual(player.snapshot["state"] as? String, "playing")
            print("Warm seek \(target)s to playing and displayed time: \(began.duration(to: .now))")
        }
        XCTAssertEqual(calls, ["A", "B"])
        XCTAssertFalse(requestsBeforeWarmSeeks.isEmpty)
        XCTAssertEqual(Set(requestsBeforeWarmSeeks), ["/A/1", "/B/2"])
        XCTAssertEqual(TestAudioCDN.fixture.withLock { $0.paths }, requestsBeforeWarmSeeks)
        fillCache(tracks[1])
        wifi.withLock { $0 = true }
        // A paused scrub stays at the exact end.
        let duration = try XCTUnwrap(player.snapshot["duration"] as? Double)
        try player.apply("pause", item: item, seconds: nil)
        try player.apply("seek", item: item, seconds: duration)
        let endTime = String(format: "%d:%02d", Int(duration) / 60, Int(duration) % 60)
        try await waitForUI("document.querySelector('.audio-range-rail .marker')?.style.left === '100%' && document.querySelector('.scrubber-text:not(.loading) span')?.textContent === '\(endTime) / \(endTime)'")
        _ = try await page.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual(player.snapshot["state"] as? String, "paused")
        XCTAssertEqual(try XCTUnwrap(player.snapshot["position"] as? Double), duration)
        let parked = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        parked.name = "Scrubber parked at exact end"
        parked.lifetime = .keepAlways
        add(parked)
        try player.apply("seek", item: item, seconds: 120)
        XCTAssertEqual(player.snapshot["position"] as? Double, 120)
        XCTAssertEqual(player.snapshot["state"] as? String, "paused")
        try await waitForUI("document.querySelector('.scrubber-text span')?.textContent.startsWith('2:00 /')")
        _ = try await page.evaluateJavaScript("window.readyPosition = -1; document.querySelector('.footer-playpause').click()")
        try await waitForUI("window.readyPosition >= 120 && !document.querySelector('.scrubber-text.loading')")
        let began = ContinuousClock.now
        _ = try await page.evaluateJavaScript("document.querySelector('.scrubber-edge-button.right').click()")
        try await waitForUI("document.querySelector('.footer-title')?.textContent === 'B' && window.readyTrack === 'B' && !!document.querySelector('.scrubber-text:not(.loading)') && !!document.querySelector('.audio-range-rail .marker')")
        XCTAssertEqual(player.snapshot["state"] as? String, "playing")
        XCTAssertEqual(calls, ["A", "B"])
        let followed = try await page.evaluateJavaScript("window.followedRows") as? [String]
        XCTAssertEqual(followed, ["B"], "Next should ask the tree to follow B once")
        let warmSpinnerSeen = try await page.evaluateJavaScript("window.spinnerSeen") as? Bool
        XCTAssertEqual(warmSpinnerSeen, false, "Warm skips, scrubs, Play and Next must never flash the spinner")
        print("Prepared Next to playing and displayed time: \(began.duration(to: .now))")

        let last = try XCTUnwrap(player.snapshot["item"] as? String)
        wifi.withLock { $0 = false }
        try player.apply("seek", item: last, seconds: duration)
        pool.clear()
        try player.apply("seek", item: last, seconds: 45)
        try player.apply("play", item: last, seconds: nil)
        try await waitForUI("Math.abs(window.readyPosition - 45) < 1")
        XCTAssertEqual(calls, ["A", "B"])
        XCTAssertTrue(TestAudioCDN.fixture.withLock { $0.paths.contains("/B/2") })

        // Hold Graph after a genuine CDN rejection. Seeking into retained audio still resumes immediately.
        try player.apply("seek", item: last, seconds: duration)
        holdLookups = true
        TestAudioCDN.fixture.withLock { $0.expired = true }
        pool.clear()
        try player.apply("seek", item: last, seconds: 90)
        try player.apply("play", item: last, seconds: nil)
        try await waitForUI("!!document.querySelector('.scrubber-text.loading') && !!document.querySelector('.audio-ranges > :nth-child(2) .lookup')")
        // Only the target block survives. Header and scan reads need the held renewal, but the
        // listener can still see the requested time while those ancillary bytes are unavailable.
        // This fixture has exactly 1152 samples and 417 bytes per MPEG frame.
        let frameAtTarget = 30 * 44_100 / 1152
        let base = (1 + frameAtTarget) * frame.count / MediaRanges.block * MediaRanges.block
        pool.store(song.subdata(in: base..<base + MediaRanges.block),
                   for: MediaPool.File(drive: "library", item: "B", version: "v1", size: Int64(size)), at: Int64(base))
        try player.apply("seek", item: last, seconds: 30)
        try await waitForUI("!document.querySelector('.scrubber-text.loading') && document.querySelector('.scrubber-text span')?.textContent.startsWith('0:30 /')")
        _ = try await page.evaluateJavaScript("window.spinnerSeen = false")
        try await waitForUI("!!document.querySelector('.audio-ranges > :nth-child(2) .lookup')")
        _ = try await page.callAsyncJavaScript("await new Promise(resolve => setTimeout(resolve, 500))", arguments: [:], in: nil, contentWorld: .page)
        let partialSpinnerSeen = try await page.evaluateJavaScript("window.spinnerSeen") as? Bool
        XCTAssertEqual(partialSpinnerSeen, false)
        fillCache(tracks[1])
        try player.apply("seek", item: last, seconds: 30)
        try await waitForUI("Math.abs(window.readyPosition - 30) < 1 && !document.querySelector('.scrubber-text.loading')")
        releaseLookups()

        // The next uncached read can renew, then reuse the replacement for later ranges.
        try player.apply("seek", item: last, seconds: duration)
        pool.clear()
        try player.apply("seek", item: last, seconds: 60)
        try player.apply("play", item: last, seconds: nil)
        try await waitForUI("Math.abs(window.readyPosition - 60) < 1 && !document.querySelector('.scrubber-text.loading')")
        XCTAssertEqual(calls, ["A", "B", "B", "B", "B"])
        XCTAssertTrue(TestAudioCDN.fixture.withLock { $0.paths.contains("/B/5") })

        // The same seek message as a wheel release advances the playing track without another tap.
        try player.apply("previous", item: last, seconds: nil)
        try await waitForUI("document.querySelector('.footer-title')?.textContent === 'A' && window.readyPosition < 1")
        let previous = try XCTUnwrap(player.snapshot["item"] as? String)
        _ = try await page.callAsyncJavaScript("""
            window.readyTrack = null;
            return await window.webkit.messageHandlers.oneplay.postMessage({op:'playback', version:1, action:'seek', item, seconds, debugRanges:true});
            """, arguments: ["item": previous, "seconds": duration - 0.05], in: nil, contentWorld: .page)
        try await waitForUI("window.readyTrack === 'B' && document.querySelector('.footer-title')?.textContent === 'B' && !document.querySelector('.scrubber-text.loading')")
        _ = try await page.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", arguments: [:], in: nil, contentWorld: .page)
        let advanced = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        advanced.name = "Track B playing after scrubbing track A to the end"
        advanced.lifetime = .keepAlways
        add(advanced)
        XCTAssertEqual(player.snapshot["state"] as? String, "playing")
        let finalItem = try XCTUnwrap(player.snapshot["item"] as? String)
        // Releasing at the end during playback finishes the queue in the same command.
        try player.apply("seek", item: finalItem, seconds: duration)
        XCTAssertEqual(player.snapshot["position"] as? Double, duration)
        XCTAssertEqual(player.snapshot["state"] as? String, "ended", player.status)
        XCTAssertEqual(calls, ["A", "B", "B", "B", "B"])

        // A new selection has cached audio but no admitted URL. Hold the actual Graph response
        // past the UI grace period, then confirm local decoding starts without a CDN read.
        let cached = IndexedTrack(driveId: "library", itemId: "C", path: ["Music", "Album", "C"])
        fillCache(cached)
        holdLookups = true
        _ = try await page.evaluateJavaScript("window.spinnerSeen = false")
        let cold = IndexedTrack(driveId: "library", itemId: "D", path: ["Music", "Album", "D"])
        try player.start(tracks: [cold, cached], startIndex: 1, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        try await waitForUI("document.querySelector('.footer-title')?.textContent === 'C' && !!document.querySelector('.audio-ranges > :nth-child(2) .lookup')")
        _ = try await page.callAsyncJavaScript("await new Promise(resolve => setTimeout(resolve, 500))", arguments: [:], in: nil, contentWorld: .page)
        releaseLookups()
        try await waitForUI("window.readyTrack === 'C'")
        let delayedSpinnerSeen = try await page.evaluateJavaScript("window.spinnerSeen") as? Bool
        XCTAssertEqual(delayedSpinnerSeen, false, "A slow warm open must keep the time visible")
        XCTAssertFalse(TestAudioCDN.fixture.withLock { $0.paths.contains { $0.hasPrefix("/C/") } })
        // Reproduce Prev to a cold predecessor. Keep Graph pending until the spinner is
        // visible, then watch the real drawer through the CDN reads and first scheduled PCM.
        holdLookups = true
        _ = try await page.evaluateJavaScript("document.querySelector('.scrubber-edge-button.left').click()")
        try await waitForUI("document.querySelector('.footer-title')?.textContent === 'D' && !!document.querySelector('.scrubber-text.loading')")
        _ = try await page.evaluateJavaScript("""
            window.earlyClear = false;
            window.addEventListener('oneplay-playback', function observe(e) {
                const state = e.detail.snapshot.state;
                if (state === 'playing') window.removeEventListener('oneplay-playback', observe);
                else if (!document.querySelector('.scrubber-text.loading')) window.earlyClear = true;
            });
            """)
        let waiting = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        waiting.name = "Cold Prev awaiting playback"
        waiting.lifetime = .keepAlways
        add(waiting)
        releaseLookups()
        try await waitForUI("window.readyTrack === 'D' && !document.querySelector('.scrubber-text.loading')")
        let earlyClear = try await page.evaluateJavaScript("window.earlyClear") as? Bool
        XCTAssertEqual(earlyClear, false, "No lookup, range, or local preparation step clears a visible spinner before playback")
        XCTAssertTrue(TestAudioCDN.fixture.withLock { $0.paths.contains { $0.hasPrefix("/D/") } })

    }

    func testMediaReadsURLAndVersionFromOneDriveItem() async throws {
        try pair()
        var status = 200
        var redirected = false
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] req in
            if req.url?.path == "/v1.0/me/drive" { return try response(req, data: drive) }
            XCTAssertEqual(req.url?.absoluteString,
                           "https://graph.microsoft.com/v1.0/drives/library/items/drive!a%2Fb?$select=@microsoft.graph.downloadUrl")
            let item = #"{"id":"drive!a/b","eTag":"v1","size":3596288,"@microsoft.graph.downloadUrl":"https://cdn.example.test/song"}"#
            let origin = redirected ? URLRequest(url: URL(string: "https://cdn.example.test/redirect")!) : req
            return try response(origin, status: status, data: Data(item.utf8))
        }
        let media = try await account.media(driveID: "library", itemID: "drive!a/b")
        XCTAssertEqual(media.url.absoluteString, "https://cdn.example.test/song")
        XCTAssertEqual(media.etag, "v1")
        XCTAssertEqual(media.size, 3596288)
        status = 403
        redirected = true
        do {
            _ = try await account.media(driveID: "library", itemID: "drive!a/b", lookup: .replace(media))
            XCTFail("Expected metadata from Graph")
        } catch { XCTAssertEqual(NativeAccountError.classify(error), .unavailable) }
        XCTAssertFalse(media.accessDenied)
        redirected = false
        do {
            _ = try await account.media(driveID: "library", itemID: "drive!a/b", lookup: .replace(media))
            XCTFail("Expected Graph to deny access")
        } catch { XCTAssertEqual(NativeAccountError.classify(error), .forbidden) }
        XCTAssertTrue(media.accessDenied)
        status = 200
        let restored = try await account.media(driveID: "library", itemID: "drive!a/b", lookup: .reuse(media))
        XCTAssertFalse(restored === media)
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
            do { _ = try await account.media(driveID: "library", itemID: "track", lookup: .force); XCTFail("Expected cancellation") }
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
        let player = NativePlayback(captureURL: capture) { _, _, _, _ in throw NativeAccountError.invalidRequest }
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
        let store = try XCTUnwrap(account.openPlaybackStore())
        let track = IndexedTrack(driveId: "library", itemId: "tone")
        try FileManager.default.createDirectory(at: store.pinDirectory, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: file, to: store.pinURL(track.fileKey))
        try player.start(tracks: [track], delaySeconds: 0, nearEnd: true, forceRefresh: false)
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
        let oldSample = try await page.callAsyncJavaScript("""
            return (await window.webkit.messageHandlers.oneplay.postMessage({op:'playback',version:1,action:'snapshot'})).subscription;
            """, arguments: [:], in: nil, contentWorld: .page)
        let oldSubscription = try XCTUnwrap(oldSample as? String)
        try await startHeldDownload(in: page, event: "reload")
        await fulfillment(of: [reload.started], timeout: 3)
        page.reload()
        await fulfillment(of: [reload.cancelled], timeout: 3)
        let replacement = try await readyPage(in: controller, excluding: page)
        let rejected = try await replacement.callAsyncJavaScript("""
            const send = (action,args={}) => window.webkit.messageHandlers.oneplay.postMessage({op:'playback',version:1,action,...args});
            const fresh = await send('readAccess');
            const late = await send('access',{base:fresh.snapshot.accessRevision,subscription:oldSubscription,denied:[]});
            const expired = await send('access',{base:late.snapshot.accessRevision,subscription:fresh.subscription,
                denied:['share:reader'], proof:'expired'});
            return Array.isArray(fresh.denied) && !late.denied && late.applied === false && oldSubscription !== fresh.subscription && late.subscription === fresh.subscription &&
                expired.applied === false && expired.staleProof === true;
            """, arguments: ["oldSubscription":oldSubscription], in: nil, contentWorld: .page)
        XCTAssertEqual(rejected as? Bool, true, "A retired subscription and an expired grant proof must each be rejected")
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
        // This page also waits for WebKit to clear the 30k-track store. On the simulator that
        // cleanup alone can take 20 seconds; keep the regular cold-shell deadline for other callers.
        let signedOut = try await readyPage(in: controller, excluding: replacement, timeout: .seconds(60))
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

extension AccountTests {
    /// Use the installed shell and real reply bridge. A partial, document-owned upload
    /// disappears with its page. The session and last completely committed order survive.
    func testLargeQueueThroughWebKitAndDocumentLoss() async throws {
        let account = try NativeAccount(recordFile: record, identity: TestIdentity()) { [self] request in
            try response(request, status: request.url?.path == "/v1.0/me/drive" ? 200 : 404, data: drive)
        }
        let player = NativePlayback { _, _, _, _ in throw NativeAccountError.forbidden }
        let controller = LibraryController(account: account, store: .nonPersistent(), player: player)
        let host = try XCTUnwrap((UIApplication.shared.delegate as? AppDelegate)?.library)
        host.addChild(controller)
        host.view.addSubview(controller.view)
        controller.didMove(toParent: host)
        defer {
            player.stop()
            controller.detachPage()
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
        }
        var page: WKWebView? = try await readyPage(in: controller)
        _ = try await account.signIn(presenting: controller)
        let metrics = try await page!.callAsyncJavaScript("""
            const {attachNativePlayback} = await import('./dist/native-playback.js');
            const {buildLibraryQueue} = await import('./dist/tracks.js');
            const {createNativeLibrary} = await import('./dist/native-library.js');
            const native = createNativeLibrary(window.webkit.messageHandlers.oneplay);
            await native.loadAccountState('state');
            const status = document.getElementById('status');
            status.hidden = true;
            const drawer = attachNativePlayback(native, document.getElementById('footer'), () => {}, () => {}, () => {});
            const children = {};
            for (let i = 0; i < 30000; i++) children['Track ' + i] = {id:String(i)};
            const root = {type:'onedrive', key:'library', name:'Music', folder:{id:'r',children}, info:{driveId:'library'}};
            const start = performance.now();
            const queue = await buildLibraryQueue(['Music','library'],new Map([['library',root]]),[],new Set());
            const built = performance.now();
            await drawer.start(queue,0,true,'30m');
            const committed = performance.now();
            document.querySelector('.footer-gripper').click();
            document.querySelector('.mode-label').click();
            while (document.querySelector('.mode-label').textContent !== 'repeat') {
                if (performance.now() - committed > 3000) throw Error('Mode did not reach the drawer');
                await new Promise(r => setTimeout(r, 20));
            }
            const {snapshot} = await native.playback('snapshot');
            await native.playback('beginQueue',{build:'partial',count:30000,session:snapshot.session,revision:1});
            await native.playback('queueChunk',{build:'partial',offset:0,tracks:queue.tracks.slice(0,512)});
            return {count:queue.tracks.length, buildMs:built-start, transferMs:committed-built};
            """, arguments: [:], in: nil, contentWorld: .page)
        XCTAssertEqual((metrics as? [String: Any])?["count"] as? Int, 30_000)
        print("30k queue simulator metrics \(metrics ?? "")")
        _ = try await page!.callAsyncJavaScript("await Promise.all(document.querySelector('.expansion').getAnimations().map(a => a.finished))",
                                               arguments: [:], in: nil, contentWorld: .page)
        let screenshot = try await page!.takeSnapshot(configuration: nil)
        let image = XCTAttachment(image: screenshot)
        image.name = "Live queue and Repeat mode"
        image.lifetime = .keepAlways
        add(image)
        let session = try XCTUnwrap(player.snapshot["session"] as? String)
        controller.detachPage()
        page = nil
        controller.loadPage()
        let replacement = try XCTUnwrap(controller.webView)
        let ready = ContinuousClock.now + .seconds(10)
        while (replacement.url != BundledShell.page || replacement.isLoading), ContinuousClock.now < ready {
            try await Task.sleep(for: .milliseconds(25))
        }
        let restored = try await replacement.callAsyncJavaScript("""
            const post = args => window.webkit.messageHandlers.oneplay.postMessage({op:'playback',version:1,...args});
            let rejected = false;
            try { await post({action:'queueChunk',build:'partial',offset:512,tracks:[{driveId:'d',itemId:'i',path:['Music','d','i'],sourceRootKey:'d',key:'i'}]}); }
            catch { rejected = true; }
            const {snapshot} = await post({action:'snapshot'});
            return {rejected, session:snapshot.session, mode:snapshot.mode};
            """, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        XCTAssertEqual(restored?["session"] as? String, session)
        XCTAssertEqual(restored?["mode"] as? String, "repeat")
        XCTAssertEqual(restored?["rejected"] as? Bool, true)
    }
}

extension AccountTests {
    /// With the same optional fixture UUID, a second XCTest process reopens the first process's
    /// WebKit and Swift files. The ordinary suite uses a fresh pairing and exercises the migration.
    func testBundledLegacyBookmarksAndColdReopen() async throws {
        let fixture = ProcessInfo.processInfo.environment["ONEPLAY_RESTART_FIXTURE"].flatMap(UUID.init(uuidString:))
        let folder = fixture.map { FileManager.default.temporaryDirectory.appendingPathComponent($0.uuidString) } ?? dir!
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let binding = folder.appendingPathComponent("account.json")
        let reopening = FileManager.default.fileExists(atPath: binding.path)
        let webStore = fixture.map { WKWebsiteDataStore(forIdentifier: $0) } ?? .nonPersistent()
        let account = try NativeAccount(recordFile: binding, identity: TestIdentity()) { [self] request in
            try response(request, status: request.url?.path == "/v1.0/me/drive" ? 200 : 404, data: drive)
        }
        let lookups = OSAllocatedUnfairLock(initialState: 0)
        let pool = MediaPool()
        let bytes = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3")))
        let media = MediaLocation(url: URL(string: "https://audio.test/bookmark")!, etag: "v", size: Int64(bytes.count))
        for id in ["a", "b", "c"] {
            let file = MediaPool.File(drive: "library", item: id, version: "v", size: media.size)
            for offset in stride(from: 0, to: bytes.count, by: MediaRanges.block) {
                pool.store(bytes.subdata(in: offset..<min(offset + MediaRanges.block, bytes.count)), for: file, at: Int64(offset))
            }
        }
        let player = NativePlayback(pool: pool, shuffledStart: { Array($0.reversed()) }) { _, _, _, _ in lookups.withLock { $0 += 1 }; return media }
        let controller = LibraryController(account: account, store: webStore, player: player)
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
        var page = try await readyPage(in: controller)
        if !reopening {
            _ = try await page.callAsyncJavaScript("""
                const {dbPut} = await import('./dist/db.js');
                localStorage.setItem('account_info',JSON.stringify({driveId:'library',displayName:'Fixture'}));
                const root = ['OnePlay Music','library'];
                localStorage.setItem('oneplay_music_playback',JSON.stringify({folder:root,track:[...root,'First.mp3'],mode:'one'}));
                localStorage.setItem('oneplay_music_time','2.25');
                await dbPut('index:library',{kind:'MusicData',count:3,size:30,folder:{id:'album',children:{'First.mp3':{id:'a'},'Second.mp3':{id:'b'},'Third.mp3':{id:'c'}}}});
                await dbPut('favorites',{updatedAt:1,favorites:[{kind:'playlist',id:'reader',name:'Remembered album',hasPrivatePlayback:true,
                    mode:'repeat',members:['First','Second'].map((name,i)=>({driveId:'library',sourceRootKey:'library',itemId:i?'b':'a',isFolder:false,path:[name+'.mp3']}))}]});
                await dbPut('playback:reader',{trackPath:['OnePlay Music','fav:reader','m:1'],currentTime:4.25});
                """, arguments: [:], in: nil, contentWorld: .page)
            _ = try await account.signIn(presenting: controller)
            page.reload()
            page = try await readyPage(in: controller, excluding: page)
        }
        func waitFor(_ predicate: @escaping ([String: Any]) -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(8)
            while !predicate(player.snapshot), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertTrue(predicate(player.snapshot), "Unexpected playback state: \(player.snapshot)")
        }
        try await waitFor { $0["state"] as? String == "paused" }
        XCTAssertEqual(lookups.withLock { $0 }, 0)
        if !reopening {
            XCTAssertEqual(player.snapshot["position"] as? Double, 2.25)
            XCTAssertEqual(player.snapshot["title"] as? String, "First.mp3")
            _ = try await page.callAsyncJavaScript("await window._testTree.onPlayClick(['OnePlay Music','fav:reader'])", arguments: [:], in: nil, contentWorld: .page)
            try await waitFor { $0["state"] as? String == "playing" && $0["title"] as? String == "Second.mp3" }
            let item = try XCTUnwrap(player.snapshot["item"] as? String)
            try player.apply("pause", item: item, seconds: nil)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(player.snapshot["position"] as? Double), 4.25)
            try player.apply("seek", item: item, seconds: 3.5)
            try await player.waitForCheckpointWrites()
        }
        XCTAssertEqual(player.snapshot["position"] as? Double, 3.5)
        XCTAssertEqual(player.snapshot["mode"] as? String, "repeat")
        XCTAssertEqual(player.snapshot["path"] as? [String], ["OnePlay Music", "fav:reader", "m:1"])
        _ = try await page.callAsyncJavaScript("""
            document.querySelector('.footer-gripper').click();
            await Promise.all(document.querySelector('.expansion').getAnimations().map(a => a.finished));
            """, arguments: [:], in: nil, contentWorld: .page)
        let attachment = XCTAttachment(image: try await page.takeSnapshot(configuration: nil))
        attachment.name = reopening ? "Cold reopen at saved favorite" : "Remembered favorite after explicit seek"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("Playback process \(getpid()), reopen=\(reopening), paused=3.5s, track=Second, mode=repeat, lookups=\(lookups.withLock { $0 })")
        if reopening {
            _ = try await page.evaluateJavaScript("document.querySelector('.footer-playpause').click()")
            try await waitFor { $0["state"] as? String == "playing" && ($0["position"] as? Double ?? 0) >= 3.5 }
            XCTAssertGreaterThan(lookups.withLock { $0 }, 0)
        }
        if fixture == nil {
            // Exercise the bundled tree, real mode button, favorites document and Swift player together.
            // The separate cross-process fixture retains its paused bookmark for the next invocation.
            let sequence = try await page.callAsyncJavaScript("""
                const tree = window._testTree, favorites = window._testFavorites;
                const drive = ['OnePlay Music', 'library'], label = document.querySelector('.mode-label');
                const observed = [];
                for (const remember of [false, true]) {
                    const id = 'mode-' + remember, fav = [drive[0], 'fav:' + id];
                    await favorites.add({kind:'playlist', id, name:id, hasPrivatePlayback:remember,
                        members:[...favorites.getAll().find(f => f.id === 'reader').members,
                            {driveId:'library',sourceRootKey:'library',itemId:'c',isFolder:false,path:['Third.mp3']}]});
                    const pick = async mode => {
                        for (let i = 0; i < 5 && label.textContent !== mode; i++) {
                            const prior = label.textContent;
                            label.click();
                            const end = performance.now() + 3000;
                            while (label.textContent === prior) {
                                if (performance.now() > end) throw Error('Mode button stayed at ' + prior);
                                await new Promise(resolve => setTimeout(resolve, 10));
                            }
                        }
                    };
                    await tree.onPlayClick(drive);
                    await pick('one');
                    await tree.onTrackClick([...fav, 'm:0']);
                    observed.push(label.textContent);
                    await pick('shuffle');
                    await tree.onPlayClick(drive);
                    observed.push(label.textContent, favorites.getAll().find(f => f.id === id).mode);
                    await pick('all');
                    await tree.onTrackClick([...fav, 'm:0']);
                    observed.push(label.textContent, document.querySelector('.footer-title').textContent);
                    // The deterministic shuffle selected First,Third,Second. A later preference
                    // and a queue revision must not replace that pass with canonical First,Second,Third.
                    await favorites.setMode(id, 'all');
                    await favorites.setHasPrivatePlayback(id, !remember);
                    observed.push(label.textContent);
                    document.querySelector('.scrubber-edge-button.right').click();
                    const end = performance.now() + 3000;
                    const post = window.webkit.messageHandlers.oneplay;
                    while (true) {
                        const {snapshot} = await post.postMessage({op:'playback',version:1,action:'snapshot'});
                        if (snapshot.title === 'Third.mp3' && JSON.parse(snapshot.key).at(-1) === 'c'
                            && snapshot.state === 'playing' && snapshot.position > 0.05) break;
                        if (performance.now() > end) throw Error('Wrong shuffle successor');
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
                return observed;
                """, arguments: [:], in: nil, contentWorld: .page) as? [String]
            let expected = ["one", "shuffle", "shuffle", "shuffle", "First.mp3", "shuffle"]
            XCTAssertEqual(sequence, expected + expected)
            // Fail the Swift queue write on disk. An accepted tap must still commit its
            // preference through WebKit's independent IndexedDB store.
            let queueFile = try XCTUnwrap(account.openPlaybackStore()).directory.appendingPathComponent("queue")
            let originalQueue = folder.appendingPathComponent("original-queue")
            try FileManager.default.moveItem(at: queueFile, to: originalQueue)
            try FileManager.default.createDirectory(at: queueFile, withIntermediateDirectories: false)
            defer {
                try? FileManager.default.removeItem(at: queueFile)
                try? FileManager.default.moveItem(at: originalQueue, to: queueFile)
            }
            let saved = try await page.callAsyncJavaScript("""
                const {dbGet} = await import('./dist/db.js');
                document.querySelector('.mode-label').click(); // Shuffle -> One.
                const end = performance.now() + 3000;
                while (performance.now() < end) {
                    const data = await dbGet('favorites');
                    if (data.favorites.find(f => f.id === 'mode-true').mode === 'one') return true;
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                return false;
                """, arguments: [:], in: nil, contentWorld: .page)
            XCTAssertEqual(saved as? Bool, true)
        }
        try await player.stopAndDrain()
    }
}
