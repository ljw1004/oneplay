import AVFoundation
import XCTest
import os
@testable import OnePlayMusic

final class PlaybackTests: XCTestCase {
    /// Touching an older block keeps it through eviction. Switching identities and clearing isolate playback bytes.
    func testCompressedCacheEvictionAndIdentity() {
        let block = MediaRanges.block
        let pool = MediaPool(capacity: block * 2)
        let first = MediaPool.File(drive: "a", item: "1", version: "v", size: Int64(block*2))
        let next = MediaPool.File(drive: "b", item: "1", version: "v", size: Int64(block*2))
        let data = Data(repeating: 7, count: block)
        pool.store(data, for: first, at: 0)
        pool.store(data, for: first, at: Int64(block))
        XCTAssertNil(pool.read(next, at: 0))
        XCTAssertEqual(pool.read(first, at: 0), data)
        pool.store(data, for: next, at: 0)
        XCTAssertNil(pool.read(first, at: Int64(block)))
        XCTAssertEqual(pool.read(first, at: 0), data)
        pool.clear()
        XCTAssertNil(pool.read(next, at: 0))
        XCTAssertNil(pool.read(first, at: 0))
    }

    /// Promotion preserves the decoder's object identity. Size catches truncated objects with a reused tag.
    func testRenewalRequiresOriginalVersionAndSize() throws {
        let original = MediaLocation(url: URL(string: "https://example.test/one")!, etag: "graph-v1", size: 200)
        let nextURL = URL(string: "https://example.test/two")!
        let ranges = try MediaRanges(original, speculative: true, trace: { _ in })
        ranges.promote()
        XCTAssertFalse(ranges.speculative)
        for changed in [MediaLocation(url: nextURL, etag: "graph-v2", size: 200),
                        MediaLocation(url: nextURL, etag: "graph-v1", size: 201)] {
            let stale = try MediaRanges(original, speculative: false, trace: { _ in })
            XCTAssertThrowsError(try stale.renewLocation { changed }) {
                XCTAssertEqual($0.localizedDescription, "Recording changed during playback")
            }
            XCTAssertNil(stale.admission)
            XCTAssertThrowsError(try stale.read(0, 1)) { XCTAssertTrue($0 is CancellationError) }
        }
        try ranges.renewLocation { MediaLocation(url: nextURL, etag: original.etag, size: original.size) }
        XCTAssertEqual(ranges.specBytes, 0)
        ranges.cancel()
        XCTAssertThrowsError(try ranges.read(0, 1)) { XCTAssertTrue($0 is CancellationError) }
    }

    /// The Info frame count can overestimate the playable MP3 duration. Exercise a real zero-frame seek.
    func testScrubPastLastPlayableSample() async throws {
        let tone = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        var data = try Data(contentsOf: tone)
        let info = try XCTUnwrap(data.range(of: Data("Info".utf8))).upperBound
        let frames = info+4..<info+8 // 269 MPEG frames in this CBR fixture; advertise twelve more.
        XCTAssertEqual(Array(data[frames]), [0, 0, 1, 13])
        data.replaceSubrange(frames, with: [0, 0, 1, 25])
        let song = data
        let decoder = try MP3RangeDecoder(bytes: Int64(song.count)) { start, count in
            song.subdata(in: Int(start)..<Int(start)+count)
        }
        let target = decoder.frames - 11_025 // 250 ms before the advertised end
        XCTAssertEqual(try decoder.decode(44_100, at: target).frameLength, 0)
        let pool = MediaPool()
        let media = MediaLocation(url: URL(string: "https://audio.test/short")!, etag: "v1", size: Int64(song.count))
        let tracks = ["A","B"].map { IndexedTrack(driveId: "d", itemId: $0, path: [$0]) }
        for track in tracks {
            pool.store(song, for: .init(drive: "d", item: track.itemId, version: media.etag, size: media.size), at: 0)
        }
        let player = NativePlayback(pool: pool) { _,_,_,_ in media }
        defer { player.stop() }
        func waitForState(_ state: String, track: String) async throws {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                let sample = player.snapshot
                if sample["state"] as? String == state, sample["path"] as? [String] == [track] { return }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTFail("Expected \(state) on \(track), got \(player.snapshot)")
        }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        try await waitForState("playing", track: "A")
        let item = try XCTUnwrap(player.snapshot["item"] as? String)
        try player.apply("seek", item: item, seconds: Double(target) / 44_100)
        try await waitForState("playing", track: "B")
        let last = try XCTUnwrap(player.snapshot["item"] as? String)
        try player.apply("seek", item: last, seconds: Double(target) / 44_100)
        try await waitForState("ended", track: "B")
    }

