import AVFoundation

/// Isolate the trim predicate using stereo PCM with exact event coordinates.
@main struct CheckEdges {
    static func main() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
        let count = 20000
        func check(left: [Int], right: [Int], expected: Range<Int64>) throws {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: UInt32(count))!
            buffer.frameLength = UInt32(count)
            for (channel, events) in [left,right].enumerated() {
                let samples = buffer.floatChannelData![channel]
                samples.update(repeating: 0.00008, count: count)
                for frame in events { samples[frame] = -0.0002 }
            }
            do {
                let out = try AVAudioFile(forWriting: url, settings: format.settings.merging([AVLinearPCMIsNonInterleaved: false]) { _, new in new })
                try out.write(from: buffer)
            }
            let file = try AVAudioFile(forReading: url)
            let full = Int64(0)..<Int64(count)
            for (delay,pad) in [(nil, nil), (576, nil), (nil, 756), (0, 0)] as [(Int?, Int?)] {
                let fixture = Fixture(frames: Int64(count), delay: delay, padding: pad)
                let bounds = try decodedBounds(file, fixture: fixture, mp3: true)
                precondition(bounds == (delay == nil && pad == nil ? expected : full))
                let wav = try decodedBounds(file, fixture: fixture, mp3: false)
                precondition(wav == full)
            }
        }
        try check(left: [], right: [], expected: 1543..<13385)
        try check(left: [300,18000], right: [100,19900], expected: 100..<19901)
        try check(left: [100,19900], right: [300,18000], expected: 100..<19901)
        try check(left: [], right: [0,19999], expected: 0..<20000)
        // Render the actual scheduled stereo splice in isolation, with opposite DC levels
        // in each channel. Check every sample, including both endpoints of the ramp.
        let testBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 400)!
        testBuffer.frameLength = 400
        for ch in 0..<2 {
            let channel = testBuffer.floatChannelData![ch]
            channel.update(repeating: ch == 0 ? 0.5 : -0.25, count: 200)
            channel.advanced(by: 200).update(repeating: ch == 0 ? -0.5 : 0.75, count: 200)
        }
        do {
            let out = try AVAudioFile(forWriting: url, settings: format.settings.merging([AVLinearPCMIsNonInterleaved: false]) { _, new in new })
            try out.write(from: testBuffer)
        }
        let file = try AVAudioFile(forReading: url)
        let left = Slice(file: file, start: 0, end: 200, trimmedHead: false, trimmedTail: false)
        let right = Slice(file: file, start: 200, end: 400, trimmedHead: true, trimmedTail: false)
        precondition(left.overlapFrames(with: left) == 0 && left.overlapFrames(with: right) == 88)
        let engine = AVAudioEngine(), node = AVAudioPlayerNode()
        engine.attach(node)
        try engine.connectNode(node, to: engine.mainMixerNode, format: format)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 88)
        try scheduleSplice(on: node, from: left, to: right, frames: 88)
        try engine.start()
        try node.playAudio()
        let mix = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 88)!
        let status = try engine.renderOffline(88, to: mix)
        precondition(status == .success && mix.frameLength == 88)
        for i in 0..<88 {
            let gain = Float(i)/87
            precondition(abs(mix.floatChannelData![0][i] - (0.5-gain)) < 1e-5)
            precondition(abs(mix.floatChannelData![1][i] - (gain-0.25)) < 1e-5)
        }
        print("32 trim checks passed. All 88 splice frames matched both expected channel ramps.")
    }
}
