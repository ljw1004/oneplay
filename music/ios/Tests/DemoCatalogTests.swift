import XCTest
@testable import OnePlayMusic

final class DemoCatalogTests: XCTestCase {
    private let commit = String(repeating: "a", count: 40)
    private let blob = String(repeating: "b", count: 40)

    private func catalog(_ paths: [String]) throws -> DemoMusicCatalog {
        try DemoMusicCatalog(JSONSerialization.data(withJSONObject: ["schemaVersion": 1,
            "mediaCommit": commit, "tracks": paths.map { ["path": $0, "bytes": 1234, "blob": blob] }]))
    }

    func testGitPathAndVersionMatchBrowserIdentity() throws {
        let snapshot = try catalog(["Été/100% #?'/Élan: live (take 1).mp3"])
        let encoded = "%C3%89t%C3%A9/100%25%20%23%3F%27/%C3%89lan%3A%20live%20%28take%201%29.mp3"
        let recording = try XCTUnwrap(snapshot.recordings[blob + "-" + encoded])
        XCTAssertEqual(recording.size, 1234)
        XCTAssertEqual(recording.blob, blob)
        XCTAssertEqual(recording.url.absoluteString,
            "https://raw.githubusercontent.com/ljw1004/oneplay-test/" + commit + "/Music/" + encoded)
    }

    func testPathDelimitersAndSuffixUseUTF8Bytes() throws {
        let snapshot = try catalog(["A/\u{0301}Tune.mp3", "a\u{0600}.mp3"])
        XCTAssertNotNil(snapshot.recordings[blob + "-A/%CC%81Tune.mp3"])
        XCTAssertNotNil(snapshot.recordings[blob + "-a%D8%80.mp3"])
    }

    func testRejectsNonUTF8Catalog() throws {
        let original = try catalog(["song.mp3"]).data
        let wide = try XCTUnwrap(String(decoding: original, as: UTF8.self).data(using: .utf16LittleEndian))
        XCTAssertThrowsError(try DemoMusicCatalog(wide))
    }

    func testRejectsInvalidAndAmbiguousPaths() throws {
        for paths in [["a/../x.mp3"], ["x.mp3", "x.mp3/song.mp3"], ["É/x.mp3", "E\u{0301}/y.mp3"], ["x.mp3", "x.mp3"]] {
            XCTAssertThrowsError(try catalog(paths))
        }
    }
}