    /// A playing end scrub completes the occurrence without reopening its audible tail.
    func testEndScrubSkipsAudibleTail() async throws {
        // 80 complete MP3 frames of a 440 Hz tone, cut on a packet boundary before the encoder padding.
        let tone = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let song = try Data(contentsOf: tone)
        let size = Int64(song.count)
        let decoder = try MP3RangeDecoder(bytes: size) { start, count in song.subdata(in: Int(start)..<Int(start)+count) }
        let tail = try decoder.decode(882, at: decoder.frames - 882)
        let samples = UnsafeBufferPointer(start: try XCTUnwrap(tail.floatChannelData)[0], count: Int(tail.frameLength))
        XCTAssertTrue(samples.contains { abs($0) > 0.5 })
        let duration = Double(decoder.frames) / 44_100
        let pool = MediaPool()
        let media = MediaLocation(url: URL(string: "https://audio.test/tone")!, etag: "v1", size: size)
        let tracks = ["A", "B"].map { IndexedTrack(driveId: "d", itemId: $0, path: [$0]) }
        for track in tracks {
            pool.store(song, for: .init(drive: "d", item: track.itemId, version: media.etag, size: size), at: 0)
        }
        let parkedItems = OSAllocatedUnfairLock(initialState: Set<String>())
        let player = NativePlayback(pool: pool) { _, item, _, _ in
            XCTAssertFalse(parkedItems.withLock { $0.contains(item) }, "Reopened the outgoing recording at EOF")
            return media
        }
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        func playingItem(_ track: IndexedTrack) async throws -> String {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                let state = player.snapshot
                if state["path"] as? [String] == track.path && state["state"] as? String == "playing" { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(player.snapshot["path"] as? [String], track.path)
            XCTAssertEqual(player.snapshot["state"] as? String, "playing")
            return try XCTUnwrap(player.snapshot["item"] as? String)
        }
        let first = try await playingItem(tracks[0])
        _ = parkedItems.withLock { $0.insert("A") }
        try player.apply("seek", item: first, seconds: duration + 1)
        let second = try await playingItem(tracks[1])
        // B already has a duration. Only the occurrence token protects it from A's late release.
        try player.apply("seek", item: first, seconds: duration)
        XCTAssertEqual(player.snapshot["item"] as? String, second)
        XCTAssertEqual(player.snapshot["state"] as? String, "playing")
        _ = parkedItems.withLock { $0.insert("B") }
        try player.apply("seek", item: second, seconds: duration)
        XCTAssertEqual(player.snapshot["state"] as? String, "ended")
        XCTAssertEqual(player.snapshot["position"] as? Double, duration)

        let last = try XCTUnwrap(player.snapshot["item"] as? String)
        try player.apply("seek", item: last, seconds: duration / 2)
        XCTAssertEqual(player.snapshot["state"] as? String, "paused")
        try player.apply("seek", item: last, seconds: duration)
        XCTAssertEqual(player.snapshot["state"] as? String, "paused")
        XCTAssertEqual(player.snapshot["position"] as? Double, duration)
        try player.apply("play", item: last, seconds: nil)
        // Explicit Play from the finished queue replays its last track. A playing skip past EOF finishes it.
        _ = parkedItems.withLock { $0.remove("B") }
        try player.apply("play", item: last, seconds: nil)
        let replay = try await playingItem(tracks[1])
        _ = parkedItems.withLock { $0.insert("B") }
        try player.apply("skip", item: replay, seconds: 30)
        XCTAssertEqual(player.snapshot["state"] as? String, "ended")
        XCTAssertEqual(player.snapshot["position"] as? Double, duration)
    }

    /// A wheel gesture can outlive a failure on the very same occurrence and token.
    func testEndScrubAfterFailureKeepsErrorOnCurrentTrack() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let song = try Data(contentsOf: url)
        let media = MediaLocation(url: URL(string: "https://audio.test/tone")!, etag: "v1", size: Int64(song.count))
        let pool = MediaPool()
        let tracks = ["A","B"].map { IndexedTrack(driveId: "d", itemId: $0, path: [$0]) }
        for track in tracks {
            pool.store(song, for: .init(drive: "d", item: track.itemId, version: media.etag, size: media.size), at: 0)
        }
        let player = NativePlayback(pool: pool) { _, _, lookup, _ in
            if case .reuse(.some) = lookup { throw NativeAccountError.forbidden }
            return media
        }
        defer { player.stop() }
        func waitForState(_ state: String) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while player.snapshot["state"] as? String != state && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(player.snapshot["state"] as? String, state)
        }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        try await waitForState("playing")
        let item = try XCTUnwrap(player.snapshot["item"] as? String)
        let duration = try XCTUnwrap(player.snapshot["duration"] as? Double)
        try player.apply("seek", item: item, seconds: duration / 2)
        try await waitForState("error")
        try player.apply("seek", item: item, seconds: duration)
        XCTAssertEqual(player.snapshot["state"] as? String, "error")
        XCTAssertEqual(player.snapshot["item"] as? String, item)
    }

    func testMediaAdmitsOnlyHTTPSWithoutEmbeddedCredentials() {
        for raw in ["http://example.test/raw", "https://user:password@example.test/raw", "file:///private/media.mp3"] {
            let source = MediaLocation(url: URL(string: raw)!, etag: "v1", size: 16)
            XCTAssertThrowsError(try MediaRanges(source, speculative: true, trace: { _ in }))
        }
    }
}

