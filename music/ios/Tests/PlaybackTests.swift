import AVFoundation
import XCTest
import os
@testable import OnePlayMusic

final class PlaybackTests: XCTestCase {
    /// An early Next can have only the opening and final blocks resident. Use actual MPEG audio
    /// without a Xing/Info index and deny every read in between until the first PCM is audible.
    func testUnindexedMP3StartsWithOnlyOpeningAndTail() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let tone = try Data(contentsOf: url)
        // Skip this fixture's 44-byte ID3 header when repeating its 80 complete MPEG frames.
        var song = tone
        // At 23 repetitions only 2,880 frames follow the last four-second boundary.
        for _ in 1..<23 { song.append(tone.dropFirst(44)) }
        let size = song.count
        let tail = (size - 1) / MediaRanges.block * MediaRanges.block
        var openingOnly = true
        let decoder = try MP3RangeDecoder(bytes: Int64(size)) { offset, count in
            let range = Int(offset)..<(Int(offset) + count)
            guard !openingOnly || range.upperBound <= MediaRanges.openingPrefix || range.lowerBound >= tail else {
                throw PlaybackError("Read beyond the cached opening before playing")
            }
            return song.subdata(in: range)
        }
        let (first, final) = try decoder.decodePlaybackChunk(4 * 44_100, at: nil)
        XCTAssertFalse(final)
        XCTAssertEqual(first.frameLength, 4 * 44_100)
        let samples = UnsafeBufferPointer(start: try XCTUnwrap(first.floatChannelData)[0], count: Int(first.frameLength))
        XCTAssertTrue(samples.contains { abs($0) > 0.5 })
        openingOnly = false
        var played = Int64(first.frameLength)
        while true {
            let (pcm, final) = try decoder.decodePlaybackChunk(4 * 44_100, at: nil)
            played += Int64(pcm.frameLength)
            if final {
                XCTAssertGreaterThanOrEqual(pcm.frameLength, 6615 + 88)
                break
            }
        }
        XCTAssertEqual(played, 23 * 80 * 1152)
        XCTAssertEqual(decoder.frames, played)
    }

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

    /// A high-bitrate opening makes a headerless VBR song look short. A relative skip can still land in it.
    func testRelativeSkipCanPassProvisionalDuration() async throws {
        let high = Data([0xff, 0xfb, 0xe0, 0]) + Data(repeating: 0, count: 1040)
        let low = Data([0xff, 0xfb, 0x10, 0]) + Data(repeating: 0, count: 100)
        var song = Data()
        for _ in 0..<900 { song.append(high) }
        for _ in 0..<4000 { song.append(low) }
        let pool = MediaPool()
        let media = MediaLocation(url: URL(string: "https://audio.test/uneven")!, etag: "v1", size: Int64(song.count))
        let tracks = ["A", "B"].map { IndexedTrack(driveId: "d", itemId: $0, path: [$0]) }
        for track in tracks {
            let file = MediaPool.File(drive: "d", item: track.itemId, version: media.etag, size: media.size)
            for offset in stride(from: 0, to: song.count, by: MediaRanges.block) {
                pool.store(song.subdata(in: offset..<min(offset + MediaRanges.block, song.count)), for: file, at: Int64(offset))
            }
        }
        let player = NativePlayback(pool: pool) { _, _, _, _ in media }
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        let before = try await waitFor(player) { $0["state"] as? String == "playing" }
        XCTAssertLessThan(try XCTUnwrap(before["duration"] as? Double), 50)
        try player.apply("skip", item: try XCTUnwrap(before["item"] as? String), seconds: 50)
        _ = try await waitFor(player) { $0["path"] as? [String] == ["A"] && $0["state"] as? String == "playing" && ($0["position"] as? Double ?? 0) >= 50 }
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
        try player.apply("skip", item: last, seconds: 30)
        XCTAssertEqual(player.snapshot["position"] as? Double, duration)
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

extension PlaybackTests {
    /// Three offline fixture files let the real decoder and render clock cross joins without Graph or a page.
    private func liveQueue(timer: Duration = .seconds(900)) throws -> (NativePlayback, [IndexedTrack]) {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "AudibleTail", withExtension: "mp3"))
        let bytes = try Data(contentsOf: url)
        let media = MediaLocation(url: URL(string: "https://audio.test/queue")!, etag: "v1", size: Int64(bytes.count))
        let pool = MediaPool()
        let tracks = ["A", "B", "C"].map { IndexedTrack(driveId: "d", itemId: $0, path: ["Music", "List", $0], key: $0, sourceRootKey: "d") }
        for t in tracks { pool.store(bytes, for: .init(drive: "d", item: t.itemId, version: "v1", size: media.size), at: 0) }
        return (NativePlayback(pool: pool, timerInterval: { _ in timer }) { _, _, _, _ in media }, tracks)
    }

    private func waitFor(_ player: NativePlayback, _ matches: ([String: Any]) -> Bool) async throws -> [String: Any] {
        let end = ContinuousClock.now + .seconds(6)
        while .now < end {
            let sample = player.snapshot
            if matches(sample) { return sample }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out at \(player.snapshot)")
        throw PlaybackError("Missing playback transition")
    }

    func testRemovedCurrentFinishesThenUsesSurvivingFormerNeighbor() async throws {
        let (player, tracks) = try liveQueue()
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        let a = try await waitFor(player) { $0["state"] as? String == "playing" }
        let session = try XCTUnwrap(a["session"] as? String)
        player.revise(session: session, revision: 1, folder: ["Music", "List"], tracks: [tracks[2], tracks[1]])
        XCTAssertEqual(player.snapshot["key"] as? String, "A")
        XCTAssertNil(player.snapshot["path"])
        XCTAssertEqual(player.snapshot["item"] as? String, a["item"] as? String)
        player.revise(session: session, revision: 2, folder: ["Music", "List"], tracks: [tracks[2]])
        player.revise(session: session, revision: 1, folder: [], tracks: tracks)
        _ = try await waitFor(player) { $0["key"] as? String == "C" && $0["state"] as? String == "playing" }
        XCTAssertEqual(player.snapshot["path"] as? [String], tracks[2].path)
        player.updateAccess(connected: [], denied: ["d"])
        XCTAssertNil(player.snapshot["item"])
        XCTAssertThrowsError(try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false))
    }

    /// Cancelling manual-only preparation at natural EOF must leave Next usable.
    func testManualOnlyPreparationRetiresAtNaturalEnd() async throws {
        let (player, tracks) = try liveQueue()
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false, initialMode: .one)
        let playing = try await waitFor(player) { $0["state"] as? String == "playing" }
        let item = try XCTUnwrap(playing["item"] as? String)
        let duration = try XCTUnwrap(playing["duration"] as? Double)
        try player.apply("seek", item: item, seconds: duration - 0.4)
        let ended = try await waitFor(player) { $0["state"] as? String == "ended" }
        XCTAssertEqual(ended["item"] as? String, item)
        try player.apply("next", item: item, seconds: nil)
        _ = try await waitFor(player) { $0["key"] as? String == "B" && $0["state"] as? String == "playing" }
    }

    func testNaturalAndManualBoundariesInEveryMode() async throws {
        let (player, tracks) = try liveQueue()
        defer { player.stop() }
        for mode in QueueMode.allCases {
            try player.start(tracks: tracks, startIndex: mode == .repeat ? 2 : 0, delaySeconds: 0, nearEnd: false, forceRefresh: false,
                             timer: "end-of-track", initialMode: mode)
            let before = try await waitFor(player) { $0["state"] as? String == "playing" }
            XCTAssertEqual(before["advanced"] as? Bool, false)
            let item = try XCTUnwrap(before["item"] as? String)
            try player.apply("seek", item: item, seconds: 100)
            let next = player.snapshot
            XCTAssertEqual(next["mode"] as? String, mode.rawValue)
            switch mode {
            case .one, .timer:
                XCTAssertEqual(next["state"] as? String, "ended")
                try player.apply("next", item: item, seconds: nil)
                XCTAssertEqual(player.snapshot["key"] as? String, "B")
                XCTAssertEqual(player.snapshot["advanced"] as? Bool, true)
                try player.apply("previous", item: try XCTUnwrap(player.snapshot["item"] as? String), seconds: nil)
                XCTAssertEqual(player.snapshot["advanced"] as? Bool, false)
            case .repeat: XCTAssertEqual(next["key"] as? String, "A")
            case .all: XCTAssertEqual(next["key"] as? String, "B")
            case .shuffle: XCTAssertNotEqual(next["key"] as? String, "A")
            }
        }
        try player.start(tracks: [tracks[0]], delaySeconds: 0, nearEnd: false, forceRefresh: false, initialMode: .repeat)
        let first = try XCTUnwrap(player.snapshot["item"] as? String)
        _ = try await waitFor(player) { $0["item"] as? String != first && $0["state"] as? String == "playing" }
        XCTAssertEqual(player.snapshot["advanced"] as? Bool, true)
        try player.apply("pause", item: first, seconds: nil)
        XCTAssertEqual(player.snapshot["state"] as? String, "playing")
    }

    func testSleepTimerPausesInPlaceAndRearmsOnPlay() async throws {
        let (player, tracks) = try liveQueue(timer: .milliseconds(500))
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false, timer: "15m", initialMode: .timer)
        let first = try await waitFor(player) { $0["state"] as? String == "paused" }
        let time = try XCTUnwrap(first["position"] as? Double)
        XCTAssertGreaterThan(time, 0)
        try player.apply("play", item: try XCTUnwrap(first["item"] as? String), seconds: nil)
        let second = try await waitFor(player) { $0["state"] as? String == "paused" }
        XCTAssertGreaterThan(try XCTUnwrap(second["position"] as? Double), time)
        XCTAssertEqual(second["item"] as? String, first["item"] as? String)
    }
}

extension PlaybackTests {
    func testFencedEndResumesOnCommittedRevisionWithNoPage() async throws {
        let (player, tracks) = try liveQueue()
        defer { player.stop() }
        try player.start(tracks: tracks, delaySeconds: 0, nearEnd: false, forceRefresh: false)
        let a = try await waitFor(player) { $0["state"] as? String == "playing" }
        let session = try XCTUnwrap(a["session"] as? String)
        let item = try XCTUnwrap(a["item"] as? String)
        player.fence(session: session, revision: 1)
        try player.apply("pause", item: item, seconds: nil)
        try player.apply("play", item: item, seconds: nil)
        try player.apply("pause", item: "obsolete", seconds: nil)
        let ended = try await waitFor(player) { $0["state"] as? String == "ended" }
        XCTAssertEqual(ended["key"] as? String, "A")
        XCTAssertEqual(ended["fenced"] as? Bool, true)
        player.revise(session: session, revision: 1, folder: [], tracks: [tracks[0], tracks[2]])
        _ = try await waitFor(player) { $0["key"] as? String == "C" && $0["state"] as? String == "playing" }
        XCTAssertEqual(player.snapshot["fenced"] as? Bool, false)
    }
}
