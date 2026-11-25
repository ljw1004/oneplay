import Foundation
import OSLog

/// Only fixed labels, classifications and numbers enter this queue. Each event survives
/// WebKit suspension or process death until sign-out or the 200-event cap is reached.
final class NativeDiagnostics: @unchecked Sendable {
    private struct Entry: Codable {
        let id: UUID
        let at: Double
        let message: String
    }

    private let file: URL
    private let lock = NSLock()
    private let system = Logger(subsystem: "me.unto.oneplay.music", category: "Diagnostics")
    @MainActor var onPending: (() -> Void)?

    init(file: URL) { self.file = file }

    /// Persist before signaling. A missing or suspended page can pull the same events later.
    func record(_ message: String) {
        system.notice("\(message, privacy: .public)")
        do {
            try lock.withLock {
                var entries = try read()
                entries.append(Entry(id: UUID(), at: Date().timeIntervalSince1970 * 1000, message: message))
                try save(Array(entries.suffix(200)))
            }
            Task { @MainActor in onPending?() }
        } catch { system.error("Could not persist native diagnostic event") }
    }

    /// A page keeps its cursor in memory. A fresh page or an evicted cursor replays the entire window.
    func entries(after cursor: UUID? = nil) throws -> [[String: Any]] {
        try lock.withLock {
            let entries = try read()
            let first = entries.lastIndex { $0.id == cursor }.map { $0 + 1 } ?? 0
            return entries[first...].map { ["id": $0.id.uuidString, "at": $0.at, "message": $0.message] }
        }
    }

    private func read() throws -> [Entry] {
        do { return try JSONDecoder().decode([Entry].self, from: Data(contentsOf: file)) }
        catch CocoaError.fileReadNoSuchFile { return [] }
    }

    private func save(_ entries: [Entry]) throws {
        try JSONEncoder().encode(entries).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Account cleanup drains writers before removing their pending events.
    func clear() throws {
        try lock.withLock {
            do { try FileManager.default.removeItem(at: file) }
            catch CocoaError.fileNoSuchFile { }
        }
    }
}
