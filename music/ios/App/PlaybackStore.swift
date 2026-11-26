import CryptoKit
import Foundation

/// Each account pairing has its own protected directory. Bridge-provided identifiers never become path components.
struct PlaybackStore {
    let directory: URL

    init(root: URL, home: String, drive: String) throws {
        directory = root.appendingPathComponent("v1", isDirectory: true).appendingPathComponent(Self.digest(try JSONEncoder().encode([home, drive])), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    var pinDirectory: URL { directory.appendingPathComponent("Audio", isDirectory: true) }
    static func pinName(_ key: String) -> String { Data(SHA256.hash(data: Data(key.utf8))).base64EncodedString().replacingOccurrences(of: "/", with: "_") }
    func pinURL(_ key: String) -> URL { pinDirectory.appendingPathComponent(Self.pinName(key)) }

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

/// The expected Graph length and version move atomically with the recording's inode.
struct PinReceipt: Codable {
    let size: Int
    let version: String
    private static let attribute = "me.unto.oneplay.pin"
    func write(to url: URL) throws {
        let data = try JSONEncoder().encode(self)
        guard data.withUnsafeBytes({ setxattr(url.path, Self.attribute, $0.baseAddress, $0.count, 0, 0) }) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
    static func read(from url: URL) throws -> Self? {
        let length = getxattr(url.path, attribute, nil, 0, 0, 0)
        if length < 0 && errno == ENOATTR { return nil }
        guard length >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var bytes = Data(count: length)
        guard bytes.withUnsafeMutableBytes({ getxattr(url.path, attribute, $0.baseAddress, $0.count, 0, 0) }) == length else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        return try? JSONDecoder().decode(Self.self, from: bytes)
    }
}
