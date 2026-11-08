import Foundation
import XCTest
@testable import CreatorToolsetMac

final class ProjectTests: XCTestCase {
    // Scratch in CT_SCRATCH_DIR (an external disk) or the temporary folder; each test removes its own folder.
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        root = base.appendingPathComponent("rec-project-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testByteRange() {
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-99", size: 1000), 0...99)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=900-", size: 1000), 900...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-", size: 20_000_000), 0...(8 << 20 - 1))
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=-100", size: 1000), 900...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=-5000", size: 1000), 0...999)
        XCTAssertEqual(ProjectScheme.byteRange(header: "bytes=0-5000", size: 1000), 0...999)
        // malformed, unsatisfiable or multi-range headers are not answered
        XCTAssertNil(ProjectScheme.byteRange(header: nil, size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=1000-", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=5-2", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=0-1,5-6", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=-0", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=abc", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "items=0-1", size: 1000))
        XCTAssertNil(ProjectScheme.byteRange(header: "bytes=0-1", size: 0))
    }

    func testIDValidationAndPathRejection() throws {
        XCTAssertTrue(ProjectStore.isValidID("0123456789ab"))
        XCTAssertFalse(ProjectStore.isValidID("0123456789AB"))
        XCTAssertFalse(ProjectStore.isValidID("0123456789abc"))
        XCTAssertFalse(ProjectStore.isValidID("../../../etc"))
        XCTAssertNil(ProjectStore.project(id: "../../../etc", root: root))
        XCTAssertNil(ProjectStore.project(id: "0123456789ab", root: root))
        // only the listed file names are served
        XCTAssertNil(ProjectScheme.types["../project.json"])
        XCTAssertNil(ProjectScheme.types["screen.mov"])
    }

    func testCreateMarkReadyOpenRoundTrip() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        var project = try LocalProject.create(in: root, at: date)
        XCTAssertEqual(project.state, "recording")
        XCTAssertTrue(project.folder.lastPathComponent.range(of: #"^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.ctrec$"#,
                                                             options: .regularExpression) != nil)
        XCTAssertTrue(ProjectStore.isValidID(project.id))
        XCTAssertTrue(ProjectStore.list(root: root).isEmpty, "a recording still in progress is not listed")

        try project.markReady(durationMs: 12_000, width: 3024, height: 1964, tracks: ["mic", "system"], camera: false)
        let reopened = try LocalProject.open(folder: project.folder)
        XCTAssertEqual(reopened.id, project.id)
        XCTAssertEqual(reopened.state, "ready")
        XCTAssertEqual(reopened.durationMs, 12_000)
        XCTAssertEqual(reopened.tracks, ["mic", "system"])
        XCTAssertEqual(ProjectStore.project(id: project.id, root: root)?.folder, project.folder)
        XCTAssertEqual(ProjectStore.list(root: root).map(\.id), [project.id])
    }

    func testWriteLookRejectsInvalidJSONAndLargeFiles() throws {
        let project = try LocalProject.create(in: root, at: Date())
        XCTAssertThrowsError(try project.writeLook(Data("{nope".utf8)))
        XCTAssertThrowsError(try project.writeLook(Data(count: 256 * 1024 + 1)))
        try project.writeLook(Data(#"{"zoom":1.5}"#.utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.lookURL.path))
    }

    func testListNewestFirst() throws {
        var older = try LocalProject.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_000))
        var newer = try LocalProject.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_060))
        try older.markReady(durationMs: 1, width: 2, height: 2, tracks: [], camera: false)
        try newer.markReady(durationMs: 1, width: 2, height: 2, tracks: [], camera: false)
        XCTAssertEqual(ProjectStore.list(root: root).map(\.id), [newer.id, older.id])
    }
}
