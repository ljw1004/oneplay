import AudioToolbox
import ImageIO
import MediaPlayer

enum NowPlayingArtwork {
    /// Reads a prefix from the admitted local file or compressed-byte pool. Cannot start a transfer.
    typealias ReadPrefix = (Int) -> Data?

    static let icon = UIImage(named: "NowPlayingIcon").map(makeArtwork)

    /// Core Audio interprets the ID3 version, encodings and picture frames. A bad or
    /// unusually large tag can only affect the cover, never the audio decoder.
    static func embedded(readPrefix: ReadPrefix) -> MPMediaItemArtwork? {
        guard let header = readPrefix(10), header.count == 10, header.starts(with: "ID3".utf8) else { return nil }
        var count: UInt32 = 0
        var length = UInt32(MemoryLayout.size(ofValue: count))
        let status = header.withUnsafeBytes {
            AudioFormatGetProperty(kAudioFormatProperty_ID3TagSize, 10, $0.baseAddress!, &length, &count)
        }
        guard status == noErr, (10...8*1024*1024).contains(Int(count)),
              let tag = readPrefix(Int(count)), tag.count == Int(count) else { return nil }
        var frames: Unmanaged<CFDictionary>?
        length = UInt32(MemoryLayout.size(ofValue: frames))
        let parsed = tag.withUnsafeBytes {
            AudioFormatGetProperty(kAudioFormatProperty_ID3TagToDictionary, count, $0.baseAddress!, &length, &frames)
        }
        guard parsed == noErr, let dictionary = frames?.takeRetainedValue() as NSDictionary?,
              let pictures = (dictionary["APIC"] ?? dictionary["PIC"]) as? [String: [String: Any]] else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                       kCGImageSourceCreateThumbnailWithTransform: true,
                                       kCGImageSourceThumbnailMaxPixelSize: 1024,
                                       kCGImageSourceShouldCacheImmediately: true]
        let ordered = pictures.values.sorted { first, second in
            first["picturetype"] as? String == "Cover (front)" && second["picturetype"] as? String != "Cover (front)"
        }
        for picture in ordered {
            guard let data = picture["data"] as? Data,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { continue }
            return makeArtwork(UIImage(cgImage: thumbnail))
        }
        return nil
    }

    /// MediaPlayer requests different sizes for a compact tile and an expanded cover.
    private static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { size in
            guard size.width > 0, size.height > 0, size != image.size else { return image }
            let scale = min(size.width / image.size.width, size.height / image.size.height)
            let width = image.size.width * scale, height = image.size.height * scale
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { _ in
                image.draw(in: CGRect(x: (size.width-width)/2, y: (size.height-height)/2, width: width, height: height))
            }
        }
    }
}
