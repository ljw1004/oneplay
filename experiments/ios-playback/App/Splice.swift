import AVFoundation

/// The fixture manifest records declared timing separately from the decoded frame count.
struct Fixture: Decodable { let frames: Int64; let delay, padding: Int? }

/// Only consecutive frames with *every* channel at or below -80 dBFS qualify.
/// The tagged fixture's AVAudioFile length already excludes declared priming and padding.
func decodedBounds(_ file: AVAudioFile, fixture: Fixture, mp3: Bool) throws -> Range<Int64> {
    let n = file.length
    guard n == fixture.frames, file.processingFormat.sampleRate == 44100, n > 0 else {
        throw ProbeError("Unexpected decoder timeline")
    }
    guard mp3, fixture.delay == nil, fixture.padding == nil else { return 0..<n }
    func silentFrames(at start: Int64, count: Int, backwards: Bool) throws -> Int64 {
        // Seek before the tail window so the MP3 reservoir and synthesis filter have warmed up.
        let seek = max(0, start - 8192)
        let length = AVAudioFrameCount(start - seek) + AVAudioFrameCount(count)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: length) else {
            throw ProbeError("Cannot allocate edge buffer")
        }
        file.framePosition = seek
        try file.read(into: buffer, frameCount: length)
        guard buffer.frameLength == length, let samples = buffer.floatChannelData else {
            throw ProbeError("Incomplete decoder edge window")
        }
        for i in 0..<count {
            let index = Int(start - seek) + (backwards ? count - 1 - i : i)
            for channel in 0..<Int(file.processingFormat.channelCount) where abs(samples[channel][index]) > 0.0001 {
                return Int64(i)
            }
        }
        return Int64(count)
    }
    let lead = try silentFrames(at: 0, count: Int(min(n, 1543)), backwards: false)
    let count = Int(min(n - lead, 6615))
    let tail = try count == 0 ? 0 : silentFrames(at: n - Int64(count), count: count, backwards: true)
    // Retain a playable region even for an entirely silent, sub-185-ms fixture.
    return lead + tail == n ? 0..<n : lead..<(n-tail)
}

struct ProbeError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// These local fixtures share stereo CD-rate float PCM, so each frame has the same duration.
struct Slice {
    let file: AVAudioFile
    let start, end: Int64
    let trimmedHead, trimmedTail: Bool

    /// Reserve disjoint incoming and outgoing overlaps, including on very short clips.
    func overlapFrames(with next: Slice) -> Int64 {
        guard trimmedTail || next.trimmedHead else { return 0 }
        let n = min(88, (end-start-1)/2, (next.end-next.start-1)/2)
        return n >= 2 ? n : 0
    }
}

/// Decode just the splice and apply complementary linear gains to both stereo channels.
func scheduleSplice(on node: AVAudioPlayerNode, from left: Slice, to right: Slice, frames: Int64,
                    completion: AVAudioPlayerNodeCompletionHandler? = nil) throws {
    func read(_ source: AVAudioFile, at start: Int64) throws -> AVAudioPCMBuffer {
        // scheduleSegment owns its decoder cursor; read the splice with an independent handle.
        let file = try AVAudioFile(forReading: source.url)
        let seek = max(0, start - 8192)
        let count = AVAudioFrameCount(start-seek+frames)
        guard let raw = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count),
              let edge = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(frames)),
              let src = raw.floatChannelData, let dest = edge.floatChannelData else { throw ProbeError("No PCM edge buffer") }
        file.framePosition = seek
        try file.read(into: raw, frameCount: count)
        guard raw.frameLength == count else { throw ProbeError("Truncated splice") }
        edge.frameLength = AVAudioFrameCount(frames)
        for ch in 0..<Int(file.processingFormat.channelCount) {
            dest[ch].update(from: src[ch].advanced(by: Int(start-seek)), count: Int(frames))
        }
        return edge
    }
    let a = try read(left.file, at: left.end-frames)
    let b = try read(right.file, at: right.start)
    for i in 0..<Int(frames) {
        let gain = Float(i)/Float(frames-1)
        for ch in 0..<Int(a.format.channelCount) {
            let outgoing = a.floatChannelData![ch]
            outgoing[i] = (1-gain)*outgoing[i] + gain*b.floatChannelData![ch][i]
        }
    }
    node.scheduleBuffer(a, at: nil, options: [], completionCallbackType: .dataPlayedBack, completionHandler: completion)
}
