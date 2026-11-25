import AVFoundation
import AudioToolbox

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
    let format: AVAudioFormat
    private(set) var frames: Int64 = 0
    private(set) var hasDeclaredTiming = false

    init(bytes: Int64, read: @escaping Read) throws {
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
        kAudioFileMP3Type, &audio))
        var timing = AudioFilePacketTableInfo()
        var timingBytes = UInt32(MemoryLayout.size(ofValue: timing))
        if AudioFileGetProperty(audio!, kAudioFilePropertyPacketTableInfo, &timingBytes, &timing) == noErr {
            // ExtAudioFile already excludes declared priming and remainder from the decoded timeline.
            hasDeclaredTiming = timing.mPrimingFrames > 0 || timing.mRemainderFrames > 0
        }
        try check(ExtAudioFileWrapAudioFileID(audio!, false, &decoder))
        var native = AudioStreamBasicDescription()
        var length = UInt32(MemoryLayout.size(ofValue: native))
        try check(ExtAudioFileGetProperty(decoder!, kExtAudioFileProperty_FileDataFormat, &length, &native))
        guard native.mSampleRate > 0, (1...2).contains(native.mChannelsPerFrame) else {
            throw PlaybackError("Unsupported MP3 format")
        }
        nativeRate = native.mSampleRate
        length = UInt32(MemoryLayout<Int64>.size)
        try check(ExtAudioFileGetProperty(decoder!, kExtAudioFileProperty_FileLengthFrames, &length, &frames))
        frames = Int64((Double(frames) * stereo.sampleRate / nativeRate).rounded())
        try check(ExtAudioFileSetProperty(decoder!, kExtAudioFileProperty_ClientDataFormat,
                                         UInt32(MemoryLayout<AudioStreamBasicDescription>.size), stereo.streamDescription))
    }

    deinit {
        if let decoder { ExtAudioFileDispose(decoder) }
        if let audio { AudioFileClose(audio) }
    }

    private func check(_ status: OSStatus) throws {
        if let error = source.error { throw error }
        if status != noErr { throw PlaybackError("Core Audio status \(status)") }
    }

    /// Cache misses resolve on the worker. The render thread only sees ready PCM.
    func decode(_ count: Int, at position: Int64? = nil) throws -> AVAudioPCMBuffer {
        if let position { try check(ExtAudioFileSeek(decoder!, Int64((Double(position) * nativeRate / format.sampleRate).rounded()))) }
        var n = UInt32(count)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { throw PlaybackError("PCM allocation failed") }
        pcm.frameLength = n
        try check(ExtAudioFileRead(decoder!, &n, pcm.mutableAudioBufferList))
        pcm.frameLength = n
        return pcm
    }
}
