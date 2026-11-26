import CryptoKit
import Foundation
import os

/// Each account pairing has its own protected directory. Bridge-provided identifiers never become path components.
struct PlaybackStore {
    let directory: URL
    // The account binds its downloader and player to the same store. Only completed
    // files enter this inventory. Queue titles can be stale after an indexed rename.
    let localSuffixes = OSAllocatedUnfairLock(initialState: [String:String]())

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
    /// The index recognizes the final dotted suffix, including a filename consisting only of ".mp3".
    static func recordingSuffix(_ name: String) -> String {
        let filename = (name as NSString).lastPathComponent
        return filename.lastIndex(of: ".").map { filename[filename.index(after: $0)...].lowercased() } ?? ""
    }
    func pinURL(_ key: String, suffix: String = "") -> URL {
        let base = pinDirectory.appendingPathComponent(Self.pinName(key))
        return suffix.isEmpty ? base : base.appendingPathExtension(suffix)
    }

    /// Pin paths name regular files. Unlink leaves an open decoder descriptor readable.
    func unlinkPin(_ key: String, suffix: String) throws {
        guard unlink(pinURL(key, suffix: suffix).path) == 0 || errno == ENOENT else {
            throw POSIXError(POSIXErrorCode(rawValue:errno) ?? .EIO)
        }
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
