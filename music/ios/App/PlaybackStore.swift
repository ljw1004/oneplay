import CryptoKit
import Foundation

/// Each account pairing has its own protected directory. Bridge-provided identifiers never become path components.
struct PlaybackStore {
    let directory: URL

    init(root: URL, home: String, drive: String) throws {
        directory = root.appendingPathComponent("v1").appendingPathComponent(Self.digest(try JSONEncoder().encode([home, drive])))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func bookmarkFile(_ favorite: String) -> String { "favorite-" + Self.digest(Data(favorite.utf8)) }

    func read<T: Decodable>(_ type: T.Type, _ name: String) throws -> T? {
        do { return try JSONDecoder().decode(type, from: Data(contentsOf: directory.appendingPathComponent(name))) }
        catch CocoaError.fileReadNoSuchFile { return nil }
    }

    func save<T: Encodable>(_ value: T, _ name: String) throws {
        try JSONEncoder().encode(value).write(to: directory.appendingPathComponent(name),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

struct FavoriteSpot: Codable {
    let folder: [String]
    let folderKey: String
    let path: [String]
    let key: String
    let seconds: Double
}
