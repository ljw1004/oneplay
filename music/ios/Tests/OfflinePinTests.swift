import Foundation
import os
import XCTest
@testable import OnePlayMusic

final class PinCDN: URLProtocol {
    static let requests = OSAllocatedUnfairLock(initialState: [String]())
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pin.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!
        Self.requests.withLock { $0.append(url.path) }
        let bytes = url.path == "/tone" ? try! Data(contentsOf: Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3")!) : url.path == "/short" ? Data([1]) : Data([1, 2, 3])
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Length": String(bytes.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor final class OfflinePinTests: XCTestCase {
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
            ["id": id, "paused": paused, "complete": complete, "sources": ["share:X": keys]]
        }
        try await pins.bind(store)
        await pins.connectSession()
        var short = true
        pins.lookup = { _, _, _ in MediaLocation(url: URL(string: short ? "https://pin.test/short" : "https://pin.test/tone")!, etag: "v1", size: Int64(song.count)) }
        try pins.apply(owners: [owner("one"), owner("two", paused: true)])
        let rejected = expectation(description: "Partial file rejected")
        pins.onChange = {
            if pins.snapshot(after: nil)["error"] is String { pins.onChange = nil; rejected.fulfill() }
        }
        pins.updateEvidence("evidence:signed-in")
        await fulfillment(of: [rejected], timeout: 5)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.pinURL(key).path))
        XCTAssertTrue(pins.completeKeys.isEmpty)
        short = false
        let published = expectation(description: "Verified file published")
        pins.onChange = {
            if pins.completeKeys == [key] { pins.onChange = nil; published.fulfill() }
        }
        try pins.control("retry", quota: nil)
        await fulfillment(of: [published], timeout: 5)
        XCTAssertEqual(try Data(contentsOf: store.pinURL(key)), song)
        try pins.control("quota", quota: 2)
        try pins.apply(owners: [owner("two", paused: true, complete: false, keys: [])])
        // A crash between the native fence and the IndexedDB transaction cannot resume obsolete work.
        try pins.control("fence", quota: nil)
        let cold = OfflinePins(configuration: .ephemeral)
        try await cold.bind(store)
        XCTAssertEqual(cold.completeKeys, [key])
        XCTAssertEqual(cold.snapshot(after: nil)["quota"] as? Int, 2 << 30)
        XCTAssertEqual(cold.snapshot(after: nil)["missing"] as? [String], [])
        try cold.apply(owners: [owner("restored", paused: false)])
        // An open descriptor (the decoder's lease) stays usable after the last owner unpins.
        let lease = try FileHandle(forReadingFrom: store.pinURL(key))
        try cold.apply(owners: [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.pinURL(key).path))
        XCTAssertEqual(try lease.readToEnd(), song)
        try lease.close()
        await pins.unbindAndCancel()
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
        try pins.apply(owners: [["id":"mix", "complete":true, "paused":false, "sources":["library":["d:gone","d:ok"]]]])
        let finished = expectation(description: "Healthy pin survives its neighbor's 404")
        pins.onChange = {
            if pins.completeKeys == ["d:ok"] { pins.onChange = nil; finished.fulfill() }
        }
        pins.updateEvidence("evidence:signed-in")
        await fulfillment(of: [finished], timeout: 4)
        let fileHandle = try FileHandle(forWritingTo: store.pinURL("d:ok"))
        try fileHandle.truncate(atOffset: 1024)
        try fileHandle.close()
        let cold = OfflinePins(configuration: .ephemeral)
        try await cold.bind(store)
        XCTAssertTrue(cold.completeKeys.isEmpty)
        XCTAssertEqual(Set(cold.snapshot(after:nil)["missing"] as? [String] ?? []), ["d:gone","d:ok"])
        await pins.unbindAndCancel()
    }

    func testLastOwnerLeaseLeavesQuotaAtNaturalEnd() async throws {
        let dir = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = try PlaybackStore(root: dir, home: "listener", drive: "library")
        let intent = OfflinePins(configuration: .ephemeral)
        try await intent.bind(store)
        try intent.apply(owners: [["id":"solo","paused":true,"complete":true,"sources":["d":["d:A"]]]])
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let file = store.pinURL("d:A"), length = try Data(contentsOf: fixture).count
        try FileManager.default.copyItem(at: fixture, to: file)
        try PinReceipt(size: length, version: "v").write(to: file)
        let pins = OfflinePins(configuration: .ephemeral)
        try await pins.bind(store)
        let player = NativePlayback { _,_,_,_ in XCTFail("The pin is local"); throw NativeAccountError.transient }
        try player.restoreIfNeeded(from: store)
        pins.playerHolds = player.holdsPin
        player.onChange = { debug in if !debug { pins.releaseUnusedLeases() } }
        try player.start(tracks: [IndexedTrack(driveId:"d", itemId:"A", path:["Music","d","A"], key:"A")],
                         delaySeconds:0, nearEnd:false, forceRefresh:false)
        defer { player.stop() }
        let start = ContinuousClock.now + .seconds(4)
        while !player.holdsPin("d:A"), .now < start { try await Task.sleep(for: .milliseconds(10)) }
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
