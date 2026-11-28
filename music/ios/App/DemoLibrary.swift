import Foundation

/// Both players derive media identity from the published path and Git blob version.
struct DemoMusicCatalog {
    static let source = "demo"
    static let index = URL(string: "https://ljw1004.github.io/oneplay-test/music/index.json")!
    private static let raw = "https://raw.githubusercontent.com/ljw1004/oneplay-test/"
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private struct Manifest: Decodable {
        struct Track: Decodable { let path: String; let bytes: Int64; let blob: String }
        let schemaVersion: Int
        let mediaCommit: String
        let tracks: [Track]
    }

    struct Recording { let url: URL; let blob: String; let size: Int64 }

    let data: Data
    let recordings: [String: Recording]
    let credits: URL

    init(_ data: Data) throws {
        // Foundation also autodetects UTF-16 JSON. The published document is UTF-8.
        guard !data.contains(0), String(data: data, encoding: .utf8) != nil else { throw NativeAccountError.invalidRequest }
        let manifest = try JSONDecoder().decode(Manifest.self, from: data)
        func validSHA(_ string: String) -> Bool {
            string.utf8.count == 40 && string.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        guard manifest.schemaVersion == 1, validSHA(manifest.mediaCommit), !manifest.tracks.isEmpty else {
            throw NativeAccountError.invalidRequest
        }
        let base = Self.raw + manifest.mediaCommit + "/"
        var recordings = [String: Recording]()
        var files = Set<String>(), folders = Set<String>()
        var spellings = [String:String]()
        for item in manifest.tracks {
            guard item.bytes > 0 && item.bytes <= 9_007_199_254_740_991, validSHA(item.blob),
                  item.path.lowercased().utf8.suffix(4).elementsEqual(".mp3".utf8),
                  !item.path.utf8.contains(where: { $0 < 32 || $0 == 127 || $0 == 92 }) else {
                throw NativeAccountError.invalidRequest
            }
            // A combining mark can share the slash's Swift grapheme. Git and JS split on the delimiter byte.
            let parts = item.path.utf8.split(separator: 0x2f, omittingEmptySubsequences: false)
                .map { String(decoding: $0, as: UTF8.self) }
            var escaped = "", original = ""
            for (index, part) in parts.enumerated() {
                guard !part.isEmpty, part != ".", part != "..",
                      let encoded = part.addingPercentEncoding(withAllowedCharacters: Self.unreserved) else {
                    throw NativeAccountError.invalidRequest
                }
                escaped += (index == 0 ? "" : "/") + encoded
                original += "/" + part
                if let previous = spellings[original], previous != escaped { throw NativeAccountError.invalidRequest }
                spellings[original] = escaped
                if index < parts.count - 1 {
                    guard !files.contains(escaped) else { throw NativeAccountError.invalidRequest }
                    folders.insert(escaped)
                }
            }
            guard !folders.contains(escaped), files.insert(escaped).inserted,
                  let url = URL(string: base + "Music/" + escaped) else { throw NativeAccountError.invalidRequest }
            recordings[item.blob + "-" + escaped] = Recording(url: url, blob: item.blob, size: item.bytes)
        }
        self.data = data
        self.recordings = recordings
        self.credits = URL(string: base + "credits.txt")!
    }
}

/// A refresh is owned by the workspace. A new WebKit document can join the same request.
@MainActor final class DemoLibrary {
    private let root: URL
    private let session: URLSession
    private var storage: PlaybackStore?
    private var request: (id: UUID, task: Task<DemoMusicCatalog, Error>)?
    private(set) var catalog: DemoMusicCatalog?

    init(root: URL = URL.applicationSupportDirectory.appendingPathComponent("DemoPlayback", isDirectory: true),
         configuration: URLSessionConfiguration = .ephemeral) {
        self.root = root
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }

    /// The catalog and audio live outside the entire personal Playback cleanup root.
    func openStore() throws -> PlaybackStore {
        if let storage { return storage }
        let opened = try PlaybackStore(root: root, home: DemoMusicCatalog.source, drive: DemoMusicCatalog.source)
        storage = opened
        return opened
    }

    func loadCatalog() throws -> DemoMusicCatalog? {
        if let catalog { return catalog }
        let file = try openStore().directory.appendingPathComponent("catalog.json")
        do { catalog = try DemoMusicCatalog(Data(contentsOf: file)) }
        catch CocoaError.fileReadNoSuchFile { return nil }
        return catalog
    }

    func cancelRefresh() {
        request?.task.cancel()
        request = nil
    }

    func refresh() async throws -> DemoMusicCatalog {
        if let request { return try await request.task.value }
        let id = UUID()
        let task = Task<DemoMusicCatalog, Error> {
            let target = DemoMusicCatalog.index
            let request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
            let (bytes, response) = try await session.data(for: request)
            try Task.checkCancellation()
            guard self.request?.id == id, let http = response as? HTTPURLResponse, http.url == target, http.statusCode == 200 else {
                throw NativeAccountError.transient
            }
            if let catalog, catalog.data == bytes { return catalog }
            let next = try DemoMusicCatalog(bytes)
            let path = try openStore().directory.appendingPathComponent("catalog.json")
            try bytes.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            catalog = next
            return next
        }
        request = (id, task)
        defer { if request?.id == id { request = nil } }
        return try await task.value
    }
}
