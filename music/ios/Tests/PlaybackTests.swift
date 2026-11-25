import AVFoundation
import XCTest
@testable import OnePlayMusic

final class PlaybackTests: XCTestCase {
    /// Promotion preserves the decoder's object identity. Size catches truncated objects with a reused tag.
    func testRenewalRequiresOriginalVersionAndSize() throws {
        let original = MediaLocation(url: URL(string: "https://example.test/one")!, etag: "graph-v1", size: 200)
        let nextURL = URL(string: "https://example.test/two")!
        let ranges = try MediaRanges(original, speculative: true, trace: { _ in })
        ranges.promote()
        XCTAssertThrowsError(try ranges.read(0, 1)) { XCTAssertEqual($0.localizedDescription, "Expired URL blocked") }
        for changed in [MediaLocation(url: nextURL, etag: "graph-v2", size: 200),
                        MediaLocation(url: nextURL, etag: "graph-v1", size: 201)] {
            XCTAssertThrowsError(try ranges.installRenewal(changed)) {
                XCTAssertEqual($0.localizedDescription, "Recording changed during playback")
            }
        }
        try ranges.installRenewal(MediaLocation(url: nextURL, etag: original.etag, size: original.size))
        XCTAssertEqual(ranges.specBytes, 0)
        ranges.cancel()
        XCTAssertThrowsError(try ranges.read(0, 1)) { XCTAssertTrue($0 is CancellationError) }
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
        let player = NativePlayback(captureURL: capture) { _, item, _ in
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
        let player = NativePlayback(captureURL: capture) { _,_,_ in throw NativeAccountError.forbidden }
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