/// An SDK completion can outlive the playback request that joined it.
private actor HeldSDK {
    var callback: CheckedContinuation<Void, Never>?
    func hold(_ ready: XCTestExpectation) async {
        await withCheckedContinuation { callback = $0; ready.fulfill() }
    }
    func release() { callback?.resume(); callback = nil }
}

extension PlaybackTests {
    func testReplacementWhileOldTokenAcquisitionIsHeld() async throws {
        let hold = HeldSDK()
        let first = expectation(description: "First silent lookup held by SDK")
        let second = expectation(description: "Replacement admitted before old SDK callback")
        let capture = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let player = NativePlayback(captureURL: capture) { _, item, _, _ in
            if item == "first" { await hold.hold(first) }
            else { second.fulfill() }
            throw NativeAccountError.forbidden
        }
        try player.start(tracks: [.init(driveId: "drive", itemId: "first")], delaySeconds: 0, nearEnd: false, forceRefresh: false)
        await fulfillment(of: [first], timeout: 5)
        try player.start(tracks: [.init(driveId: "drive", itemId: "second")], delaySeconds: 0, nearEnd: false, forceRefresh: false)
        await fulfillment(of: [second], timeout: 3)
        await hold.release()
        try await player.stopAndDrain()
    }

    #if DEBUG
    /// A missing successor uses the same scheduling failure path as a denied Graph recording.
    /// Compare both ends of the generated outgoing tone with its independent local decode.
    func testUnavailableSuccessorFinishesAudibleRecording() async throws {
        let tone = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "ScaleTone", withExtension: "mp3"))
        let missing = tone.deletingLastPathComponent().appendingPathComponent("Z-missing.mp3")
        let capture = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        let player = NativePlayback(captureURL: capture) { _,_,_,_ in throw NativeAccountError.forbidden }
        try player.startLocalFiles([tone, missing], nearEnd: true)
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !player.status.hasPrefix("Playback failed") && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(player.status.hasPrefix("Playback failed"), player.status)
        func audibleFrames(_ url: URL) throws -> Int {
            let file = try AVAudioFile(forReading: url)
            let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: UInt32(file.length)))
            try file.read(into: pcm)
            let samples = try XCTUnwrap(pcm.floatChannelData)[0]
            let indices = 0..<Int(pcm.frameLength)
            let start = try XCTUnwrap(indices.first { abs(samples[$0]) > 0.0002 })
            let end = try XCTUnwrap(indices.last { abs(samples[$0]) > 0.0002 })
            return end-start
        }
        let denied = try audibleFrames(capture)
        try player.startLocalFiles([tone], nearEnd: true)
        let referenceDeadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !player.status.hasPrefix("Finished") && ContinuousClock.now < referenceDeadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(player.status.hasPrefix("Finished"), player.status)
        let reference = try audibleFrames(capture)
        // iOS batches the tap at its own quantum. Compare with a complete take through that same tap.
        XCTAssertEqual(Double(denied), Double(reference), accuracy: 1)
        XCTAssertEqual(Double(reference), Double(try audibleFrames(tone)), accuracy: 1)
        try await player.stopAndDrain()
    }
    #endif
}
