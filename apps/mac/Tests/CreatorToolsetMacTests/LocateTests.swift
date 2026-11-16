import Foundation
import XCTest
@testable import CreatorToolsetMac

final class LocateTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let made = base.appendingPathComponent("locate-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        root = made.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ relative: String, _ bytes: Int, _ fill: UInt8 = 1) throws -> String {
        let file = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: fill, count: bytes).write(to: file)
        return file.path
    }

    func testAskParsed() {
        XCTAssertEqual(importAsk(#"import:locate:{"folder":"/Volumes/New","files":[{"id":"v1","path":"/Volumes/Old/a.mov","bytes":12}]}"#),
                       .locate(folder: "/Volumes/New", files: [LocateFile(id: "v1", path: "/Volumes/Old/a.mov", bytes: 12)]))
        XCTAssertEqual(importAsk(#"import:locate:{"files":[]}"#), .locate(folder: nil, files: []))
        XCTAssertNil(importAsk(#"import:locate:{"files":[{"id":"v1"}]}"#))
    }

    func testGoneFilesAndTheFolderFilesOfTheirSizes() throws {
        let kept = try write("Footage/kept.mov", 10)
        let moved = try write("New/sub/a renamed.mov", 12, 2)
        _ = try write("New/other.mov", 13)
        _ = try write("New/notes.txt", 12)
        let files = [
            LocateFile(id: "kept", path: kept, bytes: 10),
            LocateFile(id: "moved", path: root.appendingPathComponent("Old/a.mov").path, bytes: 12),
        ]
        var granted: [String] = []
        let folder = root.appendingPathComponent("New").path
        let r = Locate.answer(folder: folder, files: files, allowed: [folder]) { granted.append($0) }
        XCTAssertEqual(r["gone"] as? [String], ["moved"])
        let found = r["files"] as? [[String: Any]] ?? []
        XCTAssertEqual(found.map { $0["path"] as? String }, [moved])
        XCTAssertEqual(found.first?["quick"] as? String, Imports.quickPrint(moved))
        XCTAssertEqual(granted, [folder])

        // without a folder, only which are gone
        let only = Locate.answer(folder: nil, files: files, allowed: []) { _ in XCTFail("nothing to grant") }
        XCTAssertEqual(only["gone"] as? [String], ["moved"])
        XCTAssertEqual((only["files"] as? [Any])?.count, 0)
    }

    func testRefusesAFolderNotChosen() throws {
        let r = Locate.answer(folder: root.path, files: [LocateFile(id: "v", path: "/nowhere.mov", bytes: 1)], allowed: ["/Volumes/Elsewhere"]) { _ in XCTFail("not granted") }
        XCTAssertNotNil(r["error"])
    }
}
