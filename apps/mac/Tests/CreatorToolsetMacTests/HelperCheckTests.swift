import XCTest
@testable import CreatorToolsetMac

final class HelperCheckTests: XCTestCase {
    func testReadsAFolderAndNamesAMissingOne() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helper-check-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Day 1"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // empty: listing it is the read
        XCTAssertNil(HelperCheckJob.read(dir.path))
        try Data(repeating: 1, count: 1000).write(to: dir.appendingPathComponent("Day 1/take.mov"))
        XCTAssertNil(HelperCheckJob.read(dir.path))
        let gone = HelperCheckJob.read(dir.appendingPathComponent("nope").path)
        XCTAssertTrue(gone?.contains("Connect the shared drive again") == true)
    }
}
