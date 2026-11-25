#if CELLULAR_PROBE
import Foundation

/// The probe owns both fixture capabilities. Shipping receives fresh locations from Graph.
struct RemoteMP3: Decodable {
    let name, etag: String
    let bytes: Int64
    let initial, renewed: URL
}

final class MeteredSource: @unchecked Sendable {
    let media: RemoteMP3
    private let ranges: MediaRanges
    var specBytes: Int64 { ranges.specBytes }
    var onFirstBlockData: (() -> Void)? {
        get { ranges.onFirstBlockData }
        set { ranges.onFirstBlockData = newValue }
    }

    init(_ media: RemoteMP3, number: Int, speculative: Bool, trace: @escaping (String) -> Void) throws {
        self.media = media
        ranges = try MediaRanges(MediaLocation(url: media.initial, etag: media.etag, size: media.bytes),
                                 speculative: speculative, trace: { trace("range item=\(number) " + $0) })
    }

    func cancel() { ranges.cancel() }
    func promote() { ranges.promote() }
    func finishRenewal() throws {
        try ranges.installRenewal(MediaLocation(url: media.renewed, etag: media.etag, size: media.bytes))
    }
    func read(_ offset: Int64, _ count: Int) throws -> Data { try ranges.read(offset, count) }
}
#endif
