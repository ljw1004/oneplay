import AVFoundation
import AudioToolbox

/// The player can skip an unreadable recording. Transport and output errors keep their own policy.
struct UnreadableRecording: Error {}

/// Core Audio makes synchronous compressed-byte reads. The successor worker hands this decoder to
/// playback only after its last prefix read. Exactly one worker owns the cursor at any time.
final class MP3RangeDecoder {
    typealias Read = (Int64, Int) throws -> Data
    private final class Source {
        let length: Int64
        let read: Read
        var error: Error?
        init(_ length: Int64, _ read: @escaping Read) { self.length = length; self.read = read }
    }
    private let source: Source
    private var audio: AudioFileID?
    private var decoder: ExtAudioFileRef?
    private var nativeRate: Double = 44100
    private var nextFrame: Int64 = 0
    struct Length: Codable, Equatable {
        let frames: Int64
        let estimated: Bool
        static let unknown = Length(frames: 0, estimated: true)
    }
    private(set) var length = Length.unknown
    private var pendingTail: AVAudioPCMBuffer?
    let format: AVAudioFormat
    var frames: Int64 { length.frames }
    private(set) var hasDeclaredTiming = false

    init(bytes: Int64, knownLength: Length = .unknown, typeHint: AudioFileTypeID = kAudioFileMP3Type, read: @escaping Read) throws {
        source = Source(bytes, read)
        guard let stereo = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2) else {
            throw PlaybackError("CD audio format unavailable")
        }
        format = stereo
        try check(AudioFileOpenWithCallbacks(Unmanaged.passUnretained(source).toOpaque(), { ctx, offset, requested, dest, actual in
            let source = Unmanaged<Source>.fromOpaque(ctx).takeUnretainedValue()
            do {
                let n = min(Int64(requested), max(0, source.length - offset))
                let data = try n > 0 ? source.read(offset, Int(n)) : Data()
                guard data.count == n else { throw PlaybackError("Short range") }
                data.copyBytes(to: dest.assumingMemoryBound(to: UInt8.self), count: data.count)
                actual.pointee = UInt32(data.count)
                return noErr
            } catch {
                source.error = error
                actual.pointee = 0
                return kAudioFileUnspecifiedError
            }
        }, nil, { ctx in Unmanaged<Source>.fromOpaque(ctx).takeUnretainedValue().length }, nil,
        typeHint, &audio))
        var timing = AudioFilePacketTableInfo()
        var timingBytes = UInt32(MemoryLayout.size(ofValue: timing))
        if AudioFileGetProperty(audio!, kAudioFilePropertyPacketTableInfo, &timingBytes, &timing) == noErr {
            // ExtAudioFile already excludes declared priming and remainder from the decoded timeline.
            hasDeclaredTiming = timing.mPrimingFrames > 0 || timing.mRemainderFrames > 0
        }
        try check(ExtAudioFileWrapAudioFileID(audio!, false, &decoder))
        var native = AudioStreamBasicDescription()
        var formatBytes = UInt32(MemoryLayout.size(ofValue: native))
        try check(ExtAudioFileGetProperty(decoder!, kExtAudioFileProperty_FileDataFormat, &formatBytes, &native))
        guard native.mSampleRate > 0, (1...2).contains(native.mChannelsPerFrame) else {
            throw UnreadableRecording()
        }
        nativeRate = native.mSampleRate
        // Asking ExtAudioFile for an exact length indexes every packet of an unindexed MP3.
        // Its packet table, when present, already gives the playable length excluding encoder padding.
        if !knownLength.estimated {
            length = knownLength
        } else if timing.mNumberValidFrames > 0, let valid = Int64(exactly: (Double(timing.mNumberValidFrames) * stereo.sampleRate / nativeRate).rounded()) {
            length = Length(frames: valid, estimated: false)
        } else {
            length = Length(frames: estimatedFrames(), estimated: true)
        }
        try check(ExtAudioFileSetProperty(decoder!, kExtAudioFileProperty_ClientDataFormat,
                                         UInt32(MemoryLayout<AudioStreamBasicDescription>.size), stereo.streamDescription))
    }

    /// Core Audio refines this estimate as it sees ordinary playback packets.
    private func estimatedFrames() -> Int64 {
        var seconds: Double = 0
        var length = UInt32(MemoryLayout.size(ofValue: seconds))
        guard AudioFileGetProperty(audio!, kAudioFilePropertyEstimatedDuration, &length, &seconds) == noErr else { return 0 }
        return max(0, Int64(exactly: (seconds * format.sampleRate).rounded()) ?? 0)
    }

    #if DEBUG
    /// The explicit near-end audition needs a precise capture position even on unindexed recordings.
    func exactFramesForAudition() throws -> Int64 {
        var nativeFrames: Int64 = 0
        var length = UInt32(MemoryLayout.size(ofValue: nativeFrames))
        try check(ExtAudioFileGetProperty(decoder!, kExtAudioFileProperty_FileLengthFrames, &length, &nativeFrames))
        guard let count = Int64(exactly: (Double(nativeFrames) * format.sampleRate / nativeRate).rounded()) else {
            throw PlaybackError("Invalid MP3 duration")
        }
        return count
    }
    #endif

    /// Ask Apple's MP3 stream parser for a time-to-byte hint using only retained header bytes.
    /// This influences HTTP range sizing. ExtAudioFileSeek still positions the actual decoder.
    static func seekByte(seconds: Double, duration: Double, size: Int64, header: Data?) -> (offset: Int64, exact: Bool) {
        let fallback = Int64(exactly: (Double(size) * min(1, seconds / duration)).rounded(.down)) ?? size
        var parser: AudioFileStreamID?
        guard let header, !header.isEmpty,
              AudioFileStreamOpen(nil, { _,_,_,_ in }, { _,_,_,_,_ in }, kAudioFileMP3Type, &parser) == noErr,
              let parser else { return (fallback, false) }
        defer { AudioFileStreamClose(parser) }
        let status = header.withUnsafeBytes { AudioFileStreamParseBytes(parser, UInt32($0.count), $0.baseAddress!, []) }
        var format = AudioStreamBasicDescription()
        var length = UInt32(MemoryLayout.size(ofValue: format))
        guard status == noErr, AudioFileStreamGetProperty(parser, kAudioFileStreamProperty_DataFormat, &length, &format) == noErr,
              format.mFramesPerPacket > 0, let packet = Int64(exactly: (seconds * format.mSampleRate / Double(format.mFramesPerPacket)).rounded(.down))
        else { return (fallback, false) }
        var start: Int64 = 0, offset: Int64 = 0
        var flags = AudioFileStreamSeekFlags()
        length = UInt32(MemoryLayout.size(ofValue: start))
        guard AudioFileStreamGetProperty(parser, kAudioFileStreamProperty_DataOffset, &length, &start) == noErr,
              AudioFileStreamSeek(parser, packet, &offset, &flags) == noErr,
              start >= 0, start < size, offset >= 0, offset < size - start else { return (fallback, false) }
        return (start + offset, flags.isEmpty)
    }

    deinit {
        if let decoder { ExtAudioFileDispose(decoder) }
        if let audio { AudioFileClose(audio) }
    }

    private func check(_ status: OSStatus) throws {
        if let error = source.error { throw error }
        if status != noErr { throw UnreadableRecording() }
    }

    /// Cache misses resolve on the worker. The render thread only sees ready PCM.
    func decode(_ count: Int, at position: Int64? = nil) throws -> AVAudioPCMBuffer {
        if let position {
            guard let frame = Int64(exactly: (Double(position) * nativeRate / format.sampleRate).rounded()) else {
                throw PlaybackError("Invalid seek position")
            }
            try check(ExtAudioFileSeek(decoder!, frame))
        }
        var n = UInt32(count)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { throw PlaybackError("PCM allocation failed") }
        pcm.frameLength = n
        try check(ExtAudioFileRead(decoder!, &n, pcm.mutableAudioBufferList))
        pcm.frameLength = n
        nextFrame = (position ?? nextFrame) + Int64(n)
        if length.estimated {
            // Only samples actually decoded establish EOF. A seek past EOF can return zero immediately.
            if n == 0 && position != nil { length = Length(frames: estimatedFrames(), estimated: true) }
            else if n < count { length = Length(frames: nextFrame, estimated: false) }
            else { length = Length(frames: max(nextFrame, estimatedFrames()), estimated: true) }
        }
        return pcm
    }

    /// Keep enough unscheduled PCM for the 150 ms trailing trim and the 88-frame overlap.
    /// Even if EOF falls exactly on a read boundary, the final buffer contains the real tail.
    func decodePlaybackChunk(_ count: Int, at position: Int64?) throws -> (AVAudioPCMBuffer, final: Bool) {
        let hold = 6615 + 88
        let previous = position == nil ? pendingTail : nil
        let requested = previous == nil ? count + hold : count
        let fresh = try decode(requested, at: position)
        let n = Int(fresh.frameLength)
        let final = n < requested
        pendingTail = final ? nil : fresh
        if final && previous == nil { return (fresh, true) }
        let head = previous == nil ? 0 : hold
        let body = final ? n : n - hold
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: UInt32(head + body)) else {
            throw PlaybackError("PCM allocation failed")
        }
        pcm.frameLength = pcm.frameCapacity
        for ch in 0..<Int(format.channelCount) {
            let out = pcm.floatChannelData![ch]
            if let previous {
                out.update(from: previous.floatChannelData![ch] + (Int(previous.frameLength) - hold), count: hold)
            }
            out.advanced(by: head).update(from: fresh.floatChannelData![ch], count: body)
        }
        return (pcm, final)
    }
}
