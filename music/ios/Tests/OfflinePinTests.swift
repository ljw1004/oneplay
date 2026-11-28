import Foundation
import XCTest
@testable import OnePlayMusic

final class PinCDN: URLProtocol {
    static let leadingPadding = Data(repeating: 0, count: 420_000)
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pin.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!
        let bytes: Data
        switch url.path {
        case "/tone", "/padded-tone":
            let tone = try! Data(contentsOf: Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3")!)
            bytes = url.path == "/tone" ? tone : Self.leadingPadding + tone
        case "/empty": bytes = Data()
        case "/short": bytes = Data([1])
        default: bytes = Data([1, 2, 3])
        }
        let status = ["/missing":404, "/gone":410][url.path] ?? 200
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Length": String(bytes.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor final class OfflinePinTests: XCTestCase {
    func testPublicPinsResumeWithoutPageOrCatalogReachability() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "demo", drive: "demo")
        let seed = OfflinePins(configuration: .ephemeral)
        try await seed.bind(store)
        try seed.apply(owners: [["id":"folder", "paused":false, "complete":true,
                                 "sources":["demo":["demo:recording":"Song.mp3"]]]])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let restored = OfflinePins(configuration: config)
        restored.updateEvidence("no-evidence", publicMedia: true)
        restored.lookup = { _, _, _ in MediaLocation(url: URL(string: "https://pin.test/clip")!, etag: "v1", size: 3) }
        try await restored.bind(store)
        let saved = expectation(description: "Restored public pin completed without a reachability probe")
        restored.onChange = {
            if restored.completeKeys == ["demo:recording"] { restored.onChange = nil; saved.fulfill() }
        }
        await restored.connectSession()
        await fulfillment(of: [saved], timeout: 5)
        XCTAssertEqual(try Data(contentsOf: store.pinURL("demo:recording", suffix: "mp3")), Data([1, 2, 3]))
        await restored.unbindAndCancel()
    }

    func testInterruptedPinRestartOverlapPauseAndLastOwnerRemoval() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let pins = OfflinePins(configuration: config)
        let key = "d:A"
        let song = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3")))
        func owner(_ id: String, paused: Bool = false, complete: Bool = true, keys: [String] = ["d:A"]) -> [String: Any] {
            ["id": id, "paused": paused, "complete": complete, "sources": ["share:X": Dictionary(uniqueKeysWithValues: keys.map { ($0, "Song.mp3") })]]
        }
        try await pins.bind(store)
        await pins.connectSession()
        var lookups = 0
        pins.lookup = { _, _, policy in
            lookups += 1
            if lookups > 1 {
                guard case .fresh = policy else { XCTFail("Size mismatch reused stale metadata"); throw NativeAccountError.invalidRequest }
                XCTAssertFalse(FileManager.default.fileExists(atPath: store.pinURL(key, suffix: "mp3").path))
                if lookups == 2 { throw NativeAccountError.transient }
            }
            let url = URL(string: lookups == 1 ? "https://pin.test/short" : "https://pin.test/tone")!
            return MediaLocation(url: url, etag: "v1", size: Int64(song.count))
        }
        try pins.apply(owners: [owner("one"), owner("two", paused: true)])
        let published = expectation(description: "Truncated download recovers without user input")
        pins.onChange = {
            if pins.completeKeys == [key] { pins.onChange = nil; published.fulfill() }
        }
        pins.updateEvidence("evidence:signed-in")
        await fulfillment(of: [published], timeout: 10)
        XCTAssertEqual(try Data(contentsOf: store.pinURL(key, suffix: "mp3")), song)
        try pins.setQuota(2)
        try pins.apply(owners: [owner("two", paused: true, complete: false, keys: [])])
        let cold = OfflinePins(configuration: .ephemeral)
        try await cold.bind(store)
        XCTAssertEqual(cold.completeKeys, [key])
        XCTAssertEqual(cold.snapshot(after: nil)["quota"] as? Int, 2 << 30)
        XCTAssertEqual(cold.snapshot(after: nil)["queuedCount"] as? Int, 0)
        try cold.apply(owners: [owner("restored", paused: false)])
        // An open descriptor (the decoder's lease) stays usable after the last owner unpins.
        let lease = try FileHandle(forReadingFrom: store.pinURL(key, suffix: "mp3"))
        try cold.apply(owners: [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.pinURL(key, suffix: "mp3").path))
        XCTAssertEqual(try lease.readToEnd(), song)
        try lease.close()
        await pins.unbindAndCancel()
    }

    func testIndexedBytesSurviveColdOpenAndUnreadableTracksAreSkippedAtPlayback() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let pins = OfflinePins(configuration: config)
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        try await pins.bind(store)
        let tone = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3")))
        let names = ["d:empty": "Empty.mp3", "d:bad": ".flac", "d:tone": "Tone.MP3"]
        try pins.apply(owners: [["id":"album", "paused":false, "complete":true, "sources":["library":names]]])
        // Restore and complete the pending transfers without a WebKit owner publication.
        let resumed = OfflinePins(configuration: config)
        try await resumed.bind(store)
        await resumed.connectSession()
        resumed.lookup = { _, item, _ in
            return MediaLocation(url: URL(string: "https://pin.test/" + item)!, etag: "v1",
                                 size: Int64(item == "empty" ? 0 : item == "bad" ? 3 : tone.count))
        }
        let complete = expectation(description: "Every complete indexed recording becomes available offline")
        resumed.onChange = {
            if resumed.completeKeys == Set(names.keys) { resumed.onChange = nil; complete.fulfill() }
        }
        resumed.updateEvidence("evidence:signed-in")
        await fulfillment(of: [complete], timeout: 5)
        await resumed.unbindAndCancel()
        let coldStore = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let cold = OfflinePins(configuration: config)
        try await cold.bind(coldStore)
        XCTAssertEqual(cold.completeKeys, Set(names.keys))
        XCTAssertEqual(try Data(contentsOf: store.pinURL("d:bad", suffix: "flac")), Data([1,2,3]))
        XCTAssertEqual(try Data(contentsOf: store.pinURL("d:empty", suffix: "mp3")), Data())
        let player = NativePlayback { _,_,_,_ in XCTFail("Offline playback requested the network"); throw NativeAccountError.transient }
        try player.restoreIfNeeded(from: coldStore)
        player.setOfflineAvailability(cold.completeKeys)
        let tracks = ["empty","bad","tone"].map { IndexedTrack(driveId:"d", itemId:$0, path:[$0 == "tone" ? "Old title.flac" : names["d:" + $0]!], key:$0) }
        try player.start(tracks:tracks, delaySeconds:0, nearEnd:false, forceRefresh:false)
        defer { player.stop() }
        let deadline = ContinuousClock.now + .seconds(6)
        while (player.snapshot["position"] as? Double ?? 0) < 0.05, .now < deadline { try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertEqual(player.snapshot["key"] as? String, "tone", player.status)
        XCTAssertGreaterThanOrEqual(player.snapshot["position"] as? Double ?? 0, 0.05, player.status)
        XCTAssertEqual(cold.completeKeys, Set(names.keys))
        try await player.stopAndDrain()
    }

    /// Replay the daemon's task ID and description after process loss, before WebKit attaches.
    func testAdmittedBackgroundCompletionKeepsIndexedSuffix() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let original = OfflinePins(configuration: .ephemeral)
        try await original.bind(store)
        try original.apply(owners: [["id":"album", "paused":false, "complete":true, "sources":["library":["d:B":"B.ogg"]]]])
        struct ManifestBinding: Decodable { let binding: UUID }
        let binding = try XCTUnwrap(store.read(ManifestBinding.self, "pins")).binding
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let restored = OfflinePins(configuration: config)
        let session = URLSession(configuration: config, delegate: restored, delegateQueue: .main)
        defer { session.finishTasksAndInvalidate() }
        let task = session.downloadTask(with: URL(string:"https://pin.test/not-audio")!)
        let ticket: [String:Any] = ["binding":binding.uuidString, "key":"d:B", "size":3, "version":"v1", "retry":false]
        task.taskDescription = String(decoding: try JSONSerialization.data(withJSONObject:ticket), as: UTF8.self)
        try store.save(["d:B":task.taskIdentifier], "pin-transfers")
        try await restored.bind(store)
        await restored.connectSession()
        let completed = expectation(description: "URLSession published its restored task without the library page")
        restored.onChange = {
            if restored.completeKeys.contains("d:B") { restored.onChange = nil; completed.fulfill() }
        }
        task.resume()
        await fulfillment(of:[completed], timeout:5)
        XCTAssertEqual(try Data(contentsOf:store.pinURL("d:B", suffix:"ogg")),Data([1,2,3]))
    }

    /// Reopen an over-quota album, discover a new recording under its stable folder ID,
    /// then admit only that download and play its durable MP3 on another cold open.
    func testColdInventoryRetains500TracksAboveQuotaAndResumesAfterAnIncrease() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let seed = OfflinePins(configuration: .ephemeral)
        try await seed.bind(store)
        let keys = (0..<500).map { "library:track-\($0)" }
        let pending = "library:next"
        func folder(_ files: [String]) -> [String: Any] {
            ["id":"folder:[\"library\",null,\"album\"]", "paused":false, "complete":true, "sources":["library":Dictionary(uniqueKeysWithValues:files.map { ($0, "Song.mp3") })]]
        }
        try seed.apply(owners: [folder(keys)])
        try seed.setQuota(2)
        let trackBytes = 5_600_000
        for key in keys {
            let file = store.pinURL(key)
            try Data().write(to: file)
            let handle = try FileHandle(forWritingTo: file)
            try handle.truncate(atOffset: UInt64(trackBytes))
            try handle.close()
            try PinReceipt(size: trackBytes, version: "fixture").write(to: file)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let cold = OfflinePins(configuration: config)
        let start = ContinuousClock.now
        try await cold.bind(store)
        print("Cold pin inventory: 500 files, \(trackBytes * keys.count) bytes in \(start.duration(to: .now))")
        let snapshot = cold.snapshot(after: nil)
        XCTAssertEqual(snapshot["total"] as? Int, 2_800_000_000)
        XCTAssertEqual(snapshot["quota"] as? Int, 2 << 30)
        XCTAssertEqual(cold.completeKeys, Set(keys))
        XCTAssertEqual(snapshot["queuedCount"] as? Int, 0)
        try cold.apply(owners: [folder(keys + [pending])])
        XCTAssertEqual(cold.snapshot(after: nil)["queuedCount"] as? Int, 1)
        await cold.connectSession()
        let overQuota = expectation(description: "A 2 GiB quota holds the remaining lookup")
        overQuota.isInverted = true
        cold.lookup = { _,_,_ in overQuota.fulfill(); throw NativeAccountError.unavailable }
        cold.updateEvidence("evidence:signed-in")
        await fulfillment(of: [overQuota], timeout: 0.15)
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        // This MP3 is playable but its first frame lies beyond Core Audio's .tmp format probe.
        let song = try PinCDN.leadingPadding + Data(contentsOf: file)
        var lookups = [String]()
        cold.lookup = { _, id, _ in
            lookups.append(id)
            return MediaLocation(url: URL(string: "https://pin.test/padded-tone")!, etag: "v2", size: Int64(song.count))
        }
        let finished = expectation(description: "The 5 GiB quota admits and finishes the new track")
        cold.onChange = {
            if cold.completeKeys.contains(pending) { cold.onChange = nil; finished.fulfill() }
        }
        try cold.setQuota(5)
        await fulfillment(of: [finished], timeout: 5)
        XCTAssertEqual(lookups, ["next"])
        await cold.unbindAndCancel()
        let offline = OfflinePins(configuration: config)
        try await offline.bind(store)
        XCTAssertEqual(offline.completeKeys, Set(keys + [pending]))
        XCTAssertEqual(offline.snapshot(after: nil)["total"] as? Int, 2_800_000_000 + song.count)
        XCTAssertEqual(try Data(contentsOf: store.pinURL(pending, suffix: "mp3")), song)
        let player = NativePlayback { _,_,_,_ in XCTFail("The cached track requested the network"); throw NativeAccountError.transient }
        try player.restoreIfNeeded(from: store)
        player.setOfflineAvailability(offline.completeKeys)
        let next = IndexedTrack(driveId:"library", itemId:"next", path:["Music","library","Album","New.mp3"])
        try player.start(tracks: [next], delaySeconds:0, nearEnd:false, forceRefresh:false)
        let deadline = ContinuousClock.now + .seconds(5)
        while (player.snapshot["position"] as? Double ?? 0) < 0.05, .now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertGreaterThanOrEqual(player.snapshot["position"] as? Double ?? 0, 0.05, player.status)
        try await player.stopAndDrain()
    }

    func testMissingItemDoesNotStopHealthyPinAndTruncatedColdFileIsQueuedAgain() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PinCDN.self]
        let pins = OfflinePins(configuration: config)
        try await pins.bind(store)
        await pins.connectSession()
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        let length = try Data(contentsOf: file).count
        pins.lookup = { _, item, _ in
            if item == "gone" { throw NativeAccountError.forbidden }
            return MediaLocation(url: URL(string: "https://pin.test/tone")!, etag: "v1", size: Int64(length))
        }
        try pins.apply(owners: [["id":"mix", "complete":true, "paused":false, "sources":["library":["d:gone":"Gone.mp3","d:ok":"Okay.mp3"]]]])
        let finished = expectation(description: "Healthy pin survives its neighbor's 404")
        pins.onChange = {
            if pins.completeKeys == ["d:ok"] { pins.onChange = nil; finished.fulfill() }
        }
        pins.updateEvidence("evidence:signed-in")
        await fulfillment(of: [finished], timeout: 4)
        let fileHandle = try FileHandle(forWritingTo: store.pinURL("d:ok", suffix:"mp3"))
        try fileHandle.truncate(atOffset: 1024)
        try fileHandle.close()
        let cold = OfflinePins(configuration: .ephemeral)
        try await cold.bind(store)
        XCTAssertTrue(cold.completeKeys.isEmpty)
        XCTAssertEqual(cold.snapshot(after:nil)["queuedCount"] as? Int, 2)
        await pins.unbindAndCancel()
    }

    func testUnpinFolderThenPlayPlaylistOfflineAndReleaseLastOwnerAtNaturalEnd() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let intent = OfflinePins(configuration: .ephemeral)
        try await intent.bind(store)
        let playlist: [String: Any] = ["id":"mix", "paused":false, "complete":true, "sources":["d":["d:A":"A"]]]
        let folder: [String: Any] = ["id":"folder:[\"d\",null,\"album\"]", "paused":false, "complete":true, "sources":["d":["d:A":"A"]]]
        try intent.apply(owners: [folder, playlist])
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let file = store.pinURL("d:A"), length = try Data(contentsOf: fixture).count
        try FileManager.default.copyItem(at: fixture, to: file)
        try PinReceipt(size: length, version: "v").write(to: file)
        let pins = OfflinePins(configuration: .ephemeral)
        try await pins.bind(store)
        // Removing the album leaves the playlist's verified copy available offline.
        try pins.apply(owners: [playlist])
        XCTAssertEqual(pins.completeKeys, ["d:A"])
        let player = NativePlayback { _,_,_,_ in XCTFail("The pin is local"); throw NativeAccountError.transient }
        try player.restoreIfNeeded(from: store)
        player.setOfflineAvailability(pins.completeKeys)
        pins.playerHolds = player.holdsPin
        player.onChange = { debug in if !debug { pins.releaseUnusedLeases() } }
        try player.start(tracks: [IndexedTrack(driveId:"d", itemId:"A", path:["Music","d","A"], key:"A")],
                         delaySeconds:0, nearEnd:false, forceRefresh:false)
        defer { player.stop() }
        let start = ContinuousClock.now + .seconds(4)
        while player.snapshot["state"] as? String != "playing", .now < start { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(player.snapshot["state"] as? String, "playing", player.status)
        XCTAssertTrue(player.holdsPin("d:A"))
        try pins.apply(owners: [])
        XCTAssertTrue(pins.completeKeys.isEmpty)
        XCTAssertEqual(pins.snapshot(after:nil)["total"] as? Int, length)
        let end = ContinuousClock.now + .seconds(8)
        while FileManager.default.fileExists(atPath:file.path), .now < end { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertEqual(player.snapshot["state"] as? String, "ended")
        XCTAssertFalse(FileManager.default.fileExists(atPath:file.path))
        XCTAssertEqual(pins.snapshot(after:nil)["total"] as? Int, 0)
    }

    func testOfflineFolderPlaysLocalRecordingAndSkipsStreamingOnlyNeighbor() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        try FileManager.default.createDirectory(at: store.pinDirectory, withIntermediateDirectories: true)
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        let tracks = ["absent", "one", "missing", "two"].map { IndexedTrack(driveId: "d", itemId: $0, path: ["Music", "Album", $0], key: $0) }
        let player = NativePlayback { _, _, _, _ in XCTFail("Offline playback requested a URL"); throw NativeAccountError.transient }
        for key in ["d:one","d:two"] { try FileManager.default.copyItem(at: fixture, to: store.pinURL(key)) }
        try player.restoreIfNeeded(from: store)
        player.setOfflineAvailability(["d:one","d:two"])
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false, selected: false)
        defer { player.stop() }
        for target in ["one", "two"] {
            let deadline = ContinuousClock.now + .seconds(8)
            while (player.snapshot["state"] as? String != "playing" || player.snapshot["key"] as? String != target), .now < deadline {
                try await Task.sleep(for: .milliseconds(25))
            }
            XCTAssertEqual(player.snapshot["key"] as? String, target)
            XCTAssertEqual(player.snapshot["state"] as? String, "playing", player.status)
            if target == "one" {
                let item = try XCTUnwrap(player.snapshot["item"] as? String)
                try player.apply("pause", item: item, seconds: nil)
                try FileManager.default.removeItem(at: store.pinURL("d:one"))
                player.setOfflineAvailability(["d:two"])
                try player.apply("seek", item: item, seconds: 2)
                try player.apply("play", item: item, seconds: nil)
                let resumed = ContinuousClock.now + .seconds(4)
                while player.snapshot["state"] as? String != "playing", .now < resumed { try await Task.sleep(for: .milliseconds(20)) }
                XCTAssertEqual(player.snapshot["state"] as? String, "playing")
                try player.apply("next", item: item, seconds: nil)
            }
        }
        try await player.stopAndDrain()
    }
}
